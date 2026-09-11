/* 浏览器端冒烟验证（T4 / T12 / T13）——本地人工/回归用，不进 CI（需 Edge + playwright-core）

   前置：
     1) 项目根启动服务： python serve.py 8125
     2) 安装 playwright-core（无需下载浏览器）：
        npm install --prefix "%TEMP%\dsh-pw" playwright-core
     3) 运行：
        set PW_PATH=%TEMP%\dsh-pw\node_modules\playwright-core
        node tests/browser/smoke.mjs            （端口默认 8125，可用 DSH_PORT 覆盖）

   断言：
     T4  K线页标题陈旧角标：注入 manifest 的一条 stale → 角标文本含日期（验证后自动还原 manifest）
     T12 信号扫描/智能推荐/我的持仓：0 次 analysis_dy.json 请求 + 已读 analysis.json + 无错误框
     T13 对比页：请求 dy_series.json + 0 次 analysis_dy.json + 图表 ≥2 条系列
     T14 轮动回测页：三只K线直读 + 0 次 analysis_dy.json + 价格/净值图已渲染 + 改区间后重算
     全程无未捕获 JS 异常
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.DSH_PORT || '8125';
const BASE = 'http://127.0.0.1:' + PORT + '/web/';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MANIFEST = join(ROOT, 'web', 'data', 'manifest.json');
const PW = (process.env.PW_PATH || '').replace(/\\/g, '/');
if (!PW) { console.error('缺少 PW_PATH（playwright-core 目录）；见文件头注释'); process.exit(2); }
const { chromium } = await import('file:///' + PW + '/index.mjs');

const results = [];
const chk = (name, cond, detail) => { results.push({ name, cond: !!cond }); console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? ' | ' + detail : '')); };

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
const pageErrors = [];

async function newPage() {
  const p = await ctx.newPage();
  const reqs = [];
  p.on('request', (r) => reqs.push(r.url()));
  p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
  return { p, reqs };
}

console.log('═══ A. T4 陈旧角标（先注入一条 stale，验证后还原）═══');
const orig = readFileSync(MANIFEST);
const m = JSON.parse(orig.toString('utf8'));
const target = m.stocks[0];   // 列表首项：注入后无需切换即应可见角标
const backup = { stale: target.stale, ind_last: target.ind_last };
target.stale = true; target.ind_last = '2026-08-24';
writeFileSync(MANIFEST, JSON.stringify(m));
console.log('（演练：' + target.code + ' ' + target.name + ' 标记 stale/ind_last=2026-08-24）');
try {
  const { p } = await newPage();
  await p.goto(BASE + '#/stock', { waitUntil: 'load' });
  await p.waitForSelector('.ticker-item', { timeout: 30000 });
  await p.waitForSelector('.stale-badge', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1200);
  const n = await p.locator('.stale-badge').count();
  const txt = n ? (await p.locator('.stale-badge').first().innerText()).trim() : '';
  chk('T4 陈旧角标渲染', n >= 1 && /2026-08-24/.test(txt), 'badge=' + n + ' text=' + txt);
  const series = await p.evaluate(() => { const el = document.querySelector('.chart'); const i = window.echarts.getInstanceByDom(el); return i ? i.getOption().series.length : -1; });
  chk('T4 K线图已渲染（ECharts series）', series > 0, 'series=' + series);
  await p.close();
} finally {
  writeFileSync(MANIFEST, orig);
  console.log('（演练：manifest.json 已还原）');
}

console.log('\n═══ B. T12 三主视图不再请求 analysis_dy ═══');
for (const [hash, label] of [['#/scan', '信号扫描'], ['#/recommend', '智能推荐'], ['#/holdings', '我的持仓']]) {
  const { p, reqs } = await newPage();
  await p.goto(BASE + hash, { waitUntil: 'load' });
  await p.waitForTimeout(5000);
  const dy = reqs.filter((u) => u.includes('analysis_dy.json'));
  const an = reqs.filter((u) => u.includes('/analysis.json'));
  const errs = await p.locator('.error-box').count();
  const bodyLen = (await p.locator('body').innerText()).replace(/\s+/g, '').length;
  chk('T12 ' + label + '：无 analysis_dy.json 请求', dy.length === 0, dy.length + ' 次');
  chk('T12 ' + label + '：已改读 analysis.json', an.length > 0, an.length + ' 次');
  chk('T12 ' + label + '：渲染正常（无错误框）', errs === 0 && bodyLen > 300, 'err=' + errs + ' 文本=' + bodyLen);
  await p.close();
}

console.log('\n═══ C. T13 对比页改读 dy_series.json ═══');
{
  const { p, reqs } = await newPage();
  await p.goto(BASE + '#/compare', { waitUntil: 'load' });
  await p.waitForSelector('.ticker-item', { timeout: 30000 });
  await p.waitForTimeout(1000);
  for (const code of ['000922', '000015']) {
    await p.locator('.ticker-item', { hasText: code }).first().click();
    await p.waitForTimeout(300);
  }
  await p.locator('.cmp-go').click();
  await p.waitForSelector('.chart canvas', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const dy = reqs.filter((u) => u.includes('analysis_dy.json'));
  const ds = reqs.filter((u) => u.includes('dy_series.json'));
  chk('T13 对比页：请求 dy_series.json', ds.length > 0, ds.length + ' 次');
  chk('T13 对比页：无 analysis_dy.json 请求', dy.length === 0, dy.length + ' 次');
  const series = await p.evaluate(() => { const el = document.querySelector('.chart'); const i = window.echarts.getInstanceByDom(el); return i ? i.getOption().series.length : -1; });
  chk('T13 对比图已渲染（≥2 条系列）', series >= 2, 'series=' + series);
  await p.close();
}

console.log('\n═══ D. T14 轮动回测页（#/rotate）═══');
{
  const { p, reqs } = await newPage();
  await p.goto(BASE + '#/rotate', { waitUntil: 'load' });
  await p.waitForSelector('.rt-params', { timeout: 30000 });
  await p.waitForTimeout(2500);
  const dy = reqs.filter((u) => u.includes('analysis_dy.json'));
  const kl = reqs.filter((u) => /\/cache\/[^/]*(000933|000807|002128)\.json/.test(decodeURIComponent(u)));
  const errs = await p.locator('.error-box').count();
  chk('T14 轮动回测：三只K线直读 /cache/', new Set(kl).size >= 3, new Set(kl).size + ' 个');
  chk('T14 轮动回测：无 analysis_dy.json 请求', dy.length === 0, dy.length + ' 次');
  const charts = await p.evaluate(() => [...document.querySelectorAll('.chart')]
    .map((el) => { const i = window.echarts.getInstanceByDom(el); return i ? i.getOption().series.length : -1; }));
  chk('T14 轮动回测：价格图 + 净值图已渲染', charts[0] >= 5 && charts[1] >= 5, JSON.stringify(charts));
  const cards = (await p.locator('.stat-row').nth(1).innerText()).replace(/\s+/g, ' ');
  chk('T14 轮动回测：胜率卡与超额卡渲染正常', /换仓胜率/.test(cards) && /95%CI/.test(cards) && errs === 0, 'err=' + errs);
  const gridRows = await p.locator('.rt-grid-tbl tbody tr').count();
  chk('T14 轮动回测：Δ 网格表已出数', gridRows >= 5, gridRows + ' 行');
  const concTxt = (await p.locator('.rt-conc').innerText()).replace(/\s+/g, ' ');
  chk('T14 轮动回测：选择结论卡（推荐Δ/出现次数/胜率/平衡胜率/真实边际）',
    /推荐换仓差价/.test(concTxt) && /出现次数/.test(concTxt) && /换仓胜率/.test(concTxt) && /盈亏平衡胜率/.test(concTxt) && /真实边际/.test(concTxt),
    concTxt.slice(0, 70));
  const starRows = await p.locator('.rt-rec-tag').count();
  chk('T14 轮动回测：网格表标出推荐档 ★', starRows >= 1, starRows + ' 行');
  /* 改区间（近1年）→ 重算 */
  const before = (await p.locator('.stat-row').nth(1).innerText()).replace(/\s+/g, ' ');
  await p.locator('.seg-group .seg-btn', { hasText: '近1年' }).first().click();
  await p.waitForTimeout(1500);
  const after = (await p.locator('.stat-row').nth(1).innerText()).replace(/\s+/g, ' ');
  chk('T14 轮动回测：改区间后重算（数值变化）', before !== after, '');
  await p.close();
}

console.log('\n═══ E. 顶栏布局（11 视图两行导航）═══');
{
  const { p } = await newPage();
  for (const w of [1680, 1280, 980, 820]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.goto(BASE + '#/index', { waitUntil: 'load' });
    await p.waitForSelector('.nav-tab', { timeout: 30000 });
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => {
      const boxes = [...document.querySelectorAll('.nav-tab')].map((t) => { const b = t.getBoundingClientRect(); return { y: Math.round(b.y), bottom: Math.round(b.bottom) }; });
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      return {
        n: boxes.length,
        rows: [...new Set(boxes.map((b) => b.y))].length,
        barH: Math.round(bar.height),
        clipped: boxes.some((b) => b.bottom > Math.round(bar.bottom) + 1),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    chk(`布局 ${w}px：11 个 tab 两行且不撑高顶栏`,
      r.n === 11 && r.rows === 2 && r.barH === 58 && !r.clipped && !r.pageOverflow,
      `tab=${r.n} 行=${r.rows} 顶栏=${r.barH}px 裁切=${r.clipped} 溢出=${r.pageOverflow}`);
  }
  await p.close();
}

chk('浏览器无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ; ') || '无');
await browser.close();
const fail = results.filter((r) => !r.cond).length;
console.log('\n═══ 浏览器验证汇总：PASS ' + (results.length - fail) + ' / FAIL ' + fail + ' ═══');
process.exit(fail ? 1 : 0);