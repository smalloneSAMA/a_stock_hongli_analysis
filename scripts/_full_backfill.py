# -*- coding: utf-8 -*-
"""修复腾讯prefix路由bug(92开头北交所) + 全量289只拉分红历史算股息率 + 写回缓存"""
import json, sys, time, random, urllib.request, datetime
from _common import market_prefix, em_get   # 前缀路由（92→bj 先于 9x）+ 东财限流请求

sys.stdout.reconfigure(encoding="utf-8")

def tencent_batch(codes):
    """腾讯批量行情。⚠️ 92开头(北交所)必须先于 9x(沪) 判断，否则路由到 sh920xxx 返回空"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    got = 0
    for i in range(0, len(codes), 50):
        batch = codes[i:i + 50]
        url = "https://qt.gtimg.cn/q=" + ",".join(market_prefix(c) for c in batch)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=10).read().decode("gbk", errors="replace")
            for line in data.strip().split(";"):
                if '"' not in line: continue
                key = line.split("=")[0].split("_")[-1]
                v = line.split('"')[1].split("~")
                if len(v) < 53: continue
                code = key[2:]
                if code in stock:
                    stock[code]["t_price"] = float(v[3] or 0)
                    stock[code]["t_pe"] = float(v[39] or 0)
                    stock[code]["t_pb"] = float(v[46] or 0)
                    stock[code]["t_mcap"] = float(v[45] or 0)
                    stock[code]["change_pct"] = float(v[32] or 0)
                    got += 1
        except Exception as e:
            print("  腾讯批次失败:", e)
        time.sleep(0.3)
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)
    print(f"腾讯行情更新完成，命中 {got}/{len(codes)}")

def backfill_bj(codes):
    """北交所(920xxx)用 push2delay 补 PE(动)/PB/市值（f162/f167/f116）"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    for c in codes:
        url = ("https://push2delay.eastmoney.com/api/qt/stock/get?fltt=2&invt=2"
               f"&fields=f57,f58,f43,f116,f162,f167&secid=0.{c}")
        try:
            d = json.loads(em_get(url)).get("data") or {}
            stock[c]["t_pe"] = d.get("f162")
            stock[c]["t_pb"] = d.get("f167")
            stock[c]["t_mcap"] = round((d.get("f116") or 0) / 1e8, 1) if d.get("f116") else 0
            stock[c]["t_price"] = d.get("f43")
            print(f"  北交所 {c} {stock[c]['name']}: PE={d.get('f162')} PB={d.get('f167')} 市值={stock[c]['t_mcap']}亿")
        except Exception as e:
            print(f"  北交所 {c} 补数失败: {e}")
        time.sleep(0.5)
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)

def fetch_all_dividend(codes):
    """全量 289 只分红历史 → 近12个月股息率，写回缓存"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    today = datetime.date.today()
    for i, c in enumerate(codes):
        url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?"
               "reportName=RPT_SHAREBONUS_DET&columns=ALL"
               f"&filter=(SECURITY_CODE%3D%22{c}%22)"
               "&pageNumber=1&pageSize=8&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&source=WEB&client=WEB")
        rec = []
        try:
            d = json.loads(em_get(url))
            rows = (d.get("result") or {}).get("data") or []
            for r in rows:
                exdate = str(r.get("EX_DIVIDEND_DATE") or "")[:10]
                bonus = r.get("PRETAX_BONUS_RMB") or 0
                if exdate and bonus:
                    rec.append((exdate, round(bonus, 3)))     # 每10股金额
            total12 = 0.0
            for exdate, bonus10 in rec:
                try:
                    y, m, _ = map(int, exdate.split("-"))
                    if (today.year - y) * 12 + (today.month - m) <= 12:
                        total12 += bonus10 / 10.0             # ÷10 → 每股
                except Exception:
                    pass
            price = stock[c].get("t_price") or stock[c].get("price") or 0
            dy = round(total12 / price * 100, 2) if price and total12 else None
            stock[c]["div_yield_calc"] = dy
            stock[c]["div_rec"] = rec[:5]
        except Exception as e:
            print(f"  [{i}] {c} 失败: {type(e).__name__} {str(e)[:50]}")
            stock[c]["div_yield_calc"] = None
            stock[c]["div_rec"] = []
        if (i + 1) % 30 == 0:
            print(f"  分红进度 {i+1}/{len(codes)}")
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("全量股息率计算完成")

if __name__ == "__main__":
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    codes = list(stock.keys())
    # 1) 修复腾讯路由后重拉行情
    tencent_batch(codes)
    # 2) 北交所补估值
    backfill_bj(["920599", "920509"])
    # 3) 全量分红
    fetch_all_dividend(codes)
