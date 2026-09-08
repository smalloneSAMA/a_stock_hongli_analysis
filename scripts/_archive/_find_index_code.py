# -*- coding: utf-8 -*-
"""查 中证800自由现金流指数 的指数代码"""
import requests, re, json

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"}

# 1) 东财 suggest 搜索
for q in ["中证800自由现金流", "自由现金流"]:
    try:
        r = requests.get("https://searchapi.eastmoney.com/api/suggest/get",
            params={"input": q, "type": "14", "count": "10", "token": "D43BF722C8E33BDC906FB84D85E326E8"},
            headers=UA, timeout=10)
        d = r.json()
        items = (d.get("QuotationCodeTable") or {}).get("Data") or []
        for it in items:
            print("EM14:", q, "->", it.get("Code"), it.get("Name"), it.get("MktNum"), it.get("SecurityTypeName"))
    except Exception as e:
        print("em err", q, e)

# 2) 必应搜索增强
try:
    r = requests.get("https://www.bing.com/search",
        params={"q": "中证800自由现金流指数 932"},
        headers={"User-Agent": UA["User-Agent"]}, timeout=15)
    text = re.sub(r'<[^>]+>', ' ', r.text)
    text = re.sub(r'\s+', ' ', text)
    for m in re.finditer(r'932\d{3}', text):
        s = max(0, m.start()-40)
        seg = text[s:m.end()+60]
        print("BING:", seg)
except Exception as e:
    print("bing err", e)
