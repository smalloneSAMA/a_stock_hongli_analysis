# -*- coding: utf-8 -*-
"""抓取候选红利ETF的规模/成交额/收益率(腾讯源,不封IP)"""
import json, urllib.request, time, re
from _common import tencent_quotes   # 腾讯批量行情（prefix 内部统一）

UA = {"User-Agent": "Mozilla/5.0"}

# 候选ETF: 代码 -> (名称, 类别)
ETFS = {
    # 中证红利
    "515080": ("中证红利ETF招商", "中证红利"),
    "515180": ("红利ETF易方达", "中证红利"),
    "510880": ("红利ETF华泰柏瑞", "上证红利"),
    "159581": ("万家中证红利ETF", "中证红利"),
    "515890": ("红利ETF博时", "中证红利"),
    "560020": ("红利ETF汇添富", "中证红利"),
    "159589": ("红利ETF广发", "中证红利"),
    # 红利低波
    "512890": ("红利低波ETF华泰柏瑞", "红利低波H30269"),
    "563020": ("红利低波ETF易方达", "红利低波H30269"),
    "159549": ("红利低波ETF天弘", "红利低波100"),
    "563510": ("A500红利低波ETF易方达", "A500红利低波"),
    # 红利质量
    "159209": ("红利质量ETF招商", "红利质量932315"),
    "560370": ("红利质量ETF易方达", "红利质量932315"),
    "515460": ("红利质量ETF南方", "红利质量932315"),
    "159758": ("华夏中证红利质量ETF", "红利质量931468"),
    "561630": ("红利质量ETF华泰柏瑞", "红利质量932315"),
    # 红利价值
    "563700": ("红利价值ETF易方达", "红利价值H30270"),
    # 央企/国企红利
    "561580": ("央企红利ETF华泰柏瑞", "央企红利"),
    "159332": ("央企红利ETF富国", "央企红利"),
    "159336": ("央企红利50ETF融通", "诚通央企红利"),
    "561060": ("国企红利ETF", "国企红利"),
    "510720": ("红利国企ETF国泰", "国企红利"),
    # 自由现金流
    "159201": ("自由现金流ETF华夏", "现金流"),
}

def tencent_quote(codes):
    out = {}
    for code, vals in tencent_quotes(codes).items():
        # TODO(L2): v[44]/v[37] 字段语义未对照验证（股票口径 v[45]=市值亿/v[3]=价），保持原行为
        out[code] = {
            "name": vals[1], "price": float(vals[3] or 0),
            "mcap_yi": float(vals[44] or 0),        # ETF: 总市值≈基金规模(亿)
            "amount_yi": float(vals[37] or 0) / 10000,  # 成交额(亿)
        }
    return out

def tencent_kline(code, days=800):
    """腾讯前复权日K, 返回 [(date, close), ...]"""
    sym = ("sh" if code.startswith(("5","6","9")) else "sz") + code
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
           f"param={sym},day,,,{days},qfq")
    req = urllib.request.Request(url, headers=UA)
    d = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
    node = d["data"][sym]
    k = node.get("qfqday") or node.get("day") or []
    return [(r[0], float(r[2])) for r in k]

def ret_1y_3y(closes):
    """近1年(约250交易日) / 近3年(约750) 收益率%"""
    out = {}
    for label, n in (("近1年", 250), ("近3年", 750)):
        if len(closes) > n:
            out[label] = (closes[-1] / closes[-1 - n] - 1) * 100
        else:
            out[label] = None
    # 今年(YTD)
    return out

quotes = tencent_quote(list(ETFS.keys()))
print(f"{'代码':<8}{'名称':<26}{'类别':<18}{'规模亿':>9}{'成交亿':>8}  {'近1年%':>8}{'近3年%':>9}")
rows = []
for code, (name, cat) in ETFS.items():
    q = quotes.get(code, {})
    time.sleep(0.2)
    try:
        k = tencent_kline(code)
    except Exception as e:
        print(code, "kline err", e); continue
    r = ret_1y_3y([c for _, c in k])
    rows.append((code, name, cat, q.get("mcap_yi", 0), q.get("amount_yi", 0), r["近1年"], r["近3年"]))
    print(f"{code:<8}{name:<26}{cat:<18}{q.get('mcap_yi',0):>9.1f}{q.get('amount_yi',0):>8.2f}  "
          f"{(r['近1年'] if r['近1年'] is not None else float('nan')):>8.1f}{(r['近3年'] if r['近3年'] is not None else float('nan')):>9.1f}")

# 排序: 按规模
print("\n=== 按规模排序 ===")
for r in sorted(rows, key=lambda x: -x[3]):
    print(f"{r[0]} {r[1]} 规模{r[3]:.1f}亿 成交{r[4]:.2f}亿 近1年{r[5] if r[5] is not None else 0:.1f}% 近3年{r[6] if r[6] is not None else 0:.1f}%")
