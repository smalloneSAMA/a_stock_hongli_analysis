# -*- coding: utf-8 -*-
"""为红利成分股补充 行业(东财push2delay) / PE/PB/市值(腾讯批量) / 股息率(datacenter分红历史)"""
import json, time, random, urllib.request
from _common import market_prefix, em_get, tencent_quotes   # 前缀路由 + 东财限流 + 腾讯批量

def fetch_industry(codes):
    """东财 push2delay：行业 f127 + 价格 f43（限流 1s）"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    todo = [c for c in codes if not stock[c].get("industry")]
    print(f"待查行业 {len(todo)} 只")
    ok = 0
    for i, c in enumerate(todo):
        market = "1" if c.startswith("6") else "0"
        url = ("https://push2delay.eastmoney.com/api/qt/stock/get?fltt=2&invt=2"
               f"&fields=f57,f58,f43,f127&secid={market}.{c}")
        try:
            d = json.loads(em_get(url)).get("data") or {}
            if d.get("f127"):
                stock[c]["industry"] = d.get("f127", "")
                stock[c]["price"] = d.get("f43")
                ok += 1
            else:
                print(f"  [{i}] {c} 空行业")
        except Exception as e:
            print(f"  [{i}] {c} 失败: {type(e).__name__} {str(e)[:50]}")
        if (i + 1) % 30 == 0:
            print(f"  进度 {i+1}/{len(todo)}，成功 {ok}")
    print("行业完成，成功", ok)
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)

def tencent_batch(codes):
    """腾讯批量：PE/PB/市值/涨跌幅（不封IP）"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    for code, v in tencent_quotes(codes).items():
        if code in stock:
            stock[code]["t_price"] = float(v[3] or 0)
            stock[code]["t_pe"] = float(v[39] or 0)
            stock[code]["t_pb"] = float(v[46] or 0)
            stock[code]["t_mcap"] = float(v[45] or 0)
            stock[code]["change_pct"] = float(v[32] or 0)
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("腾讯验证完成")

def dividend_yield(codes):
    """datacenter 分红历史 → 近12个月每股派息 / 现价 = 股息率（限流 1s）"""
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    import datetime
    today = datetime.date.today()
    for i, c in enumerate(codes):
        url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?"
               "reportName=RPT_SHAREBONUS_DET&columns=ALL"
               f"&filter=(SECURITY_CODE%3D%22{c}%22)"
               "&pageNumber=1&pageSize=6&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&source=WEB&client=WEB")
        try:
            d = json.loads(em_get(url))
            rows = (d.get("result") or {}).get("data") or []
            total = 0.0
            rec = []
            for r in rows:
                exdate = str(r.get("EX_DIVIDEND_DATE") or "")[:10]
                bonus = r.get("PRETAX_BONUS_RMB") or 0
                if exdate and bonus:
                    rec.append((exdate, bonus))
            # 近12个月内的每股派息合计
            for exdate, bonus in rec:
                try:
                    y, m, _ = map(int, exdate.split("-"))
                    if (today.year - y) * 12 + (today.month - m) <= 12:
                        total += bonus
                except Exception:
                    pass
            price = stock[c].get("t_price") or stock[c].get("price") or 0
            stock[c]["div_yield_calc"] = round(total / price * 100, 2) if price and total else None
            stock[c]["div_rec"] = rec[:4]
        except Exception as e:
            print(f"  [{i}] {c} 失败: {type(e).__name__} {str(e)[:50]}")
        if (i + 1) % 10 == 0:
            print(f"  分红进度 {i+1}/{len(codes)}")
    json.dump(stock, open("cache/_成分股汇总.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("股息率计算完成")

if __name__ == "__main__":
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    codes = list(stock.keys())
    print(f"成分股 {len(codes)} 只")
    fetch_industry(codes)
    tencent_batch(codes)
    import sys
    if "--div" in sys.argv:
        dividend_yield(codes)
