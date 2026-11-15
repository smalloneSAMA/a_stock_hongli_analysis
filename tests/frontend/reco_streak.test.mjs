/* 连续天数（streak）纯函数单测：状态机推进 / 加成表 / 十分位 / 产物关系
   口径见 docs/智能推荐-连续天数-设计方案.md（在榜=该档基准分≥75；连续=在榜且未从峰值回落超容差） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStreak, tenth, ON_LINE, TOL, TABS } from '../../scripts/_reco_streak.mjs';
import { STREAK_TOL, streakBonusOf } from '../../web/js/views/reco.js';
import { readFileSync, existsSync } from 'node:fs';

const D1 = '2026-11-03', D2 = '2026-11-04', D3 = '2026-11-05';

test('容差与前端同源（单一常量）', () => {
  assert.equal(TOL, STREAK_TOL);
  assert.ok(TOL > 0 && TOL < 10);
});

test('状态机：新上榜 → 创新高 → 峰值附近震荡 → 回落超容差断', () => {
  let r = advanceStreak(undefined, 80, D1);
  assert.deepEqual([r.state.n, r.state.since, r.state.peak, r.reason], [1, D1, 80, 'new']);

  r = advanceStreak(r.state, 85, D2);                       // 创新高：涨不限
  assert.deepEqual([r.state.n, r.state.since, r.state.peak, r.reason], [2, D1, 85, null]);

  r = advanceStreak(r.state, 82.5, D3);                     // 距峰值 -2.5，容差内
  assert.deepEqual([r.state.n, r.state.peak, r.reason], [3, 85, null]);

  r = advanceStreak({ n: 5, since: D1, peak: 85 }, 82.0, D3);   // 恰好 -3.0（边界含）
  assert.equal(r.state.n, 6);
  assert.equal(r.reason, null);

  r = advanceStreak({ n: 5, since: D1, peak: 85 }, 81.9, D3);   // -3.1 超容差
  assert.deepEqual([r.state.n, r.state.since, r.state.peak, r.reason], [1, D3, 81.9, 'drop']);
});

test('状态机：跌出榜单/缺数据都清零，并保留断因', () => {
  let r = advanceStreak({ n: 7, since: D1, peak: 90 }, 74.9, D2);
  assert.deepEqual([r.state.n, r.state.peak, r.reason], [0, null, 'off']);
  r = advanceStreak({ n: 7, since: D1, peak: 90 }, null, D2);
  assert.deepEqual([r.state.n, r.state.peak, r.reason], [0, null, 'nodata']);
});

test('状态机：断后重新起算（since 重置为新起点）', () => {
  const r = advanceStreak(undefined, ON_LINE, D2);
  assert.equal(r.state.n, 1);
  assert.equal(r.state.since, D2);
  assert.equal(r.state.peak, ON_LINE);
});

test('加成表：0-2 天不给分，20 天封顶 +5，且非递减', () => {
  const want = [[0, 0], [1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [7, 2], [8, 3], [12, 3], [13, 4], [19, 4], [20, 5], [200, 5]];
  for (const [n, b] of want) assert.equal(streakBonusOf(n), b, `n=${n}`);
  let prev = -1;
  for (let n = 0; n <= 60; n++) { const b = streakBonusOf(n); assert.ok(b >= prev, `n=${n} 非递减`); prev = b; }
  // 结构性质：加成 > 0 必然蕴含 n ≥ 3（即在榜且已确认，不会给未上榜股票加分）
  for (let n = 0; n <= 60; n++) if (streakBonusOf(n) > 0) assert.ok(n >= 3);
});

test('十分位换算（存储精度统一）', () => {
  assert.equal(tenth(85.94), 859);
  assert.equal(tenth(74.95), 750);   // 四舍五入
});

/* 产物关系断言：不写死数字，只校验结构与口径关系 */
test('产物 reco_streak.json 结构自洽（产物缺失则跳过）', () => {
  const p = new URL('../../web/data/reco_streak.json', import.meta.url);
  if (!existsSync(p)) return;
  const st = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(st.date && /^\d{4}-\d{2}-\d{2}$/.test(st.date), 'date 为 YYYY-MM-DD');
  assert.ok(st.history_days >= 1);
  const ON = st.on_line * 10;                       // 十分位门槛
  for (const [code, e] of Object.entries(st.by_code)) {
    for (const tab of TABS) {
      const s = e.d[tab];
      assert.ok(TABS.includes(tab));
      if (s.n > 0) {
        assert.ok(s.today != null && s.today >= ON, `${code}/${tab}: n>0 必须今日在榜`);
        assert.ok(s.since, `${code}/${tab}: n>0 必须有起点`);
        assert.ok(e.on[tab] >= s.n, `${code}/${tab}: 在榜累计 ≥ 当前连续`);
        assert.ok(e.max[tab] >= s.n, `${code}/${tab}: 历史最长 ≥ 当前连续`);
      }
      if (s.today != null && s.peak != null) assert.ok(s.today <= s.peak, `${code}/${tab}: 今日不高于峰值`);
    }
  }
});
