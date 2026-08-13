# -*- coding: utf-8 -*-
"""组合回测：推荐20量化选股逻辑的历史验证（区别于择时信号回测）

方法：
- 区间：2019-01-01 ~ 最新；季度末调仓（3/6/9/12 月最后交易日），等权持有 TOP20
- 选股：与 _recommend_stocks.py 同构（硬过滤 dy≥3.0% + 60日均额≥3000万；三组10因子；
  均衡档权重；行业≤4 + 四象限≥3 保底），全部因子用截至调仓日的数据（无未来函数）
- 收益口径：价格口径（P_end/P_start−1）与 含现金分红口径（+期内除权派息/期初价，不复投）
- 基准：000922 中证红利（价格）｜旧人工20只（固定清单等权）｜候选池等权
- 指标：年化 / 最大回撤 / 夏普(无风险0) / 季度胜率 / 超额
- 产出：docs/组合回测报告.md + web/data/portfolio_backtest.json

局限（如实标注）：① 成分股幸存者偏差（仅回测当前池内股票）；② 价格口径为主，
含分红口径为近似（现金计入不复投）；③ 基准未含分红（同价格口径可比）。
用法: python scripts/_backtest_portfolio.py [--start 2019-01-01]
"""
import sys, os, json, math, datetime, argparse

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _recommend_stocks as rs   # 复用硬过滤/因子映射/约束（仅借用 QUADRANT/WEIGHTS 常量）
import _fetch_stock_data as fsd
from _common import atomic_dump   # 原子写（tmp+replace）

WINDOW = 1250          # dy 滚动分位窗口（5年交易日）
DY_MIN = 3.0           # 与推荐评分一致
AMT_MIN = 3e7          # 60日均额（元）
AMT_DAYS = 60          # 流动性窗口
Q_START = "2019-01-01" # 回测起点（高股息风格有效期内）

# 旧人工 20 只（对照组，固定清单）
FALLBACK = [c for c, _, _ in fsd._FALLBACK_STOCKS]


def load_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def q_end_dates(rows_by_code):
    """季度末交易日：取各股票交易日并集，每季度最后一个交易日（2019 起）"""
    days = set()
    for code, rows in rows_by_code.items():
        days.update(r[0] for r in rows if r[0] >= Q_START)
    ends = {}
    for d in sorted(days):
        y, m = d[:4], (int(d[5:7]) - 1) // 3
        ends[(y, m)] = d   # 同季度内后者覆盖 → 最后交易日
    return [d for (y, m), d in sorted(ends.items())]


def div_metrics_at(dc, t_date):
    """截至 t_date：最新完整年度派息/前一年度/年度派息序列；返回 (cur, prev) 每股元"""
    if not dc:
        return None
    by = {}
    for r in dc["rows"]:
        if r["ex_date"] <= t_date:
            by[r["ex_date"][:4]] = by.get(r["ex_date"][:4], 0) + r["bonus10"] / 10.0
    if not by:
        return None
    ty = int(t_date[:4])
    ys = sorted(int(y) for y in by if int(y) < ty)
    if not ys:
        return None
    fy = ys[-1]
    return by[str(fy)], by.get(str(fy - 1))


def annual_eps_at(fc, t_date):
    """截至 t_date 的最新年报 (eps, roe)"""
    if not fc:
        return None, None
    for r in fc["rows"]:
        if r.get("report_date", "") <= t_date and r.get("report_date", "").endswith("12-31") and r.get("eps"):
            return r["eps"], r.get("roe")
    return None, None


def roe_stability_at(fc, t_date):
    """截至 t_date 近 12 期 roe CV → 100(1−CV)"""
    if not fc:
        return None
    roes = [r["roe"] for r in fc["rows"] if r.get("report_date", "") <= t_date and r.get("roe") is not None][:12]
    if len(roes) < 8:
        return None
    mean = sum(roes) / len(roes)
    if mean <= 0:
        return None
    sd = math.sqrt(sum((x - mean) ** 2 for x in roes) / len(roes))
    return 100 * max(0.0, 1 - sd / mean)


def trend_pct_at(closes):
    """与 _gen_analysis.build_trend 同款：MA60 乖离分位 + MA 排列修正"""
    n = len(closes)
    if n < 20:
        return 50.0
    ma60 = sum(closes[-60:]) / 60 if n >= 60 else sum(closes) / n
    bias = closes[-1] / ma60 - 1
    pct = max(0.0, min(100.0, 50 + (bias / 0.15) * 50))
    if n >= 200:
        ma200 = sum(closes[-200:]) / 200
        if closes[-1] > ma60 > ma200:
            pct += 10
        elif closes[-1] < ma60 < ma200:
            pct -= 10
    return max(0.0, min(100.0, pct))


def pct_rank(v, arr):
    if v is None or not arr:
        return None
    return sum(1 for x in arr if x <= v) / len(arr) * 100


def pick_at(t_date, stocks, data):
    """在 t_date 选 TOP20（返回 code 列表）"""
    # ── 因子原始值（截至 t_date）──
    raw = {}
    for code, m in stocks:
        d = data[code]
        px = d["px"]          # [(date, close, amount)]
        idx = None
        for i, r in enumerate(px):
            if r[0] > t_date:
                idx = i
                break
        if idx is None:
            idx = len(px)
        seg = px[:idx]        # 截至 t_date 的行情
        if not seg:
            continue
        close_t = seg[-1][1]
        if not close_t:
            continue
        # 指标文件 t 日 dy/pe/pb（指标文件与 K线日期对齐，用 <=t 的最后一行）
        ind = d["ind"]
        ii = None
        for i, r in enumerate(ind):
            if r["d"] > t_date:
                ii = i
                break
        if ii is None:
            ii = len(ind)
        iseg = ind[:ii]
        if not iseg:
            continue
        dy_t = iseg[-1].get("dy")
        pe_t, pb_t = iseg[-1].get("pe_ttm"), iseg[-1].get("pb")
        if dy_t is None or dy_t < DY_MIN:
            continue     # 硬过滤：dy
        # 流动性：60日均额
        amts = [r[2] for r in seg[-AMT_DAYS:] if r[2] is not None]
        if amts and sum(amts) / len(amts) < AMT_MIN:
            continue
        # A2：dy 历史滚动分位（analysis_dy 序列）
        a2 = None
        dser = d["dy_ser"]
        if dser:
            sub = [v for dt, v in dser if dt <= t_date][-WINDOW:]
            if len(sub) >= 60:
                a2 = pct_rank(sub[-1], sub)
        # B 组（财报/分红缓存）
        b1 = b2 = b4 = b5 = None
        eps_ann, roe_ann = annual_eps_at(d["fc"], t_date)
        if roe_ann is not None:
            b1 = roe_ann
        b2 = roe_stability_at(d["fc"], t_date)
        dm = div_metrics_at(d["dc"], t_date)
        if dm:
            cur_y, prev_y = dm
            if eps_ann:
                pr = cur_y / eps_ann * 100
                b4 = pr if pr <= 150 else None
            if prev_y:
                b5 = cur_y / prev_y - 1
        # C 组
        closes = [r[1] for r in seg if r[1] is not None]
        c1 = trend_pct_at(closes) if len(closes) >= 60 else None
        c2 = None
        if len(closes) >= 250:
            rets = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 250, len(closes))]
            mean = sum(rets) / len(rets)
            c2 = math.sqrt(sum((x - mean) ** 2 for x in rets) / len(rets))
        c3 = (closes[-1] / closes[-61] - 1) * 100 if len(closes) >= 61 else None
        raw[code] = {"A1": dy_t, "A2": a2, "pe": pe_t, "pb": pb_t,
                     "B1": b1, "B2": b2, "B4": b4, "B5": b5,
                     "C1": c1, "C2": c2, "C3": c3, "close": close_t,
                     "ind": m.get("ind", ""), "name": m.get("name", code)}

    # ── 池内分位 + 总分 ──
    arrs = {k: sorted(v[k] for v in raw.values() if v[k] is not None)
            for k in ("A1", "A2", "pe", "pb", "B1", "B2", "B4", "C1", "C2", "C3")}
    scored = []
    for code, r in raw.items():
        fac = {}
        if r["A1"] is not None:
            fac["A1"] = pct_rank(r["A1"], arrs["A1"])
        if r["A2"] is not None:
            fac["A2"] = r["A2"]
        if r["pe"] is not None and arrs["pe"] and r["pb"] is not None:
            fac["A3"] = 0.5 * (100 - pct_rank(r["pe"], arrs["pe"])) + 0.5 * (100 - pct_rank(r["pb"], arrs["pb"]))
        if r["B1"] is not None:
            fac["B1"] = pct_rank(r["B1"], arrs["B1"])
        if r["B2"] is not None:
            fac["B2"] = r["B2"]
        if r["B4"] is not None:
            pr = r["B4"]
            fac["B4"] = 100 if 20 <= pr <= 70 else (pr / 20 * 100 if pr < 20 else max(0.0, 100 - (pr - 70) / 0.8))
        if r["B5"] is not None:
            fac["B5"] = 50 + 50 * math.tanh(r["B5"] / 0.4)
        if r["C1"] is not None:
            fac["C1"] = r["C1"]
        if r["C2"] is not None:
            fac["C2"] = 100 - pct_rank(r["C2"], arrs["C2"])
        if r["C3"] is not None:
            fac["C3"] = 100 - 0.5 * pct_rank(r["C3"], arrs["C3"])
        grp = {}
        for g in ("A", "B", "C"):
            wsum = ssum = 0.0
            for fk, w in rs.FACTOR_W[g].items():
                if fk in fac:
                    wsum += w
                    ssum += w * fac[fk]
            grp[g] = ssum / wsum if wsum else None
        wsum = ssum2 = 0.0
        for g, w in rs.WEIGHTS["均衡"].items():
            if grp[g] is not None:
                wsum += w
                ssum2 += w * grp[g]
        total = ssum2 / wsum if wsum else None
        if total is None:
            continue
        scored.append({"code": code, "name": r["name"], "ind": r["ind"], "score": total,
                       "close": r["close"]})
    scored.sort(key=lambda x: -x["score"])
    # ── 约束（行业≤4 + 四象限≥3，同 _recommend_stocks）──
    picked, ind_cnt = [], {}
    QUADS = ("金融", "防御", "周期", "消费")
    for q in QUADS:
        got = 0
        for it in scored:
            if got >= 3:
                break
            if rs.QUADRANT.get(it["ind"], "其他") != q or ind_cnt.get(it["ind"], 0) >= 4:
                continue
            picked.append(it)
            ind_cnt[it["ind"]] = ind_cnt.get(it["ind"], 0) + 1
            got += 1
    for it in scored:
        if len(picked) >= 20:
            break
        if any(x["code"] == it["code"] for x in picked) or ind_cnt.get(it["ind"], 0) >= 4:
            continue
        picked.append(it)
        ind_cnt[it["ind"]] = ind_cnt.get(it["ind"], 0) + 1
    return picked, scored


def period_return(px, s_date, e_date):
    """价格收益与含分红收益（期初最近收盘 → 期末最近收盘；期内除权派息/期初价）"""
    ps = pe = None
    div = 0.0
    for r in px:
        if r[0] <= s_date:
            ps = r[1]
        if s_date < r[0] <= e_date:
            pe = r[1]
            div += r[3] or 0.0
    if not ps or not pe:
        return None, None
    return pe / ps - 1, div / ps


def main(start=None):
    start = start or Q_START
    m = load_json(os.path.join(BASE, "web", "data", "manifest.json")) or {}
    stocks = [(s["code"], s) for s in m.get("stocks", []) if s.get("ready")]
    data = {}
    for code, sm in stocks:
        ind = load_json(os.path.join(BASE, "web", "data", "stocks", f"{code}.json"))
        kc = load_json(os.path.join(BASE, "cache", f"股票_{code}.json"))
        dc = load_json(os.path.join(BASE, "cache", f"分红_{code}.json"))
        fc = load_json(os.path.join(BASE, "cache", f"财报_{code}.json"))
        ad = load_json(os.path.join(BASE, "cache", "analysis_dy.json")) or {}
        if not ind or not kc:
            continue
        px = [[r["date"], r.get("close"), r.get("amount"), 0.0] for r in kc["rows"]]
        dser = (ad.get(code) or {}).get("series", [])
        data[code] = {"px": px, "ind": ind, "dc": dc, "fc": fc, "dy_ser": dser}
    # 分红并入 K线（除权日对齐）——period_return 用 r[3]
    for code, d in data.items():
        if not d["dc"]:
            continue
        dmap = {}
        for r in d["dc"]["rows"]:
            dmap[r["ex_date"]] = dmap.get(r["ex_date"], 0) + r["bonus10"] / 10.0
        for r in d["px"]:
            if r[0] in dmap:
                r[3] = dmap[r[0]]

    # 季度末时点（用候选池交易日并集）
    q_dates = q_end_dates({c: d["px"] for c, d in data.items()})
    q_dates = [d for d in q_dates if d >= start]
    if len(q_dates) < 4:
        print("❌ 回测时点不足")
        return

    # 基准 000922（价格序列，同期季度收益）
    idx = load_json(os.path.join(BASE, "cache", "指数_000922.json"))
    idx_px = [(r["date"], r.get("close")) for r in (idx or {}).get("rows", [])]
    fb_close = {}   # 旧人工20只期初/期末价（等权）
    pool_close = {} # 候选池等权

    print(f"═══ 组合回测（{start} ~ {q_dates[-1]}，{len(q_dates)} 个季度调仓点，候选池 {len(data)} 只）═══")
    rows_out = []
    nav_q, nav_idx, nav_fb, nav_pool = 1.0, 1.0, 1.0, 1.0
    navs_q, navs_idx, navs_fb, navs_pool = [], [], [], []
    wins, n_periods = 0, 0
    prev_pick = None
    for k in range(len(q_dates) - 1):
        t0, t1 = q_dates[k], q_dates[k + 1]
        picked, scored = pick_at(t0, stocks, data)
        if not picked:
            continue
        codes = [it["code"] for it in picked]
        # 组合收益（等权）
        rs_px, rs_div = [], []
        for c in codes:
            p, dv = period_return(data[c]["px"], t0, t1)
            if p is not None:
                rs_px.append(p)
                rs_div.append(dv)
        if not rs_px:
            continue
        r_px = sum(rs_px) / len(rs_px)
        r_div = sum(rs_div) / len(rs_div)
        # 基准：000922
        ps = pe = None
        for dt, v in idx_px:
            if dt <= t0:
                ps = v
            if t0 < dt <= t1:
                pe = v
        r_idx = pe / ps - 1 if ps and pe else None
        # 旧人工20只等权
        r_fb = None
        fbr = []
        for c in FALLBACK:
            if c in data:
                p, _ = period_return(data[c]["px"], t0, t1)
                if p is not None:
                    fbr.append(p)
        if fbr:
            r_fb = sum(fbr) / len(fbr)
        # 候选池等权
        r_pool = None
        prs = []
        for it in scored:
            p, _ = period_return(data[it["code"]]["px"], t0, t1)
            if p is not None:
                prs.append(p)
        if prs:
            r_pool = sum(prs) / len(prs)
        nav_q *= (1 + r_px); nav_idx *= (1 + (r_idx or 0)); nav_fb *= (1 + (r_fb or 0)); nav_pool *= (1 + (r_pool or 0))
        navs_q.append(nav_q); navs_idx.append(nav_idx); navs_fb.append(nav_fb); navs_pool.append(nav_pool)
        if r_idx is not None:
            n_periods += 1
            if r_px > r_idx:
                wins += 1
        rows_out.append({"t0": t0, "t1": t1, "n": len(codes),
                         "pick": [{"code": c, "name": next((x["name"] for x in picked if x["code"] == c), c)} for c in codes],
                         "r": round(r_px * 100, 2), "r_div": round(r_div * 100, 2),
                         "r_idx": round(r_idx * 100, 2) if r_idx is not None else None,
                         "r_fb": round(r_fb * 100, 2) if r_fb is not None else None,
                         "r_pool": round(r_pool * 100, 2) if r_pool is not None else None})
        print(f"  {t0} → {t1}: 组合 {r_px*100:+.1f}% (含分红 {r_div*100:+.1f}%) vs 000922 {r_idx*100:+.1f}%" if r_idx is not None else f"  {t0} → {t1}: 组合 {r_px*100:+.1f}%")

    # ── 指标 ──
    def stats(navs):
        if not navs:
            return {}
        years = (datetime.date(*map(int, q_dates[-1].split("-"))) - datetime.date(*map(int, q_dates[0].split("-")))).days / 365.25
        ann = navs[-1] ** (1 / years) - 1 if navs[-1] > 0 else -1
        peak, mdd = navs[0], 0.0
        for v in navs:
            peak = max(peak, v)
            mdd = min(mdd, v / peak - 1)
        rets = [navs[i] / navs[i - 1] - 1 for i in range(1, len(navs))] if len(navs) > 1 else []
        sharpe = (sum(rets) / len(rets) / (math.sqrt(sum((x - sum(rets) / len(rets)) ** 2 for x in rets) / len(rets)) + 1e-12) * math.sqrt(4)) if rets and len(rets) > 1 else None
        return {"years": round(years, 1), "total": round((navs[-1] - 1) * 100, 1), "ann": round(ann * 100, 1),
                "mdd": round(mdd * 100, 1), "sharpe": round(sharpe, 2) if sharpe else None}
    st_q, st_idx, st_fb, st_pool = stats(navs_q), stats(navs_idx), stats(navs_fb), stats(navs_pool)
    # 平均换手率（相邻期持仓重叠度）
    turn = []
    for i in range(1, len(rows_out)):
        a = {x["code"] for x in rows_out[i - 1]["pick"]}
        b = {x["code"] for x in rows_out[i]["pick"]}
        turn.append(1 - len(a & b) / max(1, len(a)))
    avg_turn = sum(turn) / len(turn) if turn else 0.0

    print("\n═══ 结果 ═══")
    print(f"  组合(TOP20):      {st_q}")
    print(f"  000922 基准:      {st_idx}")
    print(f"  旧人工20只:       {st_fb}")
    print(f"  候选池等权:       {st_pool}")
    print(f"  季度胜率(组合vs基准): {wins}/{n_periods} = {100*wins/n_periods:.0f}%")

    # ── 报告与产物 ──
    lines = []
    lines.append("# 组合回测报告：推荐20量化选股（历史验证）")
    lines.append("")
    lines.append(f"> 生成日期：{datetime.date.today()} ｜ 区间：{q_dates[0]} ~ {q_dates[-1]}（{len(q_dates)-1} 期）｜ 调仓：季度末｜ 持仓：TOP20 等权")
    lines.append("> 选股：与线上推荐评分同构（硬过滤 dy≥3.0% + 60日均额≥3000万；三组10因子；均衡档权重；行业≤4 + 四象限各≥3），因子均取调仓日及以前数据（无未来函数）")
    lines.append("> 收益口径：价格口径（主）；含现金分红口径（期内除权派息/期初价，不复投，附注）")
    lines.append("> 局限：成分股幸存者偏差（仅回测当前池内股票）；基准为价格口径未含分红；早期部分股票成交额缺失时跳过流动性过滤")
    lines.append("")
    lines.append("## 一、总览")
    lines.append("")
    lines.append("| 组合 | 累计 | 年化 | 最大回撤 | 夏普(季度) | 季度胜率(超基准) |")
    lines.append("|---|---|---|---|---|---|")
    lines.append(f"| **TOP20（量化）** | {st_q['total']}% | {st_q['ann']}% | {st_q['mdd']}% | {st_q['sharpe']} | {wins}/{n_periods}（{100*wins/n_periods:.0f}%） |")
    lines.append(f"| 000922 中证红利 | {st_idx['total']}% | {st_idx['ann']}% | {st_idx['mdd']}% | {st_idx['sharpe']} | — |")
    lines.append(f"| 旧人工20只（固定） | {st_fb['total']}% | {st_fb['ann']}% | {st_fb['mdd']}% | {st_fb['sharpe']} | — |")
    lines.append(f"| 候选池等权 | {st_pool['total']}% | {st_pool['ann']}% | {st_pool['mdd']}% | {st_pool['sharpe']} | — |")
    lines.append("")
    lines.append(f"**量化 TOP20 vs 基准：累计超额 {st_q['total']-st_idx['total']:+.1f}pp（年化 {st_q['ann']-st_idx['ann']:+.1f}pp）；vs 旧人工20只：{st_q['total']-st_fb['total']:+.1f}pp**")
    lines.append("")
    lines.append("## 二、逐期明细（组合 vs 基准）")
    lines.append("")
    lines.append("| 调仓日 | 持仓数 | 组合(%) | 含分红(%) | 000922(%) | 旧人工20(%) | 候选池(%) |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in rows_out:
        lines.append(f"| {r['t0']} | {r['n']} | {r['r']:+.1f} | {r['r']+r['r_div']:+.1f} | "
                     f"{r['r_idx']:+.1f} | {r['r_fb']:+.1f} | {r['r_pool']:+.1f} |")
    lines.append("")
    lines.append("## 三、说明")
    lines.append("")
    lines.append(f"- 每期持仓明细见 `web/data/portfolio_backtest.json`（pick 字段，含全部 {len(rows_out)} 期 TOP20 清单）；平均每期换手 {avg_turn*100:.0f}%")
    lines.append(f"- **交易成本**：季度换仓按单边 0.1% 佣金+冲击估算，{len(rows_out)} 期累计约 {avg_turn*20*0.002*len(rows_out):.0f}pp（未计入上表）；旧人工20只固定持有几乎零换仓——量化 vs 固定清单的差额需扣除该成本后看待")
    lines.append("- 本报告验证的是**选股逻辑**（哪些股票入选）而非择时（何时买卖）；择时有效性见《回测报告.md》")
    lines.append("- 历史统计结果，非投资建议")
    lines.append("")
    with open(os.path.join(BASE, "docs", "组合回测报告.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.makedirs(os.path.join(BASE, "web", "data"), exist_ok=True)
    out = {"date": str(datetime.date.today()), "start": q_dates[0], "end": q_dates[-1],
           "periods": rows_out,
           "stats": {"top20": st_q, "idx": st_idx, "fallback": st_fb, "pool": st_pool},
           "wins": wins, "n_periods": n_periods}
    atomic_dump(os.path.join(BASE, "web", "data", "portfolio_backtest.json"), out)
    print("\n✅ docs/组合回测报告.md + web/data/portfolio_backtest.json 已生成")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=Q_START)
    args = ap.parse_args()
    main(start=args.start)
