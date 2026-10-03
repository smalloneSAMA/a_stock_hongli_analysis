/* 轮动回测引擎单测（#/rotate）：rotation.js 纯函数
   运行：node --test --test-isolation=none "tests/frontend/*.test.mjs"
   约定（与项目测试一致）：关系/边界断言，禁止精确数值快照——行情或参数微调不应误报。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix, simulate, statsOf, sweep, wilson, benchmarks, shiftYears, matrixBounds, defaultGrid, gapAt, gapDayShare, conclusion, pairError, gapArray, spreadStat, splitIndex, oosValidate, rankRows, EVID_MIN_CLOSED, EVID_FAIR, EXCESS_TIE_PP } from '../../web/js/views/rotation.js';

/* 合成行情：series = { 代码: [[日期, 收盘], ...] }；divs = { 代码: [[除权日, 每10股派息], ...] } */
const DS = (n, day = 1) => Array.from({ length: n }, (_, i) => `2024-01-${String(day + i).padStart(2, '0')}`);
/* 长周期日期序列（跨年，用于"近1年"口径与多次换仓的 fixture） */
const DL = (n, offset = 0) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1) + (i + offset) * 86400000).toISOString().slice(0, 10));
function mk(series, opts = {}) {
  const codes = Object.keys(series);
  const raw = {}, divRows = {};
  for (const c of codes) {
    raw[c] = series[c].map(([date, close]) => ({ date, close }));
    divRows[c] = ((opts.divs || {})[c] || []).map(([ex_date, bonus10]) => ({ ex_date, bonus10 }));
  }
  return buildMatrix({ codes, names: opts.names || codes, raw, divRows, start: opts.start || '', end: opts.end || '', signalMode: opts.signalMode || 'raw' });
}
const OPTS = { unit: '元', execOffset: 1, cost: 0.0005, includeDiv: true, startMode: 'holdFirst' };

/* F1：B 先跌到 9（缺口 1 < Δ），再跌到 8 触发一次换仓；C 拉到 13 制造最高价 */
const f1 = () => mk({
  A: DS(10).map((d) => [d, 10]),
  B: DS(10).map((d, i) => [d, i <= 1 ? 10 : i === 2 ? 9 : 8]),
  C: DS(10).map((d, i) => [d, i >= 2 ? 13 : 10]),
});

/* F2：B 在 8 / 12 / 7 之间摆动（A、C 恒 10）→ 多次来回切换，可统计胜率与换手 */
const f2 = () => mk({
  A: DS(10).map((d) => [d, 10]),
  B: DS(10).map((d, i) => [d, [10, 8, 8, 8, 12, 12, 12, 7, 7, 7][i]]),
  C: DS(10).map((d) => [d, 10]),
});

/* F3：两只配对（A/B），B 先低后高——最低价一侧交换两次 → Δ=0 时隔日各换一次 */
const fPair = () => mk({
  A: DS(8).map((d) => [d, 10]),
  B: DS(8).map((d, i) => [d, [9, 9, 9, 9, 11, 11, 11, 11][i]]),
});

test('触发条件：最高价 − 最低价 ≥ Δ 才换仓，未达标不动', () => {
  const m = f1();
  const r = simulate(m, { ...OPTS, threshold: 3 });
  assert.equal(r.trades.length, 2, '建仓 1 次 + 换仓 1 次');
  assert.equal(r.trades[0].kind, 'open');
  assert.equal(r.trades[1].kind, 'switch');
  const no = simulate(m, { ...OPTS, threshold: 6 });
  assert.equal(no.trades.length, 1, 'Δ=6 时最大缺口 5 不达标 → 只有建仓');
});

test('卖出的必是持仓，买入的必是当日最低价那只', () => {
  const m = f1();
  const r = simulate(m, { ...OPTS, threshold: 3 });
  const t = r.trades[1];
  assert.equal(t.from, 'A', '卖出的是当时持仓 A');
  assert.equal(t.to, 'B', '买入的是信号日最低价 B（9 < 10 < 13）');
  assert.equal(t.fromPx, 10);
  assert.equal(t.toPx, 8, 't+1 成交价取成交日 B 的价格（信号日 9 → 成交日 8）');
});

test('t+1 收盘执行：信号次一交易日的收盘价成交', () => {
  const m = f1();
  const r = simulate(m, { ...OPTS, threshold: 3 });
  const t = r.trades[1];
  assert.equal(m.dates.indexOf(t.sigDate) + 1, m.dates.indexOf(t.date), '成交日 = 信号日 + 1 个交易日');
  assert.equal(t.toPx, m.px[m.codes.indexOf('B')][m.dates.indexOf(t.date)], '成交价 = 成交日收盘价');
  const same = simulate(m, { ...OPTS, threshold: 3, execOffset: 0 }).trades[1];
  assert.equal(same.sigDate, same.date, 'execOffset=0 → 当日收盘成交');
  assert.equal(same.toPx, 9, '当日成交价取信号日价格 9');
});

test('胜率口径：换入标的跑赢被卖出标的 → 判赢（用户举例：云铝 25.5→34 vs 神火 28.9→31）', () => {
  const d = DS(7);
  const m = mk({
    A: [[d[0], 28.9], [d[1], 28.9], [d[2], 28.9], [d[3], 29.5], [d[4], 30.5], [d[5], 31], [d[6], 31]],
    B: [[d[0], 25.5], [d[1], 25.5], [d[2], 25.5], [d[3], 27], [d[4], 30], [d[5], 34], [d[6], 34]],
  });
  const r = simulate(m, { ...OPTS, threshold: 3 });
  const s = r.segments.find((x) => x.kind === 'switch');
  assert.equal(s.code, 'B', '28.9 卖出 A → 25.5 买入 B');
  assert.equal(s.altCode, 'A');
  assert.equal(s.entryPx, 25.5);
  assert.equal(s.exitPx, 34);
  /* 举例里的每股盈亏：换仓 34−25.5 = +8.5 元 > 不换仓 31−28.9 = +2.1 元 */
  assert.ok(34 - 25.5 > 31 - 28.9);
  assert.equal(s.win, true);
  assert.ok(s.retStay > 0.07 && s.retStay < 0.08, '不换仓收益 ≈ 神火 28.9→31');
  assert.ok(s.ret > s.retStay, '换仓收益更高');
  assert.ok(s.exc > 20, '超额 >20pp');
});

test('胜率 = 赢 ÷ 已了结换仓次数；末段未了结不计入分母', () => {
  const m = f2();
  const r = simulate(m, { ...OPTS, threshold: 2 });
  const st = statsOf(r);
  const closed = r.segments.filter((s) => s.kind === 'switch' && !s.open);
  assert.equal(st.nSwitch, r.trades.filter((t) => t.kind === 'switch').length);
  assert.equal(st.nClosed, closed.length);
  assert.equal(st.wins, closed.filter((s) => s.win).length);
  assert.equal(st.winRate, st.wins / st.nClosed);
  assert.ok(r.segments.some((s) => s.kind === 'switch' && s.open), '存在未了结末段');
  assert.equal(st.nIncl, st.nClosed + 1, '含未了结口径多一段');
  assert.equal(st.winRateIncl, st.winsIncl / st.nIncl);
});

test('含手续费不会提高胜率与收益（关系断言）', () => {
  const m = f2();
  const fee = statsOf(simulate(m, { ...OPTS, threshold: 2, cost: 0.0005 }));
  const free = statsOf(simulate(m, { ...OPTS, threshold: 2, cost: 0 }));
  assert.ok(fee.total <= free.total, `含费收益 ${fee.total} ≤ 不含费 ${free.total}`);
  assert.ok((fee.winRateIncl || 0) <= (free.winRateIncl || 0), '含费胜率 ≤ 不含费胜率');
});

test('停牌顺延：成交标的当日无行情 → 顺延到下一可交易日', () => {
  const d = DS(6);
  const m = mk({
    A: d.map((x) => [x, 10]),
    B: [[d[0], 10], [d[1], 8], [d[3], 8], [d[4], 8], [d[5], 9]],   // 缺 d[2]
  });
  assert.equal(m.has[m.codes.indexOf('B')][2], false, 'd[2] 当日 B 无行情');
  const t = simulate(m, { ...OPTS, threshold: 2 }).trades[1];
  assert.equal(t.sigDate, d[1]);
  assert.equal(t.date, d[3], 'd[2] 不可成交 → 顺延到 d[3]');
  assert.equal(t.toPx, 8);
});

test('最低价并列时按标的顺序取靠前者（起点空仓模式）', () => {
  const d = DS(4);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]), C: d.map((x) => [x, 15]) });
  const r = simulate(m, { ...OPTS, threshold: 3, startMode: 'flat' });
  assert.equal(r.trades[0].to, 'A', 'A/B 同价 → 取列表在前的 A');
  assert.equal(r.trades[0].kind, 'open', '首次建仓不算换仓');
  assert.equal(r.trades[0].sigDate, d[0]);
  assert.equal(r.trades[0].date, d[1], 't+1 建仓');
  assert.equal(statsOf(r).nClosed, 0);
  assert.equal(statsOf(r).winRate, null, '无已了结换仓 → 胜率无值');
});

test('起点模式：持有第一只时首笔为建仓且无信号日；空仓模式首笔来自信号', () => {
  const m = f2();
  const hold = simulate(m, { ...OPTS, threshold: 2, startMode: 'holdFirst' });
  assert.equal(hold.trades[0].kind, 'open');
  assert.equal(hold.trades[0].sigDate, null);
  assert.equal(hold.trades[0].date, m.dates[0]);
  const flat = simulate(m, { ...OPTS, threshold: 2, startMode: 'flat' });
  assert.equal(flat.trades[0].kind, 'open');
  assert.notEqual(flat.trades[0].sigDate, null, '空仓模式首笔由信号触发');
  assert.ok(statsOf(flat).nSwitch < statsOf(hold).nSwitch, '空仓起步的换仓次数更少');
  assert.equal(flat.equity[0], 1, '首个信号前为现金（净值 1）');
});

test('百分比口径：Δ% 用 (最高/最低 − 1) 判定', () => {
  const d = DS(4);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 8]) });   // 相对差 25%
  assert.equal(simulate(m, { ...OPTS, unit: '%', threshold: 30 }).trades.length, 1, 'Δ%=30 未达标');
  assert.equal(simulate(m, { ...OPTS, unit: '%', threshold: 20 }).trades.length, 2, 'Δ%=20 达标 → 换仓');
});

test('两只配对：Δ=0 时最低价一侧每换一次就换仓一次（理论换手）', () => {
  const m = fPair();
  assert.equal(m.codes.length, 2);
  const z = statsOf(simulate(m, { ...OPTS, threshold: 0 }));
  /* day0 B 更低 → 次一交易日买入 B；day4 A 更低 → 次一交易日买回 A */
  assert.equal(z.nSwitch, 2, '最低价一侧变化 2 次 → 换仓 2 次');
  assert.ok(z.nSwitch > statsOf(simulate(m, { ...OPTS, threshold: 2 })).nSwitch, 'Δ=2 时 1 元价差不触发 → 换仓更少');
});

test('两只配对：Δ=0 的换仓次数不少于任何正阈值档（关系断言）', () => {
  const m = fPair();
  const z = statsOf(simulate(m, { ...OPTS, threshold: 0 })).nSwitch;
  for (const th of defaultGrid('元').filter((v) => v > 0)) {
    assert.ok(z >= statsOf(simulate(m, { ...OPTS, threshold: th })).nSwitch, `Δ=${th} 不应多于 Δ=0`);
  }
});

test('两只配对：A/B 数据完全相同 → 0 次换仓、胜率无值', () => {
  const d = DS(6);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]) });
  const st = statsOf(simulate(m, { ...OPTS, threshold: 0 }));
  assert.equal(st.nSwitch, 0, '同价无价差 → 不换仓');
  assert.equal(st.nClosed, 0);
  assert.equal(st.winRate, null);
});

test('两只配对：单只 / 空入参返回空结果而非抛错', () => {
  const d = DS(4);
  const one = mk({ A: d.map((x) => [x, 10]) });
  assert.equal(one.codes.length, 1);
  assert.equal(statsOf(simulate(one, { ...OPTS, threshold: 1 })).nSwitch, 0, '单只 → 无换仓');
  const none = mk({});
  assert.deepEqual(none.dates, []);
  assert.doesNotThrow(() => statsOf(simulate(none, { ...OPTS })));
  assert.equal(matrixBounds({}, []).minStart, null);
});

test('pairError：两只配对校验（缺一只 / 同代码 / 合法）', () => {
  assert.match(pairError(['A']), /两只|槽位/);
  assert.match(pairError(['A', 'A']), /同一只/);
  assert.equal(pairError(['A', 'B']), null);
  assert.equal(pairError(['', 'A']), pairError(['A']));
  assert.equal(pairError(null), pairError(['A']));
});

test('含分红：除权派现计入持仓收益，且不影响信号路径（同路径下总收益 ≥ 纯价格）', () => {
  const d = DS(4);
  const m0 = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]) }, { divs: { A: [[d[2], 10]] } });   // 每股派 1 元
  const r0 = simulate(m0, { ...OPTS, threshold: 99 });
  const s0 = r0.segments[0];
  assert.ok(s0.ret > 0.08, `持有 10 元标的收到 1 元派息 → 段收益约 +10%（实际 ${(s0.ret * 100).toFixed(2)}%）`);
  const m = f2();
  const mDiv = mk({
    A: DS(10).map((x) => [x, 10]),
    B: DS(10).map((x, i) => [x, [10, 8, 8, 8, 12, 12, 12, 7, 7, 7][i]]),
    C: DS(10).map((x) => [x, 10]),
  }, { divs: { B: [[DS(10)[9], 5]] } });   // 除权日落在「正持有 B」的区间内
  const withDiv = statsOf(simulate(mDiv, { ...OPTS, threshold: 2, includeDiv: true }));
  const noDiv = statsOf(simulate(m, { ...OPTS, threshold: 2, includeDiv: false }));
  assert.equal(withDiv.nSwitch, noDiv.nSwitch, '分红不改变信号路径（信号用真实价）');
  assert.ok(withDiv.total > noDiv.total, '含分红总收益更高');
});

test('含分红累计价信号口径：信号价 = 收盘价 + 累计每股分红', () => {
  const d = DS(4);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]) }, { divs: { A: [[d[1], 20]] }, signalMode: 'div' });   // 每股 2 元
  const k = m.codes.indexOf('A');
  assert.equal(m.sig[k][0], 10, '除权前信号价 = 收盘价');
  assert.equal(m.sig[k][2], 12, '除权后信号价 = 10 + 2');
  assert.equal(m.px[k][2], 10, '真实价仍为 10');
});

test('阈值网格扫描：覆盖全部档位，且换仓次数随 Δ 单调不增', () => {
  const m = f2();
  const grid = defaultGrid('元');
  const rows = sweep(m, { ...OPTS }, grid);
  assert.equal(rows.length, grid.length);
  assert.deepEqual(rows.map((r) => r.threshold), grid);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].nSwitch <= rows[i - 1].nSwitch, `Δ=${rows[i].threshold} 的换仓次数不应多于 Δ=${rows[i - 1].threshold}`);
  }
  assert.ok(rows.some((r) => r.nSwitch > 1), '合成行情里应有多档产生换仓');
});

test('区间可调：子区间只在其范围内成交，且换仓次数不多于长区间', () => {
  const m = f2();
  const long = statsOf(simulate(m, { ...OPTS, threshold: 2 }));
  const short = mk({
    A: DS(5, 6).map((x) => [x, 10]),
    B: DS(5, 6).map((x, i) => [x, [12, 12, 7, 7, 7][i]]),
    C: DS(5, 6).map((x) => [x, 10]),
  });
  assert.equal(short.dates.length, 5);
  assert.equal(short.dates[0], '2024-01-06');
  const s = simulate(short, { ...OPTS, threshold: 2 });
  assert.equal(s.dates.length, 5);
  const st = statsOf(s);
  assert.ok(st.nSwitch <= long.nSwitch, '子区间换仓次数 ≤ 长区间');
  for (const t of s.trades) assert.ok(t.date >= short.dates[0] && t.date <= short.dates[short.dates.length - 1], '成交日落在子区间内');
  const withEnd = mk({
    A: DS(5, 6).map((x) => [x, 10]),
    B: DS(5, 6).map((x, i) => [x, [12, 12, 7, 7, 7][i]]),
    C: DS(5, 6).map((x) => [x, 10]),
  }, { end: '2024-01-08' });
  assert.deepEqual(withEnd.dates, short.dates.slice(0, 3), 'end 切片生效');
});

test('窗口外的旧分红不落到窗口首日，也不误标"除权触发"', () => {
  const d = DS(6);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 8]) }, { divs: { B: [['2020-06-10', 20]] } });   // 窗口前派息
  const kB = m.codes.indexOf('B');
  assert.equal(m.div[kB][0], 0, '旧分红不落到窗口首日');
  assert.equal(m.div[kB][1], 0);
  const r = simulate(m, { ...OPTS, threshold: 2 });
  assert.equal(r.trades[1].exDiv, false, '不应标成除权触发');
  assert.equal(r.trades[1].to, 'B');
});

test('净值一致性：Π(1+分段收益) = 净值末端（成本口径不重不漏）', () => {
  const m = f2();
  const r = simulate(m, { ...OPTS, threshold: 2 });
  const prod = r.segments.reduce((a, s) => a * (1 + (s.ret || 0)), 1);
  assert.ok(Math.abs(prod - r.equity[r.equity.length - 1]) < 1e-9, '分段收益连乘 = 净值末端');
});

test('买入持有对照：含分红、起点扣一次成本；等权 = 三只均值', () => {
  const d = DS(4);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 12]), C: d.map((x) => [x, 15]) }, { divs: { A: [[d[2], 10]] } });
  const bm = benchmarks(m, { cost: 0.0005, includeDiv: true });
  assert.ok(bm.totals.A > 9, `A 平价但派息 1 元 → 总收益约 +9.9%（实际 ${bm.totals.A.toFixed(2)}%）`);
  assert.ok(bm.totals.B < 0, '不涨的标的扣一次建仓成本 → 略为负');
  const eq = bm.equal[bm.equal.length - 1];
  const avg = (bm.series.get('A')[3] + bm.series.get('B')[3] + bm.series.get('C')[3]) / 3;
  assert.ok(Math.abs(eq - avg) < 1e-12, '等权 = 三只均值');
});

test('Wilson 置信区间边界', () => {
  assert.equal(wilson(0, 0), null);
  const lo = wilson(0, 2), hi = wilson(2, 2);
  assert.equal(lo[0], 0);
  assert.equal(hi[1], 1);
  const mid = wilson(5, 10);
  assert.ok(mid[0] < 0.5 && mid[1] > 0.5, '点估计落在区间内');
  assert.ok(wilson(3, 4)[0] > mid[0], '胜率更高 → 下界更高');
});

test('工具函数：日期位移 / 共同可用区间 / 默认网格', () => {
  assert.equal(shiftYears('2026-09-11', -5), '2021-09-11');
  assert.equal(shiftYears('2024-02-29', -1), '2023-03-01', '闰日按 Date 归一化');
  const bounds = matrixBounds({ A: [{ date: '2004-01-02' }, { date: '2026-09-11' }], B: [{ date: '2007-04-18' }, { date: '2026-09-10' }] }, ['A', 'B']);
  assert.deepEqual(bounds, { minStart: '2007-04-18', maxEnd: '2026-09-10' });
  assert.equal(defaultGrid('元').length, defaultGrid('%').length);
  assert.ok(defaultGrid('元').every((v, i, a) => i === 0 || v > a[i - 1]), '网格升序');
});

/* ── 结论/可信度：价差指标、平衡胜率、真实边际、推荐档选择 ── */

/* 长周期 fixture：B 按固定种子的随机游走在 6~15 元间走动（A、C 恒 10）→ 500 天里多次来回切换，
   有赢有输、跨年（可验证"近1年"口径），且完全可复现 */
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function oscFixture(n = 500, seed = 7) {
  const d = DL(n), rnd = lcg(seed);
  let b = 10;
  const B = d.map((x) => {
    b = Math.max(6, Math.min(15, b + (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.6 ? 1 : 2)));
    return [x, b];
  });
  return mk({ A: d.map((x) => [x, 10]), B, C: d.map((x) => [x, 10]) });
}

test('价差指标：gapAt 元/% 口径一致，gapDayShare 按达标交易日统计', () => {
  const d = DS(4);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 8]), C: d.map((x) => [x, 15]) });
  assert.equal(gapAt(m, 0, '元'), 7);
  assert.ok(Math.abs(gapAt(m, 0, '%') - (15 / 8 - 1) * 100) < 1e-9, '% 口径 = (最高/最低−1)×100');
  const all = gapDayShare(m, 7, '元');
  assert.equal(all.days, all.total);
  assert.equal(all.share, 1);
  assert.equal(gapDayShare(m, 7.01, '元').days, 0);
  /* 某日只有 1 只标的有行情 → 该日不参与价差统计（分母同步缩小） */
  const d2 = DS(3);
  const m2 = mk({ A: d2.map((x) => [x, 10]), B: [[d2[0], 8], [d2[2], 8]] });
  assert.equal(gapAt(m2, 1, '元'), null);
  assert.equal(gapDayShare(m2, 0.1, '元').total, 2);
});

test('可信度指标：盈亏平衡胜率 / 真实边际 / 保守边际 / 近1年次数 自洽', () => {
  const m = oscFixture();
  const r = simulate(m, { ...OPTS, threshold: 1 });
  const st = statsOf(r);
  const exc = r.segments.filter((s) => s.kind === 'switch' && !s.open).map((s) => s.exc).filter((v) => v != null);
  const w = exc.filter((v) => v > 0), l = exc.filter((v) => v < 0);
  assert.ok(w.length > 0 && l.length > 0, 'fixture 必须同时有赢段与输段');
  const aw = w.reduce((a, b) => a + b, 0) / w.length, al = l.reduce((a, b) => a + b, 0) / l.length;
  assert.ok(Math.abs(st.avgWin - aw) < 1e-12 && Math.abs(st.avgLoss - al) < 1e-12);
  assert.ok(Math.abs(st.breakEven - (-al) / (aw - al)) < 1e-12, '平衡胜率 = |输均| ÷（赢均+|输均|）');
  assert.ok(Math.abs(st.margin - (st.winRate - st.breakEven) * 100) < 1e-9, '真实边际 = 胜率 − 平衡胜率(pp)');
  assert.ok(Math.abs(st.consMargin - (st.lcb - st.breakEven) * 100) < 1e-9, '保守边际 = CI下界 − 平衡胜率(pp)');
  assert.ok(st.consMargin <= st.margin, '保守边际 ≤ 真实边际');
  assert.ok(st.nRecent > 0 && st.nRecent < st.nSwitch, '近1年次数 ≤ 总换仓次数，且跨年 fixture 有非近期样本');
  assert.equal(st.recentFrom, shiftYears(st.last, -1));
  /* 无输段（全赢）时平衡胜率与两个边际都必须为 null，不能编造数字 */
  const noLoss = statsOf(simulate(m, { ...OPTS, threshold: 3 }));
  if (noLoss.nClosed > 0 && noLoss.wins === noLoss.nClosed) {
    assert.equal(noLoss.avgLoss, null);
    assert.equal(noLoss.breakEven, null);
    assert.equal(noLoss.margin, null);
    assert.equal(noLoss.consMargin, null);
  }
});

test('推荐档选择：净超额最大、门槛统一、字段齐备', () => {
  const m = oscFixture();
  const conc = conclusion(m, { ...OPTS });
  assert.equal(conc.rows.length, defaultGrid('元').length);
  for (const r of conc.rows) {
    assert.ok('gapDays' in r && 'gapShare' in r && 'byYear' in r && 'nRecent' in r && 'excess' in r);
    assert.ok(r.gapShare == null || (r.gapShare >= 0 && r.gapShare <= 1));
    assert.ok(Math.abs(r.excess - (r.total - conc.eqTotal)) < 1e-9, '净超额 = 策略总收益 − 等权基准');
  }
  for (let i = 1; i < conc.rows.length; i++) assert.ok(conc.rows[i].gapDays <= conc.rows[i - 1].gapDays, '达标天数随 Δ 单调不增');
  if (conc.tier === 'main') {
    assert.ok(conc.eligible.includes(conc.best));
    for (const r of conc.eligible) assert.ok(conc.best.excess >= r.excess - EXCESS_TIE_PP, '推荐档净超额不低于任何合格档（含平局容差）');
    assert.ok(conc.best.nClosed >= EVID_MIN_CLOSED && conc.best.avgExc > 0);
  } else {
    assert.equal(conc.eligible.length, 0);
    assert.equal(conc.best, null);
  }
  if (conc.strong) {
    assert.notEqual(conc.strong.threshold, conc.best.threshold, '高确信档与主推荐不同档');
    assert.ok(conc.eligible.includes(conc.strong));
  }
});

/* ── 推荐排序规则（rankRows，喂合成行 → 确定性）── */
const row = (o) => ({ threshold: 0.5, nSwitch: 10, nClosed: 10, avgExc: 5, excess: 100, ...o });

test('推荐排序：净超额最大者胜出，不再“样本多的档赢”', () => {
  const rows = [row({ threshold: 0.5, nClosed: 20, avgExc: 1, excess: 50, nSwitch: 20 }), row({ threshold: 2, nClosed: 6, avgExc: 10, excess: 200, nSwitch: 4 })];
  const r = rankRows(rows);
  assert.equal(r.best.threshold, 2);
  assert.equal(r.eligible.length, 2);
});

test('推荐排序：全胜档（无亏损样本 → 无 consMargin）仍可入选', () => {
  const allWin = row({ threshold: 1, nClosed: 7, avgExc: 11, excess: 180, nSwitch: 8 });   // 不提供 breakEven/consMargin
  const oneLoss = row({ threshold: 0.5, nClosed: 9, avgExc: 4, excess: 100, nSwitch: 10, consMargin: 28, breakEven: 0.4 });
  assert.equal(rankRows([allWin, oneLoss]).best.threshold, 1, '全胜档不再被 consMargin=null 过滤掉');
});

test('推荐排序：净超额最高但未达门槛 → 不入选', () => {
  const lowSample = row({ threshold: 4, nClosed: EVID_MIN_CLOSED - 1, avgExc: 140, excess: 226, nSwitch: 2 });
  const solid = row({ threshold: 1, nClosed: 7, avgExc: 11, excess: 180, nSwitch: 8 });
  const r = rankRows([lowSample, solid]);
  assert.equal(r.best.threshold, 1);
  assert.ok(!r.eligible.includes(lowSample));
});

test('推荐排序：平均每次超额 ≤ 0 不入选；全为负 → best=null', () => {
  const neg = row({ threshold: 0.5, nClosed: 20, avgExc: -2, excess: -10 });
  const r = rankRows([neg]);
  assert.equal(r.best, null);
  assert.equal(r.eligible.length, 0);
  assert.equal(r.strong, null);
});

test('推荐排序：±1pp 内平局 → avgExc 高者 → 换手少者', () => {
  const a = row({ threshold: 0.5, nClosed: 9, avgExc: 5, excess: 100, nSwitch: 12 });
  const b = row({ threshold: 1, nClosed: 9, avgExc: 5, excess: 100.5, nSwitch: 8 });
  assert.equal(rankRows([a, b]).best.threshold, 1, '净超额接近且 avgExc 相同 → 取换手少者');
  const c = row({ threshold: 2, nClosed: 9, avgExc: 9, excess: 100.5, nSwitch: 20 });
  assert.equal(rankRows([a, c]).best.threshold, 2, '平局内 avgExc 高者胜');
});

test('门槛敏感性：3/5/8 三档分别给出推荐，门槛越高越严', () => {
  const m = oscFixture();
  const conc = conclusion(m, { ...OPTS });
  assert.deepEqual(conc.sensitivity.map((s) => s.min), [3, EVID_MIN_CLOSED, EVID_FAIR]);
  for (const s of conc.sensitivity) {
    if (s.threshold == null) continue;
    const r = conc.rows.find((x) => x.threshold === s.threshold);
    assert.ok(r.nClosed >= s.min, `门槛 ${s.min} 的推荐档已了结不低于门槛`);
  }
});

test('样本不足时不硬给结论（tier=none）', () => {
  const d = DS(3);
  const m = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]) });   // 无价差 → 零换仓
  const conc = conclusion(m, { ...OPTS, threshold: 1 });
  assert.equal(conc.best, null);
  assert.equal(conc.strong, null);
  assert.equal(conc.tier, 'none');
});

test('推荐档随口径变化：成本提高后同一区间的边际下降（关系断言）', () => {
  const m = oscFixture(300);
  const cheap = conclusion(m, { ...OPTS, threshold: 0.5, cost: 0 });
  const pricey = conclusion(m, { ...OPTS, threshold: 0.5, cost: 0.005 });
  const rowCheap = cheap.rows.find((r) => r.threshold === 2), rowPricey = pricey.rows.find((r) => r.threshold === 2);
  assert.ok(rowPricey.margin <= rowCheap.margin, '成本更高 → 真实边际不增');
  assert.ok(rowPricey.avgExc <= rowCheap.avgExc, '成本更高 → 平均超额不增');
});

/* ── 差价分布统计（gapArray / spreadStat）── */

/* oosValidate 需要 raw/divRows/codes/names 入参（mk 返回的是矩阵） */
function pairInput(series, opts = {}) {
  const codes = Object.keys(series);
  const raw = {}, divRows = {};
  for (const c of codes) {
    raw[c] = series[c].map(([date, close]) => ({ date, close }));
    divRows[c] = ((opts.divs || {})[c] || []).map(([ex_date, bonus10]) => ({ ex_date, bonus10 }));
  }
  return { codes, names: opts.names || codes, raw, divRows };
}

test('差价分布：分位单调、分桶计数自洽、与 gapDayShare 同源', () => {
  const d = DS(5);
  const m = mk({ A: d.map((x) => [x, 10]), B: [[d[0], 9], [d[1], 8], [d[2], 10], [d[3], 12], [d[4], 7]] });
  const ss = spreadStat(m, '元', 4);
  assert.equal(ss.n, 5);
  assert.equal(gapArray(m, '元').length, ss.n, 'gapArray 与 spreadStat 样本一致');
  assert.equal(ss.total, ss.n, '两只都有行情 → 有效天数 = 总天数');
  const keys = ['p10', 'p25', 'p50', 'p75', 'p90'];
  for (let i = 1; i < keys.length; i++) assert.ok(ss.q[keys[i]] >= ss.q[keys[i - 1]], `${keys[i]} ≥ ${keys[i - 1]}`);
  assert.equal(ss.bins.reduce((a, b) => a + b.n, 0), ss.n, '各桶计数之和 = 有效天数');
  const th = 2;
  const share = ss.arr.filter((x) => x.gap >= th).length / ss.n;
  const gds = gapDayShare(m, th, '元');
  assert.equal(gds.total, ss.n, 'gapArray 与 gapDayShare 的有效天数一致');
  assert.ok(Math.abs(gds.share - share) < 1e-12, '与网格用的达标占比同源');
  assert.equal(ss.cur.pct, 1, '当前差价 3 为区间最大 → 分位 100%');
  assert.equal(ss.flips, 2, '价差符号 +,+ ,0,-,+ → 贵的一侧切换 2 次');
  assert.ok(ss.signShare > 0 && ss.signShare < 1);
});

test('差价分布：A/B 相同 → 零价差；元/% 差分口径自洽', () => {
  const d = DS(4);
  const same = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 10]) });
  const s0 = spreadStat(same, '元');
  assert.equal(s0.flips, 0);
  assert.equal(s0.sd, 0);
  assert.equal(s0.min, 0);
  assert.equal(s0.max, 0);
  const base = mk({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 9]) });
  const scaled = mk({ A: d.map((x) => [x, 100]), B: d.map((x) => [x, 90]) });
  const y1 = spreadStat(base, '元'), y10 = spreadStat(scaled, '元');
  const p1 = spreadStat(base, '%'), p10 = spreadStat(scaled, '%');
  assert.ok(Math.abs(y10.mean - y1.mean * 10) < 1e-9, '元差随价格等比放大');
  assert.ok(Math.abs(p10.mean - p1.mean) < 1e-9, '相对差与价格水平无关');
});

test('切分点：按交易日轴比例，两侧各 ≥2 天；区间过短返回 null', () => {
  const dates = DL(10);
  const sp = splitIndex(dates, 0.7);
  assert.equal(sp.idx, 7);
  assert.equal(sp.date, dates[7]);
  assert.equal(sp.trainEnd, dates[6]);
  assert.ok(sp.trainEnd < sp.date, '训练段结束早于验证段开始');
  assert.equal(splitIndex(DL(3), 0.7), null);
});

test('样本外验证：两段无缝不重叠；验证段无触发 → insufficient（非抛错）', () => {
  const n = 300, quietFrom = 210;
  const d = DL(n), rnd = lcg(7);
  let b = 10;
  const B = d.map((x, i) => {
    if (i >= quietFrom) return [x, 10];
    b = Math.max(6, Math.min(15, b + (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.6 ? 1 : 2)));
    return [x, b];
  });
  const input = pairInput({ A: d.map((x) => [x, 10]), B });
  const r = oosValidate({ ...input, baseOpts: { ...OPTS }, start: '', end: '', ratio: 0.7 });
  assert.equal(r.ok, true);
  assert.equal(r.test.from, r.splitDate, '验证段从切分日开始');
  assert.ok(r.train.to < r.test.from, '训练/验证不重叠');
  assert.equal(r.train.nDays + r.test.nDays, n, '两段覆盖全区间');
  assert.ok(defaultGrid('元').includes(r.chosen), '训练段选出的 Δ 来自网格');
  assert.equal(r.test.stats.nSwitch, 0, '验证段同价 → 不触发换仓');
  assert.equal(r.verdict, 'insufficient', '验证段样本不足 → 不下结论');
  const sameTh = oosValidate({ ...input, baseOpts: { ...OPTS }, start: '', end: '', ratio: 0.7, extraThreshold: r.chosen });
  assert.equal(sameTh.extra, null, '与推荐 Δ 相同 → 不重复算一行');
  const other = oosValidate({ ...input, baseOpts: { ...OPTS }, start: '', end: '', ratio: 0.7, extraThreshold: 2.5 });
  if (r.chosen !== 2.5) assert.equal(other.extra.threshold, 2.5, '当前 Δ 另算一行');
});

test('样本外验证：训练段零决策 → 退用最小 Δ（nodata），验证段照常打分', () => {
  const d = DL(200);
  const B = d.map((x, i) => [x, i < 140 ? 10 : (i % 2 === 0 ? 12 : 8)]);   // 前 70% 同价，后 30% 摆动
  const input = pairInput({ A: d.map((x) => [x, 10]), B });
  const r = oosValidate({ ...input, baseOpts: { ...OPTS }, start: '', end: '', ratio: 0.7 });
  assert.equal(r.ok, true);
  assert.equal(r.train.tier, 'nodata', '训练段无决策 → 标记 nodata');
  assert.equal(r.train.stats.nSwitch, 0);
  assert.equal(r.chosen, Math.min(...defaultGrid('元')), '无决策可依据 → 退用最小 Δ');
  assert.ok(r.test.stats.nSwitch > 0, '验证段照常打分');
  assert.ok(['pass', 'weak', 'fail', 'insufficient'].includes(r.verdict));
});

test('样本外验证：区间过短 → ok=false 且不抛错', () => {
  const d = DS(3);
  const input = pairInput({ A: d.map((x) => [x, 10]), B: d.map((x) => [x, 9]) });
  let r;
  assert.doesNotThrow(() => { r = oosValidate({ ...input, baseOpts: { ...OPTS }, start: '', end: '', ratio: 0.7 }); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /区间过短|不足/);
});

