/* 智能推荐评分公共模块（recommendView / holdingsView 共用同一口径，禁止本地复制）
   推荐分 = w_dy×dy混合分 + w_ana×(100−贵贱度分) + w_bt×回测分，另加/减：触发中+5、卖出区−5、背离−5；最终限幅 0~100
   dy混合分 = 横截面绝对分位×50% + 历史分位×50%（高=便宜）
   回测分 = 0.35×win12 + 0.10×win6 + 0.25×max(0,ex12) + 0.1×max(0,超额+基准) + 样本可信20 + 时效修正±5 */

import { scoreOf as anaScoreOf } from './analysis.js';   // 贵贱度加权分（P4.3 三合一）

/* 三档权重（用户确认：稳健 50/25/25、均衡 35/30/35、进取 25/25/50） */
export const RECO_W = {
  稳健: { dy: 50, ana: 25, bt: 25 },
  均衡: { dy: 35, ana: 30, bt: 35 },
  进取: { dy: 25, ana: 25, bt: 50 },
};

/* 推荐分档（高=好，方向与 analysis.js 的 bandOf（贵贱度）语义相反，不共用） */
export const recoBandOf = (s) => (s >= 75 ? '强烈推荐' : s >= 60 ? '推荐' : s >= 45 ? '关注' : '回避');
export const recoBandCls = (b) => ({ 强烈推荐: 'band-buy', 推荐: 'band-build', 关注: 'band-hold', 回避: 'band-sell2' }[b] || 'band-hold');

/* 三档打分说明（悬停提示 + 动态标签 + 底部对照表） */
export const RECO_PRESET_DESC = {
  稳健: { w: 'dy 50% · 贵贱度 25% · 回测 25%', tip: '股息为王：股息率分位占一半，最看重“便宜”与分红确定性' },
  均衡: { w: 'dy 35% · 贵贱度 30% · 回测 35%', tip: '三分均衡：当前状态与历史胜率并重，默认档' },
  进取: { w: 'dy 25% · 贵贱度 25% · 回测 50%', tip: '回测弹性：历史超额表现占半，追求进攻性' },
};

/* 分组判定（推荐优先于自选，与信号扫描/回测一致） */
export function groupOf(code, type, meta) {
  if (type === '指数') return '指数';
  if (type === 'ETF') return 'ETF';
  const s = meta[code] || {};
  if (s.rec) return '推荐20';
  if (s.watch) return '自选股';
  return '其他成份股';
}

/* 候选池构建：有回测记录且至少触发过一次买入信号（无回测/无信号直接过滤）+ 横截面绝对股息率分位
   返回 { all, maxDate }；all 行含 code/name/type/group/dy/pct/crossPct/close/...backtest 字段 */
export function buildRecoPool(dy, bt, an, m) {
  const btMap = new Map((bt.by_p['90'] || []).map((x) => [x.code, x]));
  const byCode = an.by_code || {};
  const meta = {};
  for (const s of (m.indices || [])) meta[s.code] = s;   // 指数/ETF 也有 dd2y/hi2y（2Y回撤列）
  for (const s of (m.etfs || [])) meta[s.code] = s;
  for (const s of (m.stocks || [])) meta[s.code] = s;   // stocks 字段最全，最后写防覆盖

  const all = [];
  let maxDate = '';
  for (const code in dy) {
    const d = dy[code];
    if (d.dy0 == null || d.dy_pct == null) continue;
    const b = btMap.get(code);
    if (!b || b.win12 == null) continue;   // 无回测 或 近5年无买入信号 → 过滤
    if (d.series && d.series.length) {
      const last = d.series[d.series.length - 1][0];
      if (last > maxDate) maxDate = last;
    }
    const type = d.type;
    const ent = byCode[code] || {};
    all.push({ code, name: d.name || code, type, group: groupOf(code, type, meta),
      dy: d.dy_now, pct: d.dy_pct, dy_p50: d.dy_p50 ?? null, close: d.close_now,
      dd2y: meta[code]?.dd2y ?? null, hi2y: meta[code]?.hi2y ?? null, hi2y_date: meta[code]?.hi2y_date ?? null,
      anchor: (ent.anchors && ent.anchors.buy) ?? null,
      pr: (type === '股票' ? (meta[code]?.last_pr ?? null) : null),   // 市赚率PR（仅股票，指数/ETF 无财报）
      ...b });
  }

  /* 横截面绝对股息率分位（候选池内，高=股息率高）：高股息股不吃亏，且不受全市场估值水平影响 */
  const dyVals = all.map((r) => r.dy).filter((v) => v != null).sort((a, b) => a - b);
  for (const r of all) {
    if (r.dy == null || !dyVals.length) { r.crossPct = 0; continue; }
    const lo = dyVals.indexOf(r.dy), hi = dyVals.lastIndexOf(r.dy);
    r.crossPct = dyVals.length > 1 ? (lo + hi) / 2 / (dyVals.length - 1) * 100 : 100;
  }
  return { all, maxDate };
}

/* 回测分（v3·信号能力评估）：胜率12M 35% + 胜率6M 10%（时效） + 超额12M 25%（负计0）
   + 绝对收益 max(0,超额+基准) 10%（回答"信号买入后绝对赚不赚"）
   + 样本可信 20 = 数量 10×min(1,n_buy/20) + 跨年覆盖 10×min(1,有信号年份数/4)
   + 时效修正±5 */
export function btScoreOf(r) {
  const w6 = r.win6 == null ? r.win12 : r.win6;   // win6 缺失时按 win12（时效修正归零）
  const trend = Math.max(-5, Math.min(5, (w6 - r.win12) * 0.05));   // 近期信号变强加分/变弱减分
  const absRet = (r.ex12 ?? 0) + (r.base12 ?? 0);   // 绝对收益（超额+基准）
  const yearsN = r.signal_years ? Object.keys(r.signal_years).length : 0;   // 有信号年份数（跨年覆盖）
  return 0.35 * r.win12 + 0.10 * w6 + 0.25 * Math.max(0, r.ex12 ?? 0)
    + 0.1 * Math.max(0, absRet)
    + 10 * Math.min(1, r.n_buy / 20) + 10 * Math.min(1, yearsN / 4) + trend;
}

/* 与档位无关的公共部分（dy混合分/背离/触发） */
export function recoBaseOf(r, byCode) {
  const pricePct = byCode[r.code] && byCode[r.code].factors && byCode[r.code].factors.price ? byCode[r.code].factors.price.pct : null;
  const diverge = (r.pct >= 90 && pricePct != null && pricePct >= 80) ? 5 : 0;   // 周期股假便宜
  const trig = r.pct >= 90 ? 5 : (r.pct <= 10 ? -5 : 0);   // 触发中 +5 / 卖出区 −5
  const dyPart = 0.5 * (r.crossPct ?? 0) + 0.5 * r.pct;   // dy 混合分：横截面50% + 历史50%
  return { dyPart, diverge, trig };
}

/* 单档推荐分（0~100），返回 { s, dyPart, anaPart, btPart, diverge, trig } */
export function recoScoreOf(r, preset, byCode, an) {
  const w = RECO_W[preset];
  const ana = anaScoreOf(byCode[r.code], preset, r.type, an.presets);
  const sAna = ana == null ? 0 : 100 - ana;
  const bt = btScoreOf(r);
  const base = recoBaseOf(r, byCode);
  let s = (w.dy * base.dyPart + w.ana * sAna + w.bt * bt) / 100 + base.trig - base.diverge;
  s = Math.max(0, Math.min(100, s));
  return { s, dyPart: base.dyPart, anaPart: sAna, btPart: bt, diverge: base.diverge, trig: base.trig };
}
