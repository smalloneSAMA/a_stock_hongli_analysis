# -*- coding: utf-8 -*-
"""自由现金流ETF季报持仓 → 980092 股息率估算（S10 数据链路）

1. 拉 9 只自由现金流 ETF 季报前十大持仓（天天基金 F10 jjcc，纯HTTP+Referer）
2. 与 980092 官网 top10 比对，验证跟踪关系（重合≥8只=跟踪980092）
3. 持仓股 TTM 股息率：精选池(_成分股汇总.json)优先，东财分红历史兜底（近12个月除权派息/现价，与 div_yield_calc 同口径）
4. 980092 加权股息率估算 = Σ(持仓占比 × 个股dy) / Σ占比

产出：
- cache/ETF持仓_{code}.json    每只ETF季报持仓（含个股dy）
- cache/成分_980092_股息率.json 980092 股息率估算（供 _gen_analysis 使用）
用法: python scripts/_fetch_etf_holdings.py
"""
import sys, io, os, json, re, time, datetime
import requests
from _common import atomic_load, atomic_dump   # 原子读写（损坏自愈，P2）

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FCF_ETFS = ["159201", "159229", "159221", "159222", "159166", "159223", "159225", "159276", "159232"]

def _recent_quarters(n=5):
    """最近 n 个已结束季度 [(年, 季末月)]（由今日推导，勿硬编码）"""
    y, m = datetime.date.today().year, datetime.date.today().month
    off0 = (m - 1) // 3 - 1   # 当前季度的前一季度（0基偏移，上季=-1...）
    return [(y + (off0 - i) // 4, ((off0 - i) % 4 + 1) * 3) for i in range(n)]

QUARTERS = _recent_quarters()

S = requests.Session()
S.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://fundf10.eastmoney.com/",
})


def fetch_holdings(code):
    """季报前十大持仓：返回 (截止日期, [(code, name, pct)]) 或 (None, [])"""
    for y, m in QUARTERS:
        try:
            r = S.get("https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
                      params={"type": "jjcc", "code": code, "topline": 10, "year": y, "month": m}, timeout=12)
            r.encoding = "utf-8"
            t = r.text
            mq = re.search(r"截止至：<font class='px12'>([\d-]+)</font>", t)
            # 只取第一个表格（避免混入其他季度/其他表）
            table = t.split("<table")[1] if "<table" in t else t
            rows = re.findall(
                r"<td>\d+</td><td><a[^>]*>(\d{6})</a></td><td class='tol'><a[^>]*>([^<]+)</a></td>.*?<td class='tor'>([\d.]+)%</td>",
                table)
            if rows:
                return mq.group(1) if mq else f"{y}-{m}", [(c, n, float(p)) for c, n, p in rows]
        except Exception:
            time.sleep(1)
    return None, []


def fetch_dividends(code):
    """东财分红历史：返回 [(除权日, 每股派息)] 最近10条"""
    try:
        r = S.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
                  params={"reportName": "RPT_SHAREBONUS_DET",
                          "columns": "ALL",
                          "filter": f'(SECURITY_CODE="{code}")',
                          "pageNumber": 1, "pageSize": 10,
                          "sortColumns": "EX_DIVIDEND_DATE", "sortTypes": "-1"},
                  timeout=12)
        rows = (r.json().get("result") or {}).get("data") or []
        return [(str(x.get("EX_DIVIDEND_DATE", ""))[:10], x.get("PRETAX_BONUS_RMB") or 0) for x in rows]
    except Exception:
        return []


def fetch_price(code):
    """东财现价（元）"""
    try:
        secid = ("1." if code.startswith(("6", "9")) else "0.") + code
        r = S.get("https://push2.eastmoney.com/api/qt/stock/get",
                  params={"secid": secid, "fields": "f43"}, timeout=10)
        v = (r.json().get("data") or {}).get("f43")
        return v / 100 if v else None
    except Exception:
        return None


def ttm_dy(code, divs, price):
    """近12个月除权派息/现价 × 100（与 div_yield_calc 同口径；接口派息为每10股 → ÷10）"""
    if not divs or not price:
        return None
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=365)).isoformat()
    total = sum(p / 10.0 for d, p in divs if d >= cutoff)
    return round(total / price * 100, 2)


def load_pool():
    """精选池汇总缓存（损坏/缺失返回 {}，不崩溃）"""
    return atomic_load(os.path.join(BASE, "cache", "_成分股汇总.json")) or {}


def main():
    pool = load_pool()
    off_path = os.path.join(BASE, "cache", "成分_980092.json")
    off = atomic_load(off_path) or {}
    if not off.get("top10"):
        print("  ❌ 缺少/损坏 cache/成分_980092.json（先运行 _fetch_cnindex_components.py），无法验证跟踪关系，中止")
        return
    off_top = {(s["code"]): s for s in off["top10"]}
    off_codes = set(off_top)

    print("═══ 自由现金流ETF季报持仓（980092 股息率估算）═══")
    holds = {}
    for code in FCF_ETFS:
        date, rows = fetch_holdings(code)
        if not rows:
            print(f"  {code}: 无持仓数据")
            continue
        # 跟踪关系验证：与官网 top10 重合
        codes = {c for c, _, _ in rows}
        overlap = len(codes & off_codes)
        track = "跟踪980092 ✓" if overlap >= 8 else f"重合{overlap}/10 ⚠️可能跟踪其他指数"
        print(f"  {code}: {date} 前十大 {track}")
        # 个股 dy：精选池优先，东财分红兜底
        out_rows = []
        for c, n, pct in rows:
            dy = pool.get(c, {}).get("div_yield_calc")
            src = "精选池"
            if dy is None:
                divs = fetch_dividends(c)
                price = fetch_price(c)
                dy = ttm_dy(c, divs, price)
                src = "东财分红"
                time.sleep(0.25)
            out_rows.append({"code": c, "name": n, "pct": pct, "dy": dy, "dy_src": src})
        holds[code] = {"report_date": date, "rows": out_rows}
        os.makedirs(os.path.join(BASE, "cache"), exist_ok=True)
        atomic_dump(os.path.join(BASE, "cache", f"ETF持仓_{code}.json"), holds[code], indent=None)
        time.sleep(0.3)

    # 980092 加权股息率估算：取跟踪980092的ETF持仓（前十大占比加权）
    est = {"code": "980092", "name": "国证自由现金流", "date": str(datetime.date.today()),
           "source": "ETF季报持仓加权估算", "etfs": [], "dy0": None, "parts": []}
    for code, h in holds.items():
        rows = [r for r in h["rows"] if r["dy"] is not None]
        if len({r["code"] for r in h["rows"]} & off_codes) < 8:
            continue
        wsum = sum(r["pct"] for r in rows)
        dy0 = round(sum(r["pct"] * r["dy"] for r in rows) / wsum, 4) if wsum else None
        est["etfs"].append({"code": code, "report_date": h["report_date"],
                            "dy0": dy0, "n_with_dy": len(rows)})
        est["parts"].append((code, dy0))
    # 多只ETF取均值
    dys = [d for _, d in est["parts"] if d]
    if dys:
        est["dy0"] = round(sum(dys) / len(dys), 4)
    atomic_dump(os.path.join(BASE, "cache", "成分_980092_股息率.json"), est, indent=None)
    print(f"\n980092 股息率估算 dy0 = {est['dy0']}%（{est['etfs']}）")
    if est["dy0"]:
        print("  → 供 _gen_analysis 使用：980092/159229 将接入买卖区间分析")
    print("✅ cache/成分_980092_股息率.json 已生成")


if __name__ == "__main__":
    main()
