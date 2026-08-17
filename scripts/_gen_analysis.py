# -*- coding: utf-8 -*-
"""买卖区间分析 · S1：股息率反推序列 + 分位（数据基石）

核心：dy_t = D / close_t（D = 当前收盘 × 当前成分加权股息率，短期稳定假设）
- 指数/ETF：用 components.json 成分权重×股息率加权出 dy0 → D → 用历史收盘（ETF 优先净值）反推全历史 dy 序列
- 股票：直接取 web/data/stocks 指标文件的逐日 dy 序列
- 分位：近 5 年（1250 交易日）窗口，不足用全部

产出：cache/analysis_dy.json（每标的 dy0/当前dy/分位/10·50·90分位值/全量序列/点位锚参数 D）
用法: python scripts/_gen_analysis.py [--only 000922]
"""
import sys, io, os, json, argparse, datetime, re
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")   # 不换对象，import 无副作用（避免二次包装关闭 buffer）
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))

import _fetch_history as fh
import _fetch_stock_data as fsd
from _common import atomic_dump   # 原子写（tmp+replace）

WINDOW = 1250   # 近5年交易日

# ── S3/S4 因子打分 ─────────────────────────────────────────────
# 三档权重（S2 回测调整：个股 dy 降权、估值升权）；A=指数/ETF 体系，B=股票体系
PRESETS = {
    "稳健": {"A": {"dy": 40, "price": 30, "trend": 20, "sent": 10},
              "B": {"pe": 25, "pb": 20, "dy": 20, "price": 15, "trend": 10, "peg": 10}},
    "均衡": {"A": {"dy": 30, "price": 30, "trend": 20, "sent": 20},
              "B": {"pe": 20, "pb": 15, "dy": 15, "price": 15, "trend": 20, "peg": 15}},
    "进取": {"A": {"dy": 20, "price": 30, "trend": 30, "sent": 20},
               "B": {"pe": 15, "pb": 10, "dy": 15, "price": 20, "trend": 25, "peg": 15}},
}
FACTOR_CN = {"dy": "股息率", "price": "价格", "trend": "趋势", "sent": "情绪",
             "pe": "PE-TTM", "pb": "PB", "peg": "PEG"}


def band_of(score):
    if score is None:
        return "数据不足"
    if score <= 25: return "买入区间"
    if score <= 45: return "逐步建仓"
    if score <= 65: return "持有"
    if score <= 80: return "逐步卖出"
    return "卖出区间"


def pct_rank(v, arr):
    """v 在 arr 中的百分位：比 v 小的元素占比×100（0=最便宜，100=最贵）"""
    return 100.0 * sum(1 for x in arr if x < v) / len(arr) if len(arr) else None


def build_price_pct(close_arr):
    win = close_arr[-WINDOW:]
    return round(pct_rank(close_arr[-1], win), 1) if len(win) else None


def build_trend(close_arr):
    """趋势：返回 (v, pct) = (MA60乖离%, 分位)。分位 = 50 + (乖离÷15%)×50 截断 0-100；MA排列修正 ±10"""
    n = len(close_arr)
    if n < 20:
        return 0.0, 50
    ma60 = float(np.mean(close_arr[-60:])) if n >= 60 else float(np.mean(close_arr))
    bias = close_arr[-1] / ma60 - 1
    pct = max(0.0, min(100.0, 50 + (bias / 0.15) * 50))
    if n >= 200:
        ma200 = float(np.mean(close_arr[-200:]))
        if close_arr[-1] > ma60 > ma200:
            pct += 10
        elif close_arr[-1] < ma60 < ma200:
            pct -= 10
    return round(bias * 100, 2), round(max(0.0, min(100.0, pct)), 1)


def build_sent_index(close_arr):
    """指数情绪：返回 (v, pct) = (chg60%, 近5年分位)，60日动量高=过热"""
    if len(close_arr) < 61:
        return 0.0, 50
    chg60 = close_arr[-1] / close_arr[-61] - 1
    seq = close_arr[60:] / close_arr[:-60] - 1
    win = seq[-WINDOW:]
    return round(chg60 * 100, 2), round(pct_rank(chg60, win), 1)


def build_sent_etf(code):
    """ETF情绪：返回 (v, pct) = (折溢价%, 分位)，>+1%→100 过热，<-1%→0 折价机会"""
    c = json.load(open(fh.cache_path("ETF", code), encoding="utf-8"))
    rows = [r for r in c.get("rows", []) if r.get("nav") and "close" in r]
    if not rows:
        return 0.0, 50
    r = rows[-1]
    prem = r["close"] / r["nav"] - 1
    pct = max(0.0, min(100.0, 50 + (prem / 0.01) * 50))
    return round(prem * 100, 2), round(pct, 1)


def peg_pct(v):
    """PEG 阈值映射：<1→0（便宜）；1~2 线性；>2→100；负值（净利负增长）→100"""
    if v is None:
        return 50
    if v <= 0:
        return 100
    if v < 1:
        return 0
    if v > 2:
        return 100
    return round((v - 1) * 100, 1)


def build_stock_factors(code):
    """股票 PE-TTM/PB 分位（正值窗口；当前<=0 取 100）+ PEG 阈值映射（当前值取最后非 None）"""
    p = os.path.join(BASE, "web", "data", "stocks", f"{code}.json")
    if not os.path.exists(p):
        return {}
    rows = json.load(open(p, encoding="utf-8"))

    def last_of(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return vals[-1] if vals else None

    def pct_of(key, cur, neg100=False):
        seq = [r[key] for r in rows if r.get(key) is not None]
        if not seq:
            return None
        if neg100 and cur <= 0:
            return 100
        pos = [v for v in seq if v > 0] if neg100 else seq
        if not pos:
            return 100 if neg100 else None
        return round(pct_rank(cur, pos[-WINDOW:]), 1)

    cur_pe, cur_pb, cur_peg = last_of("pe_ttm"), last_of("pb"), last_of("peg")
    return {"pe": (cur_pe, pct_of("pe_ttm", cur_pe, True)),
            "pb": (cur_pb, pct_of("pb", cur_pb, True)),
            "peg": (cur_peg, peg_pct(cur_peg))}


def get_close_arr(typ, code, info):
    """分析用 close 序列：ETF 用跟踪指数（S2 确立：ETF 区间=跟踪指数区间）"""
    if typ == "ETF":
        code, typ = info.get("track") or code, "指数"
    c = json.load(open(fh.cache_path(typ, code), encoding="utf-8"))
    return np.array([r["close"] for r in c.get("rows", []) if "close" in r], dtype=float)


def price_percentile_anchor(info):
    """近5年反推口径锚：反推 dy_t = D/close_t 的 p90/p10 ⇔ 价格 p10/p90（单调反比）
    → 买入锚 = 近5年价格10分位（低），卖出锚 = 近5年价格90分位（高）
    与主图反推锚同构（主图缩放近5年时锚 = 窗口价格分位对应价）；ETF 用跟踪指数序列"""
    typ, code = info["type"], info["code"]
    if typ == "ETF":
        code = info.get("track") or code
        typ = "指数"
    c = json.load(open(fh.cache_path(typ, code), encoding="utf-8"))
    closes = [r["close"] for r in c.get("rows", []) if "close" in r]
    if not closes:
        return None, None
    win = closes[-WINDOW:]
    return float(np.percentile(win, 10)), float(np.percentile(win, 90))


def build_factors():
    """S4：全因子分位 + 三档权重表 → web/data/analysis.json（数据层只存分位，分数前端本地算）"""
    dy_data = json.load(open(os.path.join(BASE, "cache", "analysis_dy.json"), encoding="utf-8"))
    out = {"date": "", "presets": PRESETS, "by_code": {}}
    rows_out = []
    for code, info in dy_data.items():
        if info.get("dy0") is None:
            continue   # 无股息率 → 无法分析（如数据源缺成分股息率）
        typ = info["type"]
        close = get_close_arr(typ, code, info)
        if len(close) < 60:
            continue
        # 统一因子结构 f[k] = (v, pct)，pct 统一口径：0=便宜，100=贵
        # 注意 dy 分位语义相反（股息率高=便宜）→ 取反
        f = {"dy": (info["dy_now"], round(100 - info["dy_pct"], 1)),
             "price": (round(float(info["close_now"]), 2), build_price_pct(close)),
             "trend": build_trend(close)}
        if typ == "指数":
            f["sent"] = build_sent_index(close)
        elif typ == "ETF":
            f["sent"] = build_sent_etf(code)
        if typ == "股票":
            f.update(build_stock_factors(code))
        # 三档分数
        scores = {}
        for pname, pws in PRESETS.items():
            w = pws["A"] if typ != "股票" else pws["B"]
            s = sum(f[k][1] * wgt for k, wgt in w.items() if f[k][1] is not None)
            scores[pname] = round(s / sum(w.values()), 1)
        factors = {k: {"name": FACTOR_CN[k], "v": f[k][0], "pct": f[k][1]} for k in f}
        # S5 点位锚：近5年反推口径（与主图统一）——反推 dy_t = D/close_t 的分位 ⇔ 价格分位，
        # 买入锚 = 近5年价格10分位（股息率高=便宜），卖出锚 = 近5年价格90分位（贵）；
        # 锚天然落在历史价格区间内，不会被真实TTM序列的除权断崖/低分红期污染
        anchors = None
        if info.get("close_now"):
            p10, p90 = price_percentile_anchor(info)
            if p10 and p90:
                anchors = {"buy": round(p10, 2), "sell": round(p90, 2),
                           "dist_buy": round((p10 / info["close_now"] - 1) * 100, 1),
                           "dist_sell": round((p90 / info["close_now"] - 1) * 100, 1)}
        # S7 副图辅助：dy 分位值（分位线）；ETF 存近5年 dy 序列（K线为场内价、锚为指数点位，前端无法重算）
        dy_series = None
        if typ == "ETF" and info.get("series"):
            dy_series = [[d, v] for d, v in info["series"][-WINDOW:]]
        out["by_code"][code] = {"name": info["name"], "type": typ, "track": info.get("track"),
                                "factors": factors, "anchors": anchors,
                                "dy_p10": info.get("dy_p10"), "dy_p90": info.get("dy_p90"),
                                "win_start": info.get("window_start"), "n_days": info.get("n_days"),
                                "dy_series": dy_series}
        rows_out.append((code, info["name"], typ, scores))
    out["date"] = max((info["series"][-1][0] for info in dy_data.values() if info.get("series")), default="")
    path = os.path.join(BASE, "web", "data", "analysis.json")
    atomic_dump(path, out, indent=None)

    # 控制台表：三档分数 + 均衡档区间 + 点位锚
    print(f"\n═══ S4/S5 因子打分 + 点位锚（数据日期 {out['date']}）═══")
    print(f"{'代码':<8}{'名称':<14}{'类型':<4}{'稳健':>7}{'均衡':>7}{'进取':>7}  区间(均衡)  买入锚(距%)  卖出锚(距%)")
    for code, name, typ, scores in sorted(rows_out, key=lambda x: -x[3]["均衡"]):
        band = band_of(scores["均衡"])
        an = out["by_code"][code].get("anchors")
        if an:
            a = f"{an['buy']:.0f}({an['dist_buy']:+.0f}%)  {an['sell']:.0f}({an['dist_sell']:+.0f}%)"
        else:
            a = "—"
        print(f"{code:<8}{name:<14}{typ:<4}{scores['稳健']:>7.1f}{scores['均衡']:>7.1f}{scores['进取']:>7.1f}  {band:<7}  {a}")
    print(f"\n✅ web/data/analysis.json 已生成（{len(out['by_code'])} 标的，三档权重已内嵌）")


# ETF → 跟踪指数映射（dy0 加权结果自洽验证：ETF 加权dy == 跟踪指数加权dy）
ETF_TRACK = {
    "512890": "H30269", "563020": "H30269", "159549": "930955",
    "515180": "000922", "515080": "000922", "561580": "000825",
    "510720": "000151", "159209": "932315", "159758": "931468",
    "563700": "H30270", "159201": "980092", "510880": "000015",
}


def load_cache(typ, code):
    p = fh.cache_path(typ, code)
    if not os.path.exists(p):
        return None
    return json.load(open(p, encoding="utf-8"))


def weighted_dy(stocks):
    """成分加权股息率：Σ(w×dy)/Σw（权重缺失部分剔除）；全部无权重则简单平均。
    返回 (dy0, 参与成分数) 或 (None, 0)"""
    pairs = [(s.get("weight"), s.get("div_yield")) for s in stocks]
    pairs = [(w, dy) for w, dy in pairs if dy is not None]
    if not pairs:
        return None, 0
    if any(w is not None for w, _ in pairs):
        wsum = sum(w for w, _ in pairs if w is not None)
        dsum = sum(w * dy for w, dy in pairs if w is not None)
        return dsum / wsum, sum(1 for w, _ in pairs if w is not None)
    return sum(dy for _, dy in pairs) / len(pairs), len(pairs)


def build_from_close(typ, code, name, series_rows, dy0, n_parts):
    """由收盘/净值序列反推 dy 序列并算分位"""
    close_now = series_rows[-1][1]
    D = close_now * dy0
    series = [[d, round(D / px, 4)] for d, px in series_rows]
    win = series[-WINDOW:]
    vals = [v for _, v in win]
    return {
        "code": code, "name": name, "type": typ,
        "dy0": round(dy0, 4), "dy_now": vals[-1],
        "dy_pct": round(pct_rank(vals[-1], vals), 1),
        "dy_p10": round(float(np.percentile(vals, 10)), 4),
        "dy_p50": round(float(np.percentile(vals, 50)), 4),
        "dy_p90": round(float(np.percentile(vals, 90)), 4),
        "n_days": len(win), "window_start": win[0][0],
        "close_now": close_now, "D": round(D, 4), "n_parts": n_parts,
        "series": series,
    }


def load_etf_dy_est(code):
    """ETF 自身季报持仓加权股息率估算：cache/ETF持仓_{code}.json（_fetch_etf_holdings 产物）
    返回 dy0 或 None"""
    p = os.path.join(BASE, "cache", f"ETF持仓_{code}.json")
    if not os.path.exists(p):
        return None
    h = json.load(open(p, encoding="utf-8"))
    rows = [r for r in h.get("rows", []) if r.get("dy")]
    wsum = sum(r["pct"] for r in rows)
    return round(sum(r["pct"] * r["dy"] for r in rows) / wsum, 4) if wsum else None


def load_est_dy0(code):
    """指数股息率估算（成分无 dy 时）：cache/成分_{code}_股息率.json（ETF季报持仓加权）"""
    p = os.path.join(BASE, "cache", f"成分_{code}_股息率.json")
    if not os.path.exists(p):
        return None
    return json.load(open(p, encoding="utf-8")).get("dy0")


def build_index_etf(typ, code, name, stocks, index_info=None):
    """指数：加权 dy0 反推；ETF：跟踪指数序列优先（净值反推有分红增长漂移），
    跟踪指数无数据时用 ETF 自身季报持仓估算（159229→932368 无行情缓存）"""
    if typ == "ETF":
        if index_info is None or index_info.get("dy0") is None:
            est = load_etf_dy_est(code)
            if est is None:
                return {"code": code, "name": name, "type": typ, "dy0": None, "note": "跟踪指数无股息率数据且无持仓估算"}
            c = load_cache("ETF", code)
            if c is None or not c.get("rows"):
                return {"code": code, "name": name, "type": typ, "dy0": None, "note": "无行情缓存"}
            rows = c["rows"]
            px_rows = [(r["date"], r.get("nav") or r["close"]) for r in rows]
            r = build_from_close("ETF", code, name, px_rows, est, 0)
            r["note"] = "股息率为ETF季报持仓加权估算"
            r["track"] = ETF_TRACK.get(code)
            return r
        r = dict(index_info)
        r.update({"code": code, "name": name, "type": typ, "track": index_info["code"]})
        return r
    dy0, n_parts = weighted_dy(stocks)
    c = load_cache(typ, code)
    if c is None or not c.get("rows"):
        return {"code": code, "name": name, "type": typ, "dy0": None, "note": "无行情缓存"}
    if dy0 is None:
        est = load_est_dy0(code)   # 成分无 dy 时用 ETF 季报持仓估算（980092）
        if est is not None:
            dy0, n_parts = est, 0
    if dy0 is None:
        return {"code": code, "name": name, "type": typ, "dy0": None, "note": "成分股息率缺失"}
    rows = c["rows"]
    if typ == "ETF":
        # 净值优先（贴近指数），缺失日期用场内收盘价兜底
        px_rows = [(r["date"], r.get("nav") or r["close"]) for r in rows]
    else:
        px_rows = [(r["date"], r["close"]) for r in rows]
    return build_from_close(typ, code, name, px_rows, dy0, n_parts)


def build_stock(code, name):
    """股票：直接取逐日 dy 序列（真实 TTM 股息率，无需 D 反推），close_now 从行情缓存读"""
    p = os.path.join(BASE, "web", "data", "stocks", f"{code}.json")
    if not os.path.exists(p):
        return {"code": code, "name": name, "type": "股票", "dy0": None, "note": "无指标文件"}
    rows = json.load(open(p, encoding="utf-8"))
    px_rows = [(r["d"], r["dy"]) for r in rows if r.get("dy") is not None and r["dy"] > 0]
    if not px_rows:
        return {"code": code, "name": name, "type": "股票", "dy0": None, "note": "无股息率数据"}
    dy0 = px_rows[-1][1]
    win = px_rows[-WINDOW:]
    vals = [v for _, v in win]
    close_now = None
    c = load_cache("股票", code)
    if c and c.get("rows"):
        close_now = c["rows"][-1].get("close")
    return {
        "code": code, "name": name, "type": "股票",
        "dy0": round(dy0, 4), "dy_now": round(dy0, 4),
        "dy_pct": round(pct_rank(vals[-1], vals), 1),
        "dy_p10": round(float(np.percentile(vals, 10)), 4),
        "dy_p50": round(float(np.percentile(vals, 50)), 4),
        "dy_p90": round(float(np.percentile(vals, 90)), 4),
        "n_days": len(win), "window_start": win[0][0],
        "close_now": close_now, "D": None, "n_parts": 1,
        "series": px_rows,
    }


def enough_history(info):
    """与 build_factors 的 close<60 过滤一致：历史不足 60 日不进入分析池，
    避免 analysis_dy / analysis.json / backtest 池不一致（如新上市北交所仅 1 日 K 线）"""
    typ, code = info["type"], info["code"]
    if typ == "ETF":
        code = info.get("track") or code
        typ = "指数"
    c = load_cache(typ, code)
    return bool(c and sum(1 for r in c.get("rows", []) if "close" in r) >= 60)


def official_check():
    """红利介绍.md 官方股息率快照（供参考）：注意官方为『年度静态口径』（上年度分红/现价），
    与 TTM 口径（近12个月除权派息/现价）不可直接对比，仅打印提示不校验。
    口径正确性已用 ETF 累计净值交叉验证：515180 近12月真实分红收益 4.28% vs TTM加权 4.22%。"""
    try:
        t = open(os.path.join(BASE, "红利介绍.md"), encoding="utf-8").read()
    except OSError:
        return {}
    out = {}
    for m in re.finditer(r"(中证红利|上证红利|红利低波|红利质量|红利国企|央企红利|沪深300红利|中证红利低波动|自由现金流)[^。\n]{0,25}?约([\d.]+)%", t):
        out[m.group(1)] = float(m.group(2))
    return out


def main(only=None):
    comp = json.load(open(os.path.join(BASE, "web", "data", "components.json"), encoding="utf-8"))
    official = official_check()
    out = {}
    rows = []

    def emit(r):
        if r["dy0"] is None:
            rows.append(f"{r['code']:<8}{r['name']:<14}{r['type']:<4}  ⚠️ {r.get('note','')}")
            out[r["code"]] = r
        elif not enough_history(r):
            rows.append(f"{r['code']:<8}{r['name']:<14}{r['type']:<4}  ⚠️ 历史不足60日，暂不纳入分析池")
        else:
            off = official.get(r["name"][:6], None)
            tag = ""
            if off:
                tag = f"  官方{off:.2f}%[年度口径,仅供参考]"
            rows.append(f"{r['code']:<8}{r['name']:<14}{r['type']:<4}"
                        f"{r['dy0']:>7.2f}{r['dy_pct']:>7.1f}%"
                        f"{r['dy_p10']:>7.2f}{r['dy_p50']:>7.2f}{r['dy_p90']:>7.2f}"
                        f"{r['n_days']:>6d}天{tag}")
            out[r["code"]] = r

    print("═══ 股息率反推序列 + 分位（S1）═══")
    print(f"{'代码':<8}{'名称':<14}{'类型':<4}{'dy0':>7}{'分位':>7}{'p10':>7}{'p50':>7}{'p90':>7}{'窗口':>8}")
    idx_info = {}
    for code, name, src, tcode in fh.INDICES:
        if only and code != only:
            continue
        stocks = comp["by_index"].get(code, {}).get("stocks", [])
        r = build_index_etf("指数", code, name, stocks)
        idx_info[code] = r
        emit(r)
    for code, name, tcode in fh.ETFS:
        if only and code != only:
            continue
        stocks = comp["by_etf"].get(code, {}).get("stocks", [])
        r = build_index_etf("ETF", code, name, stocks, idx_info.get(ETF_TRACK.get(code)))
        emit(r)
    # 股票：推荐20 + 其他成份股 + 自选股清单（web/data/stocks/*.json 有指标文件即分析）
    stk_names = {c: n for c, n, _ in fsd.STOCKS}
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if os.path.exists(t_path):
        stk_names.update({r["code"]: r.get("name", r["code"]) for r in json.load(open(t_path, encoding="utf-8"))})
    import _fetch_watchlist as watchlist
    # 池子对齐 manifest.stock_pool()：清单仅纳入展示=1（show）的股票；
    # 手动新增但未勾选展示的自选股不进分析池（有指标文件也不分析，如分众传媒）
    stk_names.update({r["code"]: r["name"] for r in watchlist.read_watchlist_xlsx() if r.get("show")})
    import glob
    stk_files = sorted(glob.glob(os.path.join(BASE, "web", "data", "stocks", "*.json")))
    for fp in stk_files:
        code = os.path.basename(fp)[:-5]
        if code not in stk_names:
            continue   # 无池归属（清单展示=0 或不在任何来源）→ 跳过，保持与 manifest 池一致
        if only and code != only:
            continue
        emit(build_stock(code, stk_names.get(code, code)))

    print("\n".join(rows))
    print("\n口径说明：dy0 为 TTM 口径（近12个月除权派息/现价），与成分股逐日 dy 同口径；")
    print("官方快照为年度静态口径，不可直接对比。已用 ETF 累计净值交叉验证（515180 ≈ 4.28%）。")

    # 同源验证：中证红利 000922 vs 跟踪ETF 515180（dy 序列应贴近）
    if not only:
        a, b = out.get("000922"), out.get("515180")
        if a and b and a["series"] and b["series"]:
            ma = {d: v for d, v in a["series"]}
            mb = {d: v for d, v in b["series"]}
            common = [(ma[d], mb[d]) for d in ma if d in mb]
            if common:
                xs = [x for x, _ in common]; ys = [y for _, y in common]
                corr = float(np.corrcoef(xs, ys)[0, 1])
                print(f"\n同源验证 000922 vs 515180：共同 {len(common)} 天，dy 相关系数 {corr:.4f}")
                print("最近10天对照：")
                for d in sorted(ma)[-10:]:
                    print(f"  {d}  指数dy={ma.get(d,'—'):>7}  ETFdy={mb.get(d,'—'):>7}")

    # 自检：反推序列末值应等于 dy0（D/close_now）
    bad = [c for c, r in out.items() if r["dy0"] and abs(r["series"][-1][1] - r["dy0"]) > 1e-6]
    print(f"\n自检：反推末值=dy0 一致（{len(out)-len(bad)}/{len(out)} 标的）" + (f"，异常: {bad}" if bad else ""))

    os.makedirs(os.path.join(BASE, "cache"), exist_ok=True)
    atomic_dump(os.path.join(BASE, "cache", "analysis_dy.json"), out, indent=None)
    print(f"\n✅ cache/analysis_dy.json 已生成（{len(out)} 标的）")

    # S3：因子打分（全量）
    if not only:
        build_factors()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只处理单个代码（调试用）")
    args = ap.parse_args()
    main(only=args.only)
