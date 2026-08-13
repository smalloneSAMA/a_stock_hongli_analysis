# -*- coding: utf-8 -*-
"""推荐 20 只量化评分（v1：硬过滤 + 三组因子 + 组合约束）

范围：成分股 + 自选股（manifest 全池，ready 且过过滤者进入候选池）
硬过滤（一票否决）：
  1. 名称含 ST/*ST
  2. ready=false（K线未拉取成功）
  3. 股息率 < 3.5%（指标文件末行 dy）
  4. 近 60 日均成交额 < 3000 万元（K线 amount，元）
  5. 分红断档：近 3 个年度派息 < 2 次（分红缓存，无缓存视为通过并标记）

评分（百分制，池内分位 = 候选池内的 rank 百分位）：
  A 价值组（均衡 30%）：A1 股息率 30% | A2 dy 历史分位 35% | A3 估值 35%（PE/PB 池内分位取反）
  B 质量组（均衡 40%）：B1 ROE 水平 30% | B2 ROE 稳定性 30%（近12期CV）| B4 分红率 20%（TTM派息/年报eps，20-70%最优）
                        B5 分红趋势 20%（TTM 派息同比，tanh 映射，负增长重罚）
  C 行为组（均衡 30%）：C1 趋势 40%（analysis trend 分位）| C2 波动率 30%（250日std，低波高分）
                        C3 动量 30%（60日涨幅，追高惩罚）
  三档权重：稳健(40/40/20) 均衡(30/40/30) 进取(20/30/50)；缺失因子跳过并按剩余权重归一化

组合约束（TOP20）：单行业 ≤ 3 只；四象限（金融/防御/周期/消费）各 ≥ 3 只
产物：cache/_推荐20.json（单一事实来源，含因子明细/TOP30/排除清单/版本日期）
用法: python scripts/_recommend_stocks.py [--top 20] [--no-write]
"""
import sys, os, json, math, argparse, datetime

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _fetch_stock_data as fsd

OUT = os.path.join(BASE, "cache", "_推荐20.json")
DY_MIN = 3.0          # 股息率门槛（%）；dy∈[3.0,3.5) 为临界纳入（标记 near）
DY_NEAR = 3.5        # 临界上界（%）
AMT_MIN = 3e7         # 近60日均成交额门槛（元，3000万）
VOL_DAYS = 250        # 波动率窗口
MOM_DAYS = 60         # 动量窗口
AMT_DAYS = 60         # 流动性窗口

# 四象限（一级行业 → 象限）
QUADRANT = {}
for ind in ("银行", "非银金融"):
    QUADRANT[ind] = "金融"
for ind in ("公用事业", "交通运输", "环保"):
    QUADRANT[ind] = "防御"
for ind in ("煤炭", "钢铁", "石油石化", "有色金属", "基础化工", "建筑材料", "建筑装饰", "机械设备"):
    QUADRANT[ind] = "周期"
for ind in ("食品饮料", "家用电器", "医药生物", "传媒", "商贸零售", "纺织服饰", "汽车",
            "农林牧渔", "轻工制造", "美容护理", "社会服务", "综合", "房地产", "电力设备"):
    QUADRANT[ind] = "消费"

WEIGHTS = {
    "稳健": {"A": 40, "B": 40, "C": 20},
    "均衡": {"A": 30, "B": 40, "C": 30},
    "进取": {"A": 20, "B": 30, "C": 50},
}
FACTOR_W = {"A": {"A1": .30, "A2": .35, "A3": .35},
            "B": {"B1": .30, "B2": .30, "B4": .20, "B5": .20},
            "C": {"C1": .40, "C2": .30, "C3": .30}}


def load_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def pct_rank(v, arr):
    """v 在 arr 中的百分位 0-100（v 越小分越低）"""
    if v is None or not arr:
        return None
    return sum(1 for x in arr if x <= v) / len(arr) * 100




def annual_div(code_dc):
    """按 ex_date 年份聚合年度每股派息（元/股），返回 {年: 金额}；
    年度口径避免 TTM 截断/特别分红误判（神华 2025 特别分红 22.6 元/10股 使 TTM 同比大跌）"""
    if not code_dc:
        return None
    by = {}
    for r in code_dc["rows"]:
        y = r["ex_date"][:4]
        by[y] = by.get(y, 0) + r["bonus10"] / 10.0
    return by


def latest_full_year(by):
    """最新完整年度（ex_date 年份 < 当前年份 的最大年）"""
    cur = int(datetime.date.today().strftime("%Y"))
    ys = [int(y) for y in by if int(y) < cur]
    return str(max(ys)) if ys else None


def latest_annual_eps(fc):
    """最新年报 eps 与 roe（report_date 含 12-31 的最近一期）——年报口径跨行业可比（银行 Q1 roe 占比高）"""
    if not fc:
        return None, None
    for r in fc["rows"]:
        if r.get("report_date", "").endswith("12-31") and r.get("eps"):
            return r["eps"], r.get("roe")
    return None, None


def roe_stability(fc):
    """近 12 期 roe 变异系数 → 100×(1-CV)；不足 8 期返回 None"""
    if not fc:
        return None
    roes = [r["roe"] for r in fc["rows"][:12] if r.get("roe") is not None]
    if len(roes) < 8:
        return None
    mean = sum(roes) / len(roes)
    if mean <= 0:
        return None
    sd = math.sqrt(sum((x - mean) ** 2 for x in roes) / len(roes))
    return 100 * max(0.0, 1 - sd / mean)


def div_years_count(dc):
    """近 3 个年度（ex_date 年份，由今日推导——勿硬编码年份，曾致 2027 起静默失真）派息年数"""
    if not dc:
        return None
    by = {}
    for r in dc["rows"]:
        by[r["ex_date"][:4]] = by.get(r["ex_date"][:4], 0) + 1
    cur = int(datetime.date.today().strftime("%Y"))
    years = [str(cur - i) for i in range(3)]
    return sum(1 for y in years if by.get(y))


def build_factors(codes, meta):
    """计算全部候选股票的因子原始值（池内分位在候选池确定后统一算）"""
    an = load_json(os.path.join(BASE, "web", "data", "analysis.json")) or {}
    by_an = an.get("by_code", {})
    raw = {}
    for code in codes:
        m = meta[code]
        ind = load_json(os.path.join(BASE, "web", "data", "stocks", f"{code}.json"))
        last = ind[-1] if ind else {}
        kline = load_json(os.path.join(BASE, "cache", f"股票_{code}.json"))
        rows = (kline or {}).get("rows", [])
        dc = load_json(os.path.join(BASE, "cache", f"分红_{code}.json"))
        fc = load_json(os.path.join(BASE, "cache", f"财报_{code}.json"))
        f = (by_an.get(code) or {}).get("factors", {})
        # 波动率/动量/流动性（K线本地算）
        vol = mom = amt = None
        closes = [r["close"] for r in rows if r.get("close") is not None]
        if len(closes) >= VOL_DAYS:
            rets = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - VOL_DAYS, len(closes))]
            mean = sum(rets) / len(rets)
            vol = math.sqrt(sum((x - mean) ** 2 for x in rets) / len(rets))
        if len(closes) >= MOM_DAYS + 1:
            mom = (closes[-1] / closes[-MOM_DAYS - 1] - 1) * 100
        amts = [r["amount"] for r in rows[-AMT_DAYS:] if r.get("amount") is not None]
        if amts:
            amt = sum(amts) / len(amts)
        raw[code] = {
            "A1": last.get("dy"),
            "A2": (f.get("dy") or {}).get("pct"),
            "pe": last.get("pe_ttm"), "pb": last.get("pb"),
            "B1": None, "B2": roe_stability(fc),
            "B4": None, "B5": None,
            "C1": (f.get("trend") or {}).get("pct"),
            "C2": vol, "C3": mom,
            "amt": amt,
            "eps_annual": None, "roe_annual": None,
            "div_years": div_years_count(dc),
        }
        ra_eps, ra_roe = latest_annual_eps(fc)
        raw[code]["eps_annual"], raw[code]["roe_annual"] = ra_eps, ra_roe
        if ra_roe is not None:
            raw[code]["B1"] = ra_roe
        # B4 分红率 / B5 分红趋势（年度口径：最新完整年度 vs 前一年度）
        by = annual_div(dc)
        if by:
            fy = latest_full_year(by)
            if fy:
                cur_y = by[fy]
                if raw[code]["eps_annual"]:
                    pr = cur_y / raw[code]["eps_annual"] * 100
                    # 分红率 >150% 疑似财报/分红数据异常（如五粮液 2025 年报 np 缓存失真），置 None 不参与评分
                    raw[code]["B4"] = pr if pr <= 150 else None
                py = str(int(fy) - 1)
                if by.get(py):
                    raw[code]["B5"] = cur_y / by[py] - 1
    return raw


def score_all(codes, meta, raw):
    """候选池内分位 + 三档总分；返回 [(code, scores, factors)] 降序"""
    pool = {c: raw[c] for c in codes}
    # 各因子池内数组（有值者）
    arrs = {}
    for fk in ("A1", "A2", "pe", "pb", "B1", "B2", "B4", "C1", "C2", "C3"):
        arrs[fk] = sorted(v[fk] for v in pool.values() if v[fk] is not None)
    # B5 用 tanh 映射（负增长重罚），不做池内分位
    out = []
    for c in codes:
        r = raw[c]
        fac = {}
        if r["A1"] is not None:
            fac["A1"] = pct_rank(r["A1"], arrs["A1"])
        if r["A2"] is not None:
            fac["A2"] = r["A2"]
        if r["pe"] is not None and arrs["pe"]:
            fac["A3"] = 0.5 * (100 - pct_rank(r["pe"], arrs["pe"])) + 0.5 * (100 - pct_rank(r["pb"], arrs["pb"])) if r["pb"] is not None else None
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
        # 组内加权（缺失归一化）+ 三档总分
        grp = {}
        for g in ("A", "B", "C"):
            wsum = ssum = 0.0
            for fk, w in FACTOR_W[g].items():
                if fk in fac:
                    wsum += w
                    ssum += w * fac[fk]
            grp[g] = ssum / wsum if wsum else None
        scores = {}
        for pname, pw in WEIGHTS.items():
            wsum = ssum2 = 0.0
            for g, w in pw.items():
                if grp[g] is not None:
                    wsum += w
                    ssum2 += w * grp[g]
            scores[pname] = round(ssum2 / wsum, 1) if wsum else None
        out.append((c, scores, grp, fac, meta[c]))
    out.sort(key=lambda x: -(x[1]["均衡"] if x[1]["均衡"] is not None else -1))
    return out


def apply_constraints(ranked, top=20):
    """组合约束：行业 ≤4；四象限（金融/防御/周期/消费）各 ≥3（象限保底优先于总分）"""
    picked, backup = [], []
    ind_cnt = {}
    QUADS = ("金融", "防御", "周期", "消费")
    # 第一轮：四象限各保底 3 只（象限内按总分，受行业≤4 限制）
    for q in QUADS:
        got = 0
        for it in ranked:
            if got >= 3:
                break
            c, scores, grp, fac, m = it
            if QUADRANT.get(m["ind"], "其他") != q:
                continue
            if ind_cnt.get(m["ind"], 0) >= 4:
                continue
            picked.append(it)
            ind_cnt[m["ind"]] = ind_cnt.get(m["ind"], 0) + 1
            got += 1
    # 第二轮：按总分补满 top（行业 ≤4）
    for it in ranked:
        if len(picked) >= top:
            break
        c, scores, grp, fac, m = it
        if any(x[0] == c for x in picked):
            continue
        if ind_cnt.get(m["ind"], 0) >= 4:
            backup.append(it)
            continue
        picked.append(it)
        ind_cnt[m["ind"]] = ind_cnt.get(m["ind"], 0) + 1
    # 剩余全部按总分序进备选
    for it in ranked:
        if not any(x[0] == it[0] for x in picked) and not any(x[0] == it[0] for x in backup):
            backup.append(it)
    # 名单按总分重排（象限保底只决定选谁，不决定排名）
    picked.sort(key=lambda x: -(x[1]["均衡"] if x[1]["均衡"] is not None else -1))
    return picked[:top], backup


def main(top=20, write=True):
    m = load_json(os.path.join(BASE, "web", "data", "manifest.json")) or {}
    stocks = m.get("stocks", [])
    meta = {s["code"]: s for s in stocks}
    rec_now = {c for c, _, _ in fsd.STOCKS}

    print(f"═══ 推荐20量化评分（{datetime.date.today()}，全池 {len(stocks)} 只）═══")
    # ── 硬过滤 ──
    excluded = []
    cands = []
    for s in stocks:
        c = s["code"]
        why = None
        if "ST" in (s.get("name") or ""):
            why = "ST/*ST"
        elif not s.get("ready"):
            why = "K线未就绪"
        elif s.get("last_dy") is None or s["last_dy"] < DY_MIN:
            why = f"股息率 {s.get('last_dy')}% < {DY_MIN}%"
        if why:
            excluded.append({"code": c, "name": s.get("name", c), "reason": why})
        else:
            cands.append(c)
    print(f"硬过滤: 排除 {len(excluded)} 只（{len(cands)} 只进入候选池）")
    for e in excluded[:12]:
        print(f"  ✗ {e['code']} {e['name']}: {e['reason']}")
    if len(excluded) > 12:
        print(f"  … 其余 {len(excluded)-12} 只")

    # ── 因子计算（原始值）──
    raw = build_factors(cands, meta)
    # 流动性过滤（需要 K 线）与分红断档
    cands2 = []
    for c in cands:
        r = raw[c]
        why = None
        if r["amt"] is not None and r["amt"] < AMT_MIN:
            why = f"60日均额 {r['amt']/1e8:.2f}亿 < 3000万"
        elif r["div_years"] is not None and r["div_years"] < 2:
            why = "近3年派息 < 2 次"
        if why:
            excluded.append({"code": c, "name": meta[c].get("name", c), "reason": why})
        else:
            cands2.append(c)
    cands = cands2
    print(f"流动性/分红过滤后候选池: {len(cands)} 只")

    # ── 评分 ──
    ranked = score_all(cands, meta, raw)
    picked, backup = apply_constraints(ranked, top)
    print(f"\n{'排名':<4}{'代码':<8}{'名称':<8}{'行业':<6}{'象限':<4}{'均衡分':<7}{'稳健':<7}{'进取':<7}{'现推荐':<5}")
    print("-" * 66)
    in_rank = {}
    for i, (c, scores, grp, fac, sm) in enumerate(picked, 1):
        tag = "●" if c in rec_now else ""
        in_rank[c] = i
        dy = sm.get('last_dy')
        near = '⚠️' if dy is not None and DY_MIN <= dy < DY_NEAR else ''
        print(f"{i:<5}{c:<9}{sm['name']:<9}{sm.get('ind','?'):<7}{QUADRANT.get(sm.get('ind',''),'其他'):<5}"
              f"{scores['均衡']:<8}{scores['稳健']:<8}{scores['进取']:<8}{tag}{near}")

    # ── 临界备选（dy 3.0~3.5%，放宽门槛可入，按评分排序）──
    near_list = [x for x in ranked if meta[x[0]].get("last_dy") is not None and DY_MIN <= meta[x[0]]["last_dy"] < DY_NEAR]
    if near_list:
        print()
        print("── 临界备选（dy 3.0~3.5%，⚠️ 放宽门槛可入榜）──")
        for i, (c, scores, grp, fac, sm) in enumerate(near_list[:12], 1):
            print(f"  ⚠️ {i:<3}{c:<9}{sm['name']:<9}{sm.get('ind','?'):<7}dy={sm.get('last_dy')}% 均衡{scores['均衡']}")

    # ── 现人工 20 只对比 ──
    all_rank = {c: i for i, (c, *_rest) in enumerate(ranked, 1)}
    print("\n── 现人工 20 只 在评分中的位置 ──")
    for c, _, _ in fsd.STOCKS:
        sm = meta.get(c, {})
        if c in in_rank:
            print(f"  {c} {sm.get('name', c)}: 第 {in_rank[c]} 名（在榜）")
        elif any(x[0] == c for x in backup):
            print(f"  {c} {sm.get('name', c)}: 第 {all_rank.get(c)} 名（备选/约束挤出）")
        elif c in all_rank:
            print(f"  {c} {sm.get('name', c)}: 第 {all_rank[c]} 名（评分落选，未进 TOP30）")
        else:
            why = next((e['reason'] for e in excluded if e['code'] == c), None)
            print(f"  {c} {sm.get('name', c)}: 被过滤（{why or '未知原因'}）")

    # ── 产物 ──
    if write:
        def slim(it, rank):
            c, scores, grp, fac, sm = it
            return {"code": c, "name": sm.get("name", c), "rank": rank,
                    "score": scores["均衡"], "scores": scores, "group": grp, "factors": fac,
                    "ind": sm.get("ind", ""), "quadrant": QUADRANT.get(sm.get("ind", ""), "其他"),
                    "dy": sm.get("last_dy"), "near": bool(sm.get("last_dy") is not None and DY_MIN <= sm["last_dy"] < DY_NEAR)}
        obj = {
            "date": str(datetime.date.today()),
            "factor_date": {"dy": str(datetime.date.today()), "dividend": str(datetime.date.today())},
            "version": 1,
            "weights": WEIGHTS,
            "filters": {"dy_min": DY_MIN, "amt_min": AMT_MIN},
            "list": [slim(it, i) for i, it in enumerate(picked, 1)],
            "backup": [slim(it, len(picked) + i + 1) for i, it in enumerate(backup[:10])],
            "near_backup": [slim((c2, sc2, g2, f2, m2), i + 1) for i, (c2, sc2, g2, f2, m2) in enumerate(ranked)
                             if m2.get("last_dy") is not None and DY_MIN <= m2["last_dy"] < DY_NEAR][:20],
            "excluded": excluded,
        }
        tmp = OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, OUT)
        print(f"\n✅ 产物已写入 {OUT}（TOP{top} + 备选10 + 排除{len(excluded)}）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()
    main(top=args.top, write=not args.no_write)
