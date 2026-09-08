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

chk('浏览器无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ; ') || '无');
await browser.close();
const fail = results.filter((r) => !r.cond).length;
console.log('\n═══ 浏览器验证汇总：PASS ' + (results.length - fail) + ' / FAIL ' + fail + ' ═══');
process.exit(fail ? 1 : 0);