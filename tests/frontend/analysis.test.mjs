/* 前端纯函数单测：web/js/views/analysis.js（T29）
   运行：node --test tests/frontend/
   口径与 scripts/_gen_analysis.py 的 PRESETS / band_of 一致（后端由 _test_analysis.py 覆盖） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOf, bandOf, bandCls } from '../../web/js/views/analysis.js';

const PRESETS = { 均衡: { A: { dy: 50, price: 50 }, B: { dy: 35, pe: 35, pb: 30 } } };

test('scoreOf：按档位权重加权（指数用 A 表）', () => {
  const ent = { factors: { dy: { pct: 40 }, price: { pct: 60 } } };
  assert.equal(scoreOf(ent, '均衡', '指数', PRESETS), 50);   // (40*50 + 60*50) / 100
});

test('scoreOf：股票用 B 表', () => {
  const ent = { factors: { dy: { pct: 40 }, pe: { pct: 70 }, pb: { pct: 100 } } };
  assert.equal(scoreOf(ent, '均衡', '股票', PRESETS), 68.5); // (40*35 + 70*35 + 100*30) / 100
});

test('scoreOf：缺失因子跳过并按剩余权重归一', () => {
  const ent = { factors: { dy: { pct: 40 }, price: { pct: null } } };
  assert.equal(scoreOf(ent, '均衡', '指数', PRESETS), 40);
});

test('scoreOf：无 ent / 无 presets / 无可用因子 → null', () => {
  assert.equal(scoreOf(null, '均衡', '指数', PRESETS), null);
  assert.equal(scoreOf({ factors: { dy: { pct: 1 } } }, '均衡', '指数', null), null);
  assert.equal(scoreOf({ factors: {} }, '均衡', '指数', PRESETS), null);
});

test('bandOf：边界 25 / 45 / 65 / 80', () => {
  assert.equal(bandOf(25), '买入区间');
  assert.equal(bandOf(25.1), '逐步建仓');
  assert.equal(bandOf(45), '逐步建仓');
  assert.equal(bandOf(65), '持有');
  assert.equal(bandOf(80), '逐步卖出');
  assert.equal(bandOf(80.1), '卖出区间');
});

test('bandCls：映射与未知兜底', () => {
  assert.equal(bandCls('买入区间'), 'band-buy');
  assert.equal(bandCls('卖出区间'), 'band-sell2');
  assert.equal(bandCls('不存在'), 'band-hold');
});
