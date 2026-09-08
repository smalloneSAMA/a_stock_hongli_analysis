/* 前端纯函数单测：web/js/views/reco.js（T29）
   运行：node --test tests/frontend/  —— 覆盖权重表/推荐分档/分组/候选池构建/回测分/公共分项 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECO_W, recoBandOf, recoBandCls, groupOf, buildRecoPool, btScoreOf, recoBaseOf, recoScoreOf } from '../../web/js/views/reco.js';

test('RECO_W：三档权重和均为 100', () => {
  for (const [k, w] of Object.entries(RECO_W)) {
    assert.equal(w.dy + w.ana + w.bt, 100, k);
  }
});

test('recoBandOf：边界 75 / 60 / 45', () => {
  assert.equal(recoBandOf(75), '强烈推荐');
  assert.equal(recoBandOf(74.9), '推荐');
  assert.equal(recoBandOf(60), '推荐');
  assert.equal(recoBandOf(45), '关注');
  assert.equal(recoBandOf(44.9), '回避');
});

test('recoBandCls：映射与未知兜底', () => {
  assert.equal(recoBandCls('强烈推荐'), 'band-buy');
  assert.equal(recoBandCls('回避'), 'band-sell2');
  assert.equal(recoBandCls('不存在'), 'band-hold');
});

test('groupOf：指数/ETF 优先，股票按 rec/watch 分组', () => {
  const meta = { 600036: { rec: true }, '000858': { watch: true }, 601398: {} };
  assert.equal(groupOf('000922', '指数', meta), '指数');
  assert.equal(groupOf('515180', 'ETF', meta), 'ETF');
  assert.equal(groupOf('600036', '股票', meta), '推荐20');
  assert.equal(groupOf('000858', '股票', meta), '自选股');
  assert.equal(groupOf('601398', '股票', meta), '其他成份股');
  assert.equal(groupOf('999999', '股票', meta), '其他成份股');
});

test('buildRecoPool：过滤无回测/无信号标的，字段与横截面分位正确', () => {
  const an = { date: '2026-09-09', by_code: {
    '600036': { dy0: 5, dy_now: 5, dy_pct: 60, dy_p50: 4.8, close_now: 40, factors: { price: { pct: 70 } }, anchors: { buy: 31 } },
    '000858': { dy0: 4, dy_now: 4, dy_pct: 40, dy_p50: 3.9, close_now: 120, factors: {}, anchors: { buy: 100 } },
    '601398': { dy0: 6, dy_now: 6, dy_pct: 80, dy_p50: 5.5, close_now: 6, factors: {}, anchors: { buy: 5 } },
  } };
  const bt = { by_p: { 90: [
    { code: '600036', win12: 60, win6: 55, ex12: 5, base12: 2, n_buy: 10 },
    { code: '000858', win12: null },          // 无信号 → 过滤
  ] } };
  const m = { stocks: [
    { code: '600036', rec: true, last: '2026-09-09' },
    { code: '000858', last: '2026-09-08' },
  ] };
  const { all, maxDate } = buildRecoPool(an, bt, m);
  assert.deepEqual(all.map((r) => r.code), ['600036']);   // 601398 无回测记录 → 过滤
  const r = all[0];
  assert.equal(r.dy, 5);
  assert.equal(r.pct, 60);
  assert.equal(r.dy_p50, 4.8);
  assert.equal(r.close, 40);
  assert.equal(r.group, '推荐20');
  assert.equal(r.anchor, 31);
  assert.equal(r.crossPct, 100);            // 池内唯一 → 100
  assert.equal(maxDate, '2026-09-09');      // 取池内 manifest.last 最大值
});

test('btScoreOf：回测分公式（胜率/超额/样本/时效）', () => {
  const r = { win12: 60, win6: 55, ex12: 5, base12: 2, n_buy: 10, signal_years: {} };
  // 0.35*60 + 0.10*55 + 0.25*5 + 0.1*(5+2) + 10*min(1,10/20) + 0 + (55-60)*0.05
  assert.ok(Math.abs(btScoreOf(r) - 33.2) < 1e-9);
});

test('recoBaseOf：dy 混合分 / 触发 / 背离', () => {
  const byCode = { X: { factors: { price: { pct: 85 } } } };
  const b = recoBaseOf({ code: 'X', pct: 90, crossPct: 80 }, byCode);
  assert.equal(b.dyPart, 85);        // 0.5*80 + 0.5*90
  assert.equal(b.trig, 5);           // pct>=90 → 触发中
  assert.equal(b.diverge, 5);        // pct>=90 且价格分位>=80 → 周期股假便宜
  const b2 = recoBaseOf({ code: 'Y', pct: 10, crossPct: 20 }, {});
  assert.equal(b2.trig, -5);         // 卖出区
  assert.equal(b2.diverge, 0);
});

test('recoScoreOf：加权合成 + 限幅 0~100', () => {
  const r = { code: '600036', type: '股票', pct: 60, crossPct: 80, win12: 60, win6: 55, ex12: 5, base12: 2, n_buy: 10, signal_years: {} };
  const byCode = { 600036: { factors: { dy: { pct: 40 }, price: { pct: 70 }, pe: { pct: 50 }, pb: { pct: 60 } } } };
  const an = { presets: { 均衡: { B: { dy: 35, pe: 35, pb: 30 } } } };
  const out = recoScoreOf(r, '均衡', byCode, an);
  // dyPart=70, ana=49.5→sAna=50.5, bt=33.2 → (35*70 + 30*50.5 + 35*33.2)/100 = 51.27
  assert.ok(Math.abs(out.s - 51.27) < 0.01, String(out.s));
  assert.equal(out.dyPart, 70);
  assert.equal(out.trig, 0);
});
