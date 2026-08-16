# -*- coding: utf-8 -*-
"""
生成前端展示数据包 web/data/（只读缓存，不触发任何网络拉取）

输出：
- web/data/manifest.json      三类标的清单 + 数据源 + 单位换算因子 + 数据日期（股票池=推荐20+其他成份股，含 rec/ready 标记）
- web/data/stocks/{code}.json 股票池逐日指标（复用 _fetch_stock_data 的 calc_* 口径，与 Excel 完全一致）
- web/data/summary.json       成分股汇总（_成分股汇总表.json + 当日涨跌幅 + 名称）

用法: python scripts/_gen_web_data.py
前置：先运行 update.py 相应选项生成缓存（指数1/ETF2/汇总表4/股票5）
"""
import sys, io, os, json, time

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(BASE, "scripts")
sys.path.insert(0, SCRIPTS)

import _fetch_history as fh
import _fetch_stock_data as fsd
import _fetch_watchlist as watchlist
from _common import atomic_dump

WEB_DATA = os.path.join(BASE, "web", "data")
os.makedirs(os.path.join(WEB_DATA, "stocks"), exist_ok=True)

# 指数单位换算（与 update.py export_excel 同口径）：
# 原始单位：腾讯 volume=手/amount=元(估算)；中证官网 tradingVol=股/tradingValue=亿元；国证 volume=万手/amount=亿元
IDX_DIV = {"tencent": (1e4, 1e8), "csindex": (1e6, 1), "cnindex": (1, 1)}


def last_date(rows):
    return rows[-1]["date"] if rows else None


def ensure_amount_filled(typ, code, obj):
    """与 update.py export_excel 一致：估算成交额（腾讯K线无成交额字段）并写回缓存；
    仅当存在缺失时才写回，避免无意义改写"""
    rows = obj.get("rows", [])
    missing = [r for r in rows if r.get("amount") is None and r.get("volume") and r.get("close")]
    if missing:
        fh.fill_etf_amount(rows)
        fh.save_cache(typ, code, obj)
        return len(missing)
    return 0


def build_manifest():
    print("═══ [1/3] 生成 manifest.json ═══")
    indices, etfs, stocks = [], [], []
    dates = []

    def quote_of(rows):
        """最新收盘与日涨跌幅（前收口径），供前端列表秒开（不再预加载全部K线）"""
        if not rows:
            return None, None
        last = rows[-1]
        chg = None
        if len(rows) > 1 and rows[-2].get("close"):
            chg = round((last["close"] - rows[-2]["close"]) / rows[-2]["close"] * 100, 2)
        return last.get("close"), chg

    def calc_dd2y(rows, win=504, min_rows=200):
        """距2年高点回撤：最新收盘 vs 窗口内最高收盘（供智能推荐 2Y回撤 列）。
        返回 (dd2y%, hi2y, hi2y_date)；数据不足 → (None, None, None) 前端显示 —"""
        closes = [(r["date"], r.get("close")) for r in rows if r.get("close") is not None]
        if len(closes) < min_rows:
            return None, None, None
        hi_d, hi_p = max(closes[-win:], key=lambda x: x[1])
        if not hi_p:
            return None, None, None
        return round((closes[-1][1] / hi_p - 1) * 100, 2), hi_p, hi_d

    for code, name, src, tcode in fh.INDICES:
        c = fh.load_cache("指数", code)
        rows = (c or {}).get("rows", [])
        vdiv, adiv = IDX_DIV[src]
        close, chg = quote_of(rows)
        dd2y, hi2y, hi2y_date = calc_dd2y(rows)
        indices.append({"code": code, "name": name, "source": src,
                        "vdiv": vdiv, "adiv": adiv,
                        "last": last_date(rows), "n": len(rows),
                        "last_close": close, "last_chg": chg,
                        "dd2y": dd2y, "hi2y": hi2y, "hi2y_date": hi2y_date})
        if rows:
            dates.append(rows[-1]["date"])
        else:
            print(f"  ⚠️ 指数 {code} {name}: 无缓存（cache/指数_{code}.json），请先运行 update.py 选项1")

    # ETF 规模（腾讯实时，cache/_ETF规模.json；缺失的标的 scale=None，前端不显示）
    scale_map = {}
    try:
        sm = json.load(open(os.path.join(BASE, "cache", "_ETF规模.json"), encoding="utf-8"))
        scale_map = {c: v.get("scale_yi") for c, v in sm.items() if v.get("scale_yi")}
    except Exception:
        pass
    for code, name, tcode in fh.ETFS:
        c = fh.load_cache("ETF", code)
        rows = (c or {}).get("rows", [])
        if rows:
            n = ensure_amount_filled("ETF", code, c)
            if n:
                print(f"  ETF {code} {name}: 补估算成交额 {n} 行并写回缓存")
            dates.append(rows[-1]["date"])
        else:
            print(f"  ⚠️ ETF {code} {name}: 无缓存，请先运行 update.py 选项2")
        close, chg = quote_of(rows)
        # 净值涨跌：最近两个披露日期的单位净值（净值披露频率可能低于交易日）
        nav = acc = None
        nav_chg = None
        for r in reversed(rows):
            if r.get("nav") is not None:
                if nav is None:
                    nav = r["nav"]; acc = r.get("acc_nav")
                elif nav_chg is None:
                    nav_chg = round((nav - r["nav"]) / r["nav"] * 100, 2)
            if nav is not None and nav_chg is not None:
                break
        dd2y, hi2y, hi2y_date = calc_dd2y(rows)
        etfs.append({"code": code, "name": name, "last": last_date(rows), "n": len(rows),
                     "last_close": close, "last_chg": chg, "last_nav": nav, "last_acc": acc,
                     "last_nav_chg": nav_chg, "scale": scale_map.get(code),
                     "dd2y": dd2y, "hi2y": hi2y, "hi2y_date": hi2y_date})

    # 股票池 = 推荐20 + 其他成份股（精选池 289 − 推荐，来自汇总表）+ 自选股清单（xlsx 现读）；含未拉取 K 线的占位
    rec_set = {c for c, _, _ in fsd.STOCKS}
    rec_names = {c: n for c, n, _ in fsd.STOCKS}
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    pool_meta = {}
    if os.path.exists(t_path):
        pool_meta = {r["code"]: r for r in json.load(open(t_path, encoding="utf-8"))}
    watch_rows = [r for r in watchlist.read_watchlist_xlsx() if r["show"]]
    watch_set = {r["code"] for r in watch_rows}
    watch_names = {r["code"]: r["name"] for r in watch_rows}
    watch_seq = {r["code"]: r["seq"] for r in watch_rows}   # 自选股 tab 按清单序号排序
    watch_meta = watchlist.load_watch_meta()   # 行业增强（自选股不在精选池时展示用）
    all_codes = [c for c, _, _ in fsd.STOCKS]
    all_codes += [c for c in pool_meta if c not in rec_set]
    all_codes += [r["code"] for r in watch_rows if r["code"] not in rec_set and r["code"] not in pool_meta]
    for code in all_codes:
        c = fh.load_cache("股票", code)
        rows = (c or {}).get("rows", [])
        name = rec_names.get(code) or pool_meta.get(code, {}).get("name") or watch_names.get(code, code)
        if rows:
            n = ensure_amount_filled("股票", code, c)
            if n:
                print(f"  股票 {code} {name}: 补估算成交额 {n} 行并写回缓存")
            dates.append(rows[-1]["date"])
        close, chg = quote_of(rows)
        dd2y, hi2y, hi2y_date = calc_dd2y(rows)
        s = {"code": code, "name": name, "last": last_date(rows), "n": len(rows),
             "last_close": close, "last_chg": chg,
             "dd2y": dd2y, "hi2y": hi2y, "hi2y_date": hi2y_date,
             "rec": code in rec_set, "watch": code in watch_set, "ready": bool(rows)}
        if code in watch_seq:
            s["seq"] = watch_seq[code]
        # 最新股息率：有指标文件读末行；否则用汇总表 div_yield 快照（东财近12月口径）
        p = os.path.join(WEB_DATA, "stocks", f"{code}.json")
        if os.path.exists(p):
            try:
                ind = json.load(open(p, encoding="utf-8"))
                if ind:
                    s["last_dy"] = ind[-1].get("dy")
                    s["last_pr"] = ind[-1].get("pr")   # 市赚率 PR（PE-TTM ÷ 近5年TTM年化ROE）
            except Exception:
                pass
        s.setdefault("last_dy", None)
        if s["last_dy"] is None:
            s["last_dy"] = pool_meta.get(code, {}).get("div_yield")
        t = pool_meta.get(code, {})
        wm = watch_meta.get(code, {})
        s["ind"] = t.get("ind", "") or wm.get("ind", "")
        s["ind3"] = t.get("ind3", "") or wm.get("ind3", "")
        stocks.append(s)

    manifest = {
        "data_date": max(dates) if dates else "",
        "indices": indices,
        "etfs": etfs,
        "stocks": stocks,
    }
    atomic_dump(os.path.join(WEB_DATA, "manifest.json"), manifest, indent=None, separators=(",", ":"))
    print(f"  ✅ manifest.json：指数{len(indices)} / ETF{len(etfs)} / 股票{len(stocks)}，数据日期 {manifest['data_date']}")


def calc_roe5y(fin_rows, data_date):
    """近5年报告期 TTM 年化 ROE 均值（%），供市赚率 PR = PE-TTM ÷ roe5y 使用
    每个报告期时点：TTM 年化 ROE = (本期累计净利 + 去年年报净利 − 去年同期累计净利) ÷ 期末净资产 × 100
    （累计 np 跨年不可直接差分；年报时该式退化为自身年报净利）
    期末净资产 = bps(每股净资产) × share(股本)；亏损期（TTM 为负）照常计入平均
    可用报告期 < 1 年 → None；数据不足5年时退化为最近可用报告期平均"""
    from datetime import datetime, timedelta
    fins = [f for f in fin_rows if f.get("np") is not None and f.get("bps") and f.get("share")
            and f["bps"] > 0 and f["share"] > 0]
    fins.sort(key=lambda x: x["report_date"])
    np_by_date = {f["report_date"]: f["np"] for f in fins}
    annual_np = {d[:4]: v for d, v in np_by_date.items() if d.endswith("12-31")}
    vals = []   # (report_date, ttm_roe%)
    for f in fins:
        y = int(f["report_date"][:4])
        prev = annual_np.get(str(y - 1))
        same = np_by_date.get(f"{y - 1}-{f['report_date'][5:]}")   # 去年同期（月-日）
        if prev is None or same is None:
            continue
        ttm = f["np"] + prev - same
        equity = f["bps"] * f["share"]
        if equity > 0:
            vals.append((f["report_date"], ttm / equity * 100))
    if not vals:
        return None
    try:
        cutoff = (datetime.strptime(data_date, "%Y-%m-%d") - timedelta(days=365 * 5)).strftime("%Y-%m-%d")
    except Exception:
        cutoff = ""
    recent = [v for d, v in vals if d >= cutoff] if cutoff else []
    if not recent:
        recent = [v for _, v in vals[-16:]]   # 数据不足5年：最近可用报告期（至多16期）
    return sum(recent) / len(recent)


def stock_pool():
    """股票池全量（推荐20 + 其他成份股 + 自选股清单）：返回 [(code, name)]，含无 K 线缓存的占位"""
    rec = [(c, n) for c, n, _ in fsd.STOCKS]
    other = []
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if os.path.exists(t_path):
        rec_set = {c for c, _, _ in fsd.STOCKS}
        other = [(r["code"], r.get("name", r["code"])) for r in json.load(open(t_path, encoding="utf-8"))
                 if r["code"] not in rec_set]
    # 自选股清单（池外部分；池内已由汇总表覆盖；仅展示字段==1 的）
    other_set = {c for c, _ in other}
    rec_set = {c for c, _ in rec}
    other += [(r["code"], r["name"]) for r in watchlist.read_watchlist_xlsx()
              if r["show"] and r["code"] not in rec_set and r["code"] not in other_set]
    return rec + other


def build_stock_indicators():
    print("═══ [2/3] 股票逐日指标（复用 _fetch_stock_data calc_* 口径）═══")
    ok, skip = 0, 0
    for code, name in stock_pool():
        kc = fh.load_cache("股票", code)
        if not kc or not kc.get("rows"):
            skip += 1
            continue
        rows = kc["rows"]
        dc = fh.load_cache("分红", code)
        fc = fh.load_cache("财报", code)
        sc = fh.load_cache("股本", code)
        if not dc or not fc:
            print(f"  ⚠️ {code} {name}: 分红/财报缓存缺失（需 update.py 选项5 补齐），跳过指标")
            skip += 1
            continue
        div = dc.get("rows", [])
        fin = fc.get("rows", [])
        share = sc.get("rows", []) if sc else []
        dy = fsd.calc_dividend_yield(rows, div)
        pe_ttm, pe_dyn = fsd.calc_pe(rows, fin, share)
        pb = fsd.calc_pb(rows, fin)
        peg = fsd.calc_peg(rows, fin, share, pe_ttm)
        roe = fsd.calc_ratio(rows, fin, "roe")
        roa = fsd.calc_ratio(rows, fin, "roa")
        roe5y = calc_roe5y(fin, rows[-1]["date"])   # 近5年 TTM 年化 ROE 均值（市赚率分母）
        out = []
        for i, r in enumerate(rows):
            pr = round(pe_ttm[i] / roe5y, 2) if (roe5y and pe_ttm[i] is not None) else None
            out.append({"d": r["date"], "dy": dy[i], "pe_ttm": pe_ttm[i],
                        "pe_dyn": pe_dyn[i], "pb": pb[i], "peg": peg[i],
                        "roe": roe[i], "roa": roa[i], "pr": pr})
        atomic_dump(os.path.join(WEB_DATA, "stocks", f"{code}.json"), out, indent=None, separators=(",", ":"))
        ok += 1
        if ok % 20 == 0:
            print(f"  进度 {ok}")
    print(f"  ✅ 指标生成 {ok} 只，跳过 {skip} 只")


def build_components():
    """生成 web/data/components.json：每只指数/ETF 的成分股列表（代码/名称/权重/一级行业/股息率）
    来源：cache/_成分股汇总.json 的 w 字段（md 解析：股票→{指数/ETF名: 权重}）反转 + _成分股汇总表.json 的行业"""
    print("═══ [3/4] 生成 components.json ═══")
    s_path = os.path.join(BASE, "cache", "_成分股汇总.json")
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if not (os.path.exists(s_path) and os.path.exists(t_path)):
        print("  ⚠️ 缺少 _成分股汇总.json/_成分股汇总表.json，跳过（请先运行 update.py 选项4）")
        return
    stock = json.load(open(s_path, encoding="utf-8"))
    tmap = {r["code"]: r for r in json.load(open(t_path, encoding="utf-8"))}

    def build_one(name):
        rows = []
        key = name.split("(")[0].strip()   # 去半角括号后缀（如 000151 的“(辅助,510720跟踪)”），匹配 md 解析的指数名
        for c, s in stock.items():
            w, found = None, False
            for wn, wv in (s.get("w") or {}).items():
                if wn.split("（")[0].split("(")[0].strip() == key:   # md 解析已去全角括号，这里兼容两种
                    w, found = wv, True
                    break
            if not found:
                continue
            t = tmap.get(c, {})
            rows.append({"code": c, "name": s.get("name", ""), "weight": w,
                         "ind": t.get("ind", ""), "ind3": t.get("ind3", ""),
                         "div_yield": s.get("div_yield_calc")})
        rows.sort(key=lambda r: -(r["weight"] or 0))
        return {"name": name, "n": len(rows), "stocks": rows}

    out = {"by_index": {}, "by_etf": {}}
    for code, name, _src, _t in fh.INDICES:
        out["by_index"][code] = build_one(name)
    for code, name, _t in fh.ETFS:
        out["by_etf"][code] = build_one(name)

    # 国证官网缓存覆盖（980092 等：md 解析因权重缺失/部分收录会退化，国证源成分完整 + 股息率补全）
    for code, name, _src, _t in fh.INDICES:
        p = os.path.join(BASE, "cache", f"成分_{code}.json")
        if not os.path.exists(p):
            continue
        try:
            cc = json.load(open(p, encoding="utf-8"))
            # 股息率：从汇总表（东财近12月口径）按 code 匹配补全——供区间分析加权 dy0 与前端成分表展示
            tmap = {r["code"]: r for r in json.load(open(t_path, encoding="utf-8"))}
            stocks = [{"code": s["code"], "name": s["name"], "weight": s.get("weight"),
                       "ind": s.get("ind", ""), "ind3": s.get("ind3", ""),
                       "div_yield": tmap.get(s["code"], {}).get("div_yield")} for s in cc.get("stocks", [])]
            n_dy = sum(1 for x in stocks if x["div_yield"] is not None)
            out["by_index"][code] = {"name": cc.get("name", name), "n": len(stocks), "stocks": stocks,
                                      "note": f"国证官网成分（{cc.get('sample_date', '')}），仅前十大权重公开"}
            print(f"  📥 {code} {cc.get('name', name)}: 国证官网覆盖 {len(stocks)} 只（含股息率 {n_dy} 只）（{cc.get('sample_date', '')}）")
        except Exception as e:
            print(f"  ⚠️ {code} 成分缓存读取失败: {e}")
    # ETF 跟踪国证指数（如 159201→980092）：md 解析仅部分收录，直接复用指数国证源（完整成分 + 股息率）
    import _gen_analysis as ga
    for code, name, _t in fh.ETFS:
        track = ga.ETF_TRACK.get(code)
        src = out["by_index"].get(track)
        if track and src and src.get("n") and (src.get("note") or "").startswith("国证官网"):
            out["by_etf"][code] = dict(src)
    # ETF 跟踪指数成分兜底（md w 链路解析为空时：ETF 成分=跟踪指数成分是合同约定，
    # 直接复用指数成分保证 by_etf 不空；季报持仓覆盖（真实持仓）在其后仍会覆盖）
    for code, name, _t in fh.ETFS:
        track = ga.ETF_TRACK.get(code)
        src = out["by_index"].get(track)
        if track and src and src.get("n") and not out["by_etf"].get(code, {}).get("stocks"):
            out["by_etf"][code] = dict(src)
            print(f"  📥 {code} {name}: 跟踪指数成分兜底（{src['name']} {src['n']} 只）")
    # ETF 自身季报持仓覆盖（159229→932368 无行情/成分源）：真实持仓+占净值比+个股股息率
    for code, name, _t in fh.ETFS:
        p = os.path.join(BASE, "cache", f"ETF持仓_{code}.json")
        if not os.path.exists(p):
            continue
        try:
            h = json.load(open(p, encoding="utf-8"))
            rows = [{"code": r["code"], "name": r["name"], "weight": r["pct"],
                     "ind": tmap.get(r["code"], {}).get("ind", ""),
                     "ind3": tmap.get(r["code"], {}).get("ind3", ""),
                     "div_yield": r.get("dy")} for r in h.get("rows", [])]
            rows = [r for r in rows if r["weight"] and r["weight"] >= 0.5]   # 剔除打新碎股
            if rows:
                out["by_etf"][code] = {"name": name, "n": len(rows), "stocks": rows,
                                        "note": f"ETF季报前十大持仓（{h.get('report_date', '')}），占净值比"}
                print(f"  📥 {code} {name}: ETF季报持仓覆盖 {len(rows)} 只（{h.get('report_date', '')}）")
        except Exception as e:
            print(f"  ⚠️ {code} 持仓读取失败: {e}")
    # 980092 前十大补个股股息率（来自 ETF 持仓行的 dy，供成分表展示）
    cc = out["by_index"].get("980092")
    if cc and cc.get("stocks"):
        dy_map = {}
        for _code, _n, _t in fh.ETFS:
            p = os.path.join(BASE, "cache", f"ETF持仓_{_code}.json")
            if os.path.exists(p):
                for r in json.load(open(p, encoding="utf-8")).get("rows", []):
                    if r.get("dy"):
                        dy_map.setdefault(r["code"], r["dy"])
        n0 = sum(1 for s in cc["stocks"] if s["div_yield"] is not None)
        for s in cc["stocks"]:
            if s["div_yield"] is None and s["code"] in dy_map:
                s["div_yield"] = dy_map[s["code"]]
        n1 = sum(1 for s in cc["stocks"] if s["div_yield"] is not None)
        if n1 > n0:
            print(f"  📥 980092 成分股息率补全：{n0} → {n1} 只（ETF持仓行）")
    atomic_dump(os.path.join(WEB_DATA, "components.json"), out, indent=None, separators=(",", ":"))
    ok = sum(1 for v in out["by_index"].values() if v["n"]) + sum(1 for v in out["by_etf"].values() if v["n"])
    print(f"  ✅ components.json：指数{len(out['by_index'])}只 / ETF{len(out['by_etf'])}只，有成分的 {ok} 只")


def build_summary():
    print("═══ [3/3] 生成 summary.json ═══")
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if not os.path.exists(t_path):
        print("  ⚠️ 缺少 cache/_成分股汇总表.json，跳过 summary（请先运行 update.py 选项4）")
        return
    table = json.load(open(t_path, encoding="utf-8"))
    s_path = os.path.join(BASE, "cache", "_成分股汇总.json")
    stock = {}
    if os.path.exists(s_path):
        stock = json.load(open(s_path, encoding="utf-8"))
    for t in table:
        s = stock.get(t["code"], {})
        t["change_pct"] = s.get("change_pct")
        if not t.get("name"):
            t["name"] = s.get("name", "")
    atomic_dump(os.path.join(WEB_DATA, "summary.json"), table, indent=None, separators=(",", ":"))
    print(f"  ✅ summary.json：{len(table)} 只成分股")


if __name__ == "__main__":
    t0 = time.time()
    build_manifest()
    build_stock_indicators()
    build_components()
    build_summary()
    print(f"✅ 前端数据包生成完成，耗时 {time.time() - t0:.1f}s → web/data/")
