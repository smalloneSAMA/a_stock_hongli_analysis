# -*- coding: utf-8 -*-
"""候选红利指数: PE/PB/近1年/近3年收益(腾讯源)"""
import json, urllib.request, time

UA = {"User-Agent": "Mozilla/5.0"}

# 指数: 代码 -> (名称, 腾讯符号)
IDX = {
    "000922": ("中证红利", "sh000922"),
    "000015": ("上证红利", "sh000015"),
    "399324": ("深证红利", "sz399324"),
    "399321": ("国证红利", "sz399321"),
    "000821": ("沪深300红利", "sh000821"),
    "000822": ("中证500红利", "sh000822"),
    "000824": ("中证国企红利", "sh000824"),
    "000825": ("中证央企红利", "sh000825"),
    "000151": ("上证国企红利", "sh000151"),
    "000152": ("上证央企红利", "sh000152"),
    "H30269": ("中证红利低波动", "shh30269"),
    "930955": ("红利低波动100", "sh930955"),
    "932315": ("中证全指红利质量", "sh932315"),
    "931468": ("中证红利质量", "sh931468"),
    "H30270": ("中证红利价值", "shh30270"),
}

def quote(sym):
    url = "https://qt.gtimg.cn/q=" + sym
    req = urllib.request.Request(url, headers=UA)
    data = urllib.request.urlopen(req, timeout=10).read().decode("gbk")
    if '"' not in data:
        return None
    vals = data.split('"')[1].split("~")
    if len(vals) < 53:
        return None
    return {"name": vals[1], "price": float(vals[3] or 0),
            "pe_ttm": float(vals[39] or 0), "pb": float(vals[46] or 0)}

def kline(sym, days=800):
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
           f"param={sym},day,,,{days},qfq")
    req = urllib.request.Request(url, headers=UA)
    d = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
    node = d["data"][sym]
    k = node.get("qfqday") or node.get("day") or []
    return [float(r[2]) for r in k]

print("=== 指数行情(2026-08-02) ===")
for code, (name, sym) in IDX.items():
    try:
        q = quote(sym)
    except Exception:
        q = None
    if not q:
        print(f"{code} {name}: 腾讯无此指数代码")
        continue
    time.sleep(0.15)
    try:
        c = kline(sym)
        r1 = (c[-1]/c[-1-250]-1)*100 if len(c) > 250 else None
        r3 = (c[-1]/c[-1-750]-1)*100 if len(c) > 750 else None
        s = f" 近1年{r1:.1f}% 近3年{r3:.1f}%" if r1 is not None and r3 is not None else ""
    except Exception:
        s = ""
    print(f"{code} {q['name']}: 点位{q['price']:.1f} PE(TTM){q['pe_ttm']:.1f} PB{q['pb']:.1f}{s}")
