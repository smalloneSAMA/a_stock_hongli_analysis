# -*- coding: utf-8 -*-
"""
推荐20只股票历史日线拉取工具（不复权，2004-01-01 起）

- 标的：《红利股票推荐20只.md》全部20只
- 数据源：腾讯日K（不复权，真实历史价格；前复权早期价格会因分红变负，故不用）
- 全量：翻页拉取，过滤 2004-01-01 之前数据（上市晚于该日的自然从上市日起）
- 增量：腾讯 start 参数实测无效（返回最近800条），增量=拉最近800条+字段级合并覆盖，
        等价于刷新最近约3.2年，更早数据保留
- 缓存：cache/股票_{code}.json，原子写（_fetch_history.save_cache），无缓存全量自愈
- 成交额：腾讯日K无成交额字段，按 成交量(手)×100×(高+低+收)/3 估算（同ETF口径）
- Excel：excel/股票历史.xlsx（每只一个sheet）
用法: python scripts/_fetch_stock_data.py [--refresh]
"""
import sys, io, os, json, time, argparse, urllib.request
import pandas as pd

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _fetch_history as fh

# ── 20只推荐股（红利股票推荐20只.md）────────────────────────────
STOCKS = [
    ("600036", "招商银行", "sh600036"),
    ("601838", "成都银行", "sh601838"),
    ("601088", "中国神华", "sh601088"),
    ("601225", "陕西煤业", "sh601225"),
    ("600938", "中国海油", "sh600938"),
    ("601857", "中国石油", "sh601857"),
    ("600350", "山东高速", "sh600350"),
    ("601006", "大秦铁路", "sh601006"),
    ("600900", "长江电力", "sh600900"),
    ("600795", "国电电力", "sh600795"),
    ("000858", "五粮液", "sz000858"),
    ("000895", "双汇发展", "sz000895"),
    ("000651", "格力电器", "sz000651"),
    ("000333", "美的集团", "sz000333"),
    ("000423", "东阿阿胶", "sz000423"),
    ("600566", "济川药业", "sh600566"),
    ("600019", "宝钢股份", "sh600019"),
    ("601668", "中国建筑", "sh601668"),
    ("600582", "天地科技", "sh600582"),
    ("600757", "长江传媒", "sh600757"),
]
START = "2004-01-01"  # 最早时间上限
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"

# ── 拉取（不复权）───────────────────────────────────────────────
def fetch_kline(tcode, code, full=True):
    """不复权日K。full=True: 翻页全量+过滤<2004-01-01；full=False: 仅最近800条（增量用）"""
    all_rows = []
    end = ""
    for page in range(30):
        # 最后参数空=不复权；start 参数腾讯忽略，故翻页一律用 end（向前翻）
        param = f"{tcode},day,,{end},800," if end else f"{tcode},day,,,800,"
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={param}"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        d = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
        k = d.get("data", {}).get(tcode, {})
        days = k.get("day") or k.get("qfqday") or []
        if not days:
            break
        rows = []
        for r in days:
            # 第7位可能是成交额(数字)或分红除权信息(dict)，dict 忽略
            amt = None
            if len(r) > 6 and isinstance(r[6], (str, int, float)):
                try:
                    amt = float(r[6])
                except (TypeError, ValueError):
                    amt = None
            rows.append({"date": r[0], "open": float(r[1]), "close": float(r[2]),
                         "high": float(r[3]), "low": float(r[4]), "volume": float(r[5]),
                         "amount": amt})
        old_first = rows[0]["date"]
        all_rows = rows + all_rows
        if not full:
            break  # 增量：只取最近800条，不翻页
        if len(days) < 800 or old_first == end:
            break
        if old_first < START:
            break  # 已翻过 2004 边界，停止（下方统一过滤）
        end = old_first
        time.sleep(0.5)
    if full:
        all_rows = [r for r in all_rows if r["date"] >= START]
    # 去重排序
    seen = {}
    for r in all_rows:
        seen[r["date"]] = r
    return [seen[k] for k in sorted(seen)]

def make_fetcher(tcode, code):
    def fetcher(last_date):
        if last_date:
            return fetch_kline(tcode, code, full=False)   # 增量：最近800条覆盖合并
        return fetch_kline(tcode, code, full=True)        # 全量：翻页 + 2004过滤
    return fetcher

# ── Excel ───────────────────────────────────────────────────────
def export_excel():
    from _fetch_history import load_cache
    COL_CN = {"open": "开盘", "close": "收盘", "high": "最高", "low": "最低",
              "volume": "成交量", "amount": "成交额"}
    rows_map = {}
    for code, name, _t in STOCKS:
        c = load_cache("股票", code)
        if c:
            fh.fill_etf_amount(c["rows"])          # 估算成交额
            fh.save_cache("股票", code, c)          # 写回缓存
            rows_map[code] = {"name": c.get("name", name), "rows": c["rows"]}
    try:
        with pd.ExcelWriter(os.path.join(BASE, "excel", "股票历史.xlsx"), engine="openpyxl") as w:
            for code, info in rows_map.items():
                rows = info["rows"]
                if not rows:
                    continue
                df = pd.DataFrame(rows)
                df["date"] = pd.to_datetime(df["date"])
                df = df.sort_values("date").set_index("date")
                df = df.rename(columns=COL_CN)
                df = df[["开盘", "收盘", "最高", "最低", "成交量", "成交额"]]
                df.index.name = "日期"
                df.to_excel(w, sheet_name=f"{code} {info['name'][:10]}"[:31])
        print(f"✅ excel/股票历史.xlsx 已生成（{len(rows_map)} 只，2004-01-01 起，不复权）")
    except PermissionError:
        print("⚠️  excel/股票历史.xlsx 被占用（可能已在Excel中打开），请关闭后重新执行导出")

# ── 主流程 ──────────────────────────────────────────────────────
def update_all(refresh=False):
    print("═══ 推荐20只股票历史行情（不复权，2004-01-01起）═══")
    for code, name, tcode in STOCKS:
        if refresh:
            rows = fetch_kline(tcode, code, full=True)
            obj = {"code": code, "name": name, "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"), "rows": rows}
            fh.save_cache("股票", code, obj)
            print(f"  [{code} {name}] 全量刷新 {len(rows)}条 -> cache/股票_{code}.json")
        else:
            try:
                fh.update_incremental("股票", code, name, make_fetcher(tcode, code))
            except Exception as e:
                print(f"  ❌ [{code} {name}] 失败: {repr(e)[:80]}")
        time.sleep(0.3)
    export_excel()
    print("\n✅ 股票历史更新完成")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="忽略缓存，全量重拉")
    args = ap.parse_args()
    update_all(refresh=args.refresh)
