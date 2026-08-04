# -*- coding: utf-8 -*-
"""
生成前端展示数据包 web/data/（只读缓存，不触发任何网络拉取）

输出：
- web/data/manifest.json      三类标的清单 + 数据源 + 单位换算因子 + 数据日期
- web/data/stocks/{code}.json 20只股票逐日指标（复用 _fetch_stock_data 的 calc_* 口径，与 Excel 完全一致）
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

WEB_DATA = os.path.join(BASE, "web", "data")
os.makedirs(os.path.join(WEB_DATA, "stocks"), exist_ok=True)

# 指数单位换算（与 update.py export_excel 同口径）：
# 原始单位：腾讯 volume=手/amount=元(估算)；中证官网 tradingVol=股/tradingValue=亿元；国证 volume=万手/amount=亿元
IDX_DIV = {"tencent": (1e4, 1e8), "csindex": (1e6, 1), "cnindex": (1, 1)}


def atomic_dump(path, obj):
    """原子写 JSON（紧凑格式，减小体积）"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


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

    for code, name, src, tcode in fh.INDICES:
        c = fh.load_cache("指数", code)
        rows = (c or {}).get("rows", [])
        vdiv, adiv = IDX_DIV[src]
        close, chg = quote_of(rows)
        indices.append({"code": code, "name": name, "source": src,
                        "vdiv": vdiv, "adiv": adiv,
                        "last": last_date(rows), "n": len(rows),
                        "last_close": close, "last_chg": chg})
        if rows:
            dates.append(rows[-1]["date"])
        else:
            print(f"  ⚠️ 指数 {code} {name}: 无缓存（cache/指数_{code}.json），请先运行 update.py 选项1")

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
        etfs.append({"code": code, "name": name, "last": last_date(rows), "n": len(rows),
                     "last_close": close, "last_chg": chg, "last_nav": nav, "last_acc": acc,
                     "last_nav_chg": nav_chg})

    for code, name, tcode in fsd.STOCKS:
        c = fh.load_cache("股票", code)
        rows = (c or {}).get("rows", [])
        if rows:
            n = ensure_amount_filled("股票", code, c)
            if n:
                print(f"  股票 {code} {name}: 补估算成交额 {n} 行并写回缓存")
            dates.append(rows[-1]["date"])
        else:
            print(f"  ⚠️ 股票 {code} {name}: 无缓存，请先运行 update.py 选项5")
        close, chg = quote_of(rows)
        stocks.append({"code": code, "name": name, "last": last_date(rows), "n": len(rows),
                       "last_close": close, "last_chg": chg})

    # 股票列表补最新股息率（读已生成的指标文件末行）
    for s in stocks:
        p = os.path.join(WEB_DATA, "stocks", f"{s['code']}.json")
        if os.path.exists(p):
            try:
                ind = json.load(open(p, encoding="utf-8"))
                if ind:
                    s["last_dy"] = ind[-1].get("dy")
            except Exception:
                pass
        s.setdefault("last_dy", None)

    manifest = {
        "data_date": max(dates) if dates else "",
        "indices": indices,
        "etfs": etfs,
        "stocks": stocks,
    }
    atomic_dump(os.path.join(WEB_DATA, "manifest.json"), manifest)
    print(f"  ✅ manifest.json：指数{len(indices)} / ETF{len(etfs)} / 股票{len(stocks)}，数据日期 {manifest['data_date']}")


def build_stock_indicators():
    print("═══ [2/3] 股票逐日指标（复用 _fetch_stock_data calc_* 口径）═══")
    ok, skip = 0, 0
    for code, name, tcode in fsd.STOCKS:
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
        out = []
        for i, r in enumerate(rows):
            out.append({"d": r["date"], "dy": dy[i], "pe_ttm": pe_ttm[i],
                        "pe_dyn": pe_dyn[i], "pb": pb[i], "peg": peg[i],
                        "roe": roe[i], "roa": roa[i]})
        atomic_dump(os.path.join(WEB_DATA, "stocks", f"{code}.json"), out)
        ok += 1
        if ok % 5 == 0:
            print(f"  进度 {ok}/{len(fsd.STOCKS)}")
    print(f"  ✅ 指标生成 {ok} 只，跳过 {skip} 只")


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
    atomic_dump(os.path.join(WEB_DATA, "summary.json"), table)
    print(f"  ✅ summary.json：{len(table)} 只成分股")


if __name__ == "__main__":
    t0 = time.time()
    build_manifest()
    build_stock_indicators()
    build_summary()
    print(f"✅ 前端数据包生成完成，耗时 {time.time() - t0:.1f}s → web/data/")
