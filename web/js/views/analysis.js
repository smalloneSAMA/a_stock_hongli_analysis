/* 区间分析公共计算（P4.3 三合一）：贵贱度加权分 + 贵贱度分档 + CSS 类
   口径与 scripts/_gen_analysis.py 的 PRESETS / band_of 一致（后端由 _test_analysis.py T3.5/T3.6 覆盖）。
   注意：recommendView 的"推荐分档"（强烈推荐/推荐/关注/回避）语义与这里的贵贱度分档相反，不共用。 */

/* 贵贱度加权分：presets[档][A/B] × 因子分位 ÷ 权重和；0=便宜 → 100=贵
   ent = analysis.by_code[code]；presets = analysis.presets（调用方已加载的 JSON 对象） */
export function scoreOf(ent, preset, type, presets) {
  if (!ent || !presets) return null;
  const w = presets[preset][type === '股票' ? 'B' : 'A'];
  let s = 0, tot = 0;
  for (const k in w) {
    const f = ent.factors[k];
    if (f && f.pct != null) { s += f.pct * w[k]; tot += w[k]; }
  }
  return tot ? s / tot : null;
}

/* 贵贱度分档（0=便宜→100=贵；边界与 _gen_analysis.band_of 一致：25/45/65/80） */
export const bandOf = (s) => (s <= 25 ? '买入区间' : s <= 45 ? '逐步建仓' : s <= 65 ? '持有' : s <= 80 ? '逐步卖出' : '卖出区间');
export const bandCls = (b) => ({ '买入区间': 'band-buy', '逐步建仓': 'band-build', '持有': 'band-hold', '逐步卖出': 'band-sell', '卖出区间': 'band-sell2' }[b] || 'band-hold');
