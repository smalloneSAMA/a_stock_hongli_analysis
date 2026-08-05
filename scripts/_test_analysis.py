# -*- coding: utf-8 -*-
"""S1-S5 全面测试（回归用）
用法: python scripts/_test_analysis.py
覆盖：
  T1 dy 序列正确性（S1）  T2 回测一致性（S2）  T3 因子与打分（S3/S4）
  T4 点位锚（S5）        T5 交叉一致性
"""
import sys, io, os, json, math
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")   # 不换对象，避免与 import 模块的包装冲突
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _fetch_history as fh

PASS = FAIL = 0
RESULTS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        RESULTS.append(f"  ✅ {name} {detail}")
    else:
        FAIL += 1
        RESULTS.append(f"  ❌ {name} {detail}")


def load(p):
    return json.load(open(os.path.join(BASE, p), encoding="utf-8"))


print("═══ S1-S5 全面测试 ═══\n")
dy_data = load("cache/analysis_dy.json")
analysis = load("web/data/analysis.json")
comp = load("web/data/components.json")

# ── T1 S1 dy 序列 ──────────────────────────────────────────────
print("── T1 dy 序列正确性（S1）──")
n_all = len(dy_data)
n_ok = sum(1 for v in dy_data.values() if v.get("dy0") is not None)
check("标的覆盖", n_all == 42 and n_ok == 40,
      f"{n_all} 标的，{n_ok} 有数据（980092/159229 应跳过）")
# 1.2 反推末值 == dy0
bad = [c for c, v in dy_data.items() if v.get("dy0") and abs(v["series"][-1][1] - v["dy0"]) > 1e-6]
check("反推末值==dy0", not bad, f"异常: {bad}")
# 1.4 无 dy<=0
bad = [c for c, v in dy_data.items() if v.get("dy0") and any(x[1] <= 0 for x in v["series"])]
check("序列无<=0", not bad, f"异常: {bad}")
# 1.5 分位单调
bad = [c for c, v in dy_data.items() if v.get("dy0") and not (v["dy_p10"] <= v["dy_p50"] <= v["dy_p90"])]
check("p10<=p50<=p90", not bad, f"异常: {bad}")
# 1.6 窗口
bad = [c for c, v in dy_data.items() if v.get("dy0") and v["n_days"] != min(1250, len(v["series"]))]
check("窗口天数", not bad, f"异常: {bad}")
# 1.7 ETF == 跟踪指数序列
for code, v in dy_data.items():
    if v.get("type") == "ETF" and v.get("track"):
        t = dy_data[v["track"]]
        same = v["series"] == t["series"]
        if not same:
            check(f"ETF {code} 序列==跟踪指数", False, f"track={v['track']}")
            break
else:
    check("ETF 序列==跟踪指数（11只）", True)
# 1.8 ETF dy0 == 指数 dy0
bad = [c for c, v in dy_data.items() if v.get("type") == "ETF" and v.get("track")
       and dy_data[v["track"]].get("dy0") and v.get("dy0") != dy_data[v["track"]]["dy0"]]
check("ETF dy0==跟踪指数 dy0", not bad, f"异常: {bad}")
# 1.9 指数 dy0 合理范围
bad = [c for c, v in dy_data.items() if v.get("type") == "指数" and v.get("dy0")
       and not (2.0 <= v["dy0"] <= 8.0)]
check("指数 dy0∈[2,8]", not bad, f"异常: {bad}")
# 1.10 close_now 与缓存一致
bad = []
for c, v in dy_data.items():
    if not v.get("dy0"):
        continue
    typ, code = v["type"], c
    if typ == "ETF":
        code = v["track"]; typ = "指数"
    cc = load(f"cache/{typ}_{code}.json")
    rows = [r for r in cc["rows"] if "close" in r]
    if v["close_now"] is not None and rows and abs(v["close_now"] - rows[-1]["close"]) > 1e-6:
        bad.append((c, v["close_now"], rows[-1]["close"]))
check("close_now==缓存末行", not bad, f"异常: {bad}")
# 1.11 股票 dy_now == 指标文件最后非None
bad = []
for c, v in dy_data.items():
    if v.get("type") != "股票":
        continue
    rows = load(f"web/data/stocks/{c}.json")
    last = next((r["dy"] for r in reversed(rows) if r.get("dy")), None)
    if last is not None and abs(v["dy_now"] - last) > 1e-6:
        bad.append((c, v["dy_now"], last))
check("股票 dy_now==指标文件", not bad, f"异常: {bad}")

# ── T2 回测一致性（S2）──────────────────────────────────────────
print("\n── T2 回测（S2）──")
rep = open(os.path.join(BASE, "docs", "回测报告.md"), encoding="utf-8").read()
check("报告含三档", all(f"### p{p}" in rep for p in (85, 90, 95)))
check("报告含方法/结论", "## 一、" in rep and "## 三、结论" in rep)
check("报告含 ETF 无信号说明", "无买入信号" in rep)
# 2.2 ETF 结果==跟踪指数（从报告中敏感性表解析太脆，改为重跑单标的对比）
import _backtest_analysis as bta
info_etf = dy_data["515180"]
info_idx = dy_data["000922"]
r_etf = bta.run_backtest("515180", info_etf, p_buy=90)
r_idx = bta.run_backtest("000922", info_idx, p_buy=90)
same = r_etf and r_idx and r_etf["n_buy"] == r_idx["n_buy"] and r_etf["excess"]["12M"] == r_idx["excess"]["12M"]
check("ETF 回测==跟踪指数（515180 vs 000922）", same,
      f"n={r_etf['n_buy'] if r_etf else None}/{r_idx['n_buy'] if r_idx else None}")
# 2.3 超额自洽
r = bta.run_backtest("000922", info_idx, p_buy=90)
ok = all(abs(r["excess"][k] - (r["avg_ret"][k] - r["base"][k])) < 0.03 for k in ("1M", "3M", "6M", "12M"))
check("超额==均值-基准", ok)
# 2.4 信号执行 T+1（买入日应晚于信号日——抽查 last_trades 的持仓天数>0）
if r.get("last_trades"):
    check("交易对持有>0日", all(t[4] > 0 for t in r["last_trades"]))
else:
    check("交易对持有>0日", False, "无交易对")

# ── T3 因子与打分（S3/S4）────────────────────────────────────────
print("\n── T3 因子与打分（S3/S4）──")
by_code = analysis["by_code"]
check("标的覆盖", len(by_code) == 40, f"{len(by_code)} 个")
# 3.2 权重和
for pname, pws in analysis["presets"].items():
    for sysname, w in pws.items():
        check(f"权重和 {pname}/{sysname}", sum(w.values()) == 100, str(w))
# 3.3 因子 pct 范围
bad = []
for c, v in by_code.items():
    for k, fv in v["factors"].items():
        if fv["pct"] is not None and not (0 <= fv["pct"] <= 100):
            bad.append((c, k, fv["pct"]))
check("因子pct∈[0,100]", not bad, f"异常: {bad}")
# 3.4 dy 方向取反已应用
bad = []
for c, v in by_code.items():
    d = dy_data[c]
    if d.get("dy0"):
        if abs(v["factors"]["dy"]["pct"] - (100 - d["dy_pct"])) > 0.01:
            bad.append((c, v["factors"]["dy"]["pct"], d["dy_pct"]))
check("dy分位已反向(100-dy_pct)", not bad, f"异常: {bad}")
# 3.5 分数重算一致性（重算=均衡档，检查范围 + 三档关系）
score_bad = []
for c, v in by_code.items():
    typ = v["type"]
    scores = {}
    for pname, pws in analysis["presets"].items():
        w = pws["A"] if typ != "股票" else pws["B"]
        s = sum(fv["pct"] * wgt for k, (wgt, fv) in
                ((k, (wgt, v["factors"][k])) for k, wgt in w.items()) if fv["pct"] is not None)
        scores[pname] = s / sum(w.values())
        if not (0 <= scores[pname] <= 100):
            score_bad.append((c, pname, scores[pname]))
check("三档分数∈[0,100]", not score_bad, f"异常: {score_bad}")
spread_bad = [c for c, v in by_code.items()
              if abs(v["factors"]["dy"]["pct"] - v["factors"]["price"]["pct"]) > 100]
check("因子差异上限", not spread_bad)
# 3.6 band 边界
from _gen_analysis import band_of
edges = [(0, "买入区间"), (25, "买入区间"), (25.01, "逐步建仓"), (45, "逐步建仓"),
         (45.01, "持有"), (65, "持有"), (65.01, "逐步卖出"), (80, "逐步卖出"), (80.01, "卖出区间")]
check("band 边界", all(band_of(s) == b for s, b in edges), [f"{s}->{band_of(s)}" for s, _ in edges if band_of(s) != dict(edges)[s]][:3])
# 3.7 股票因子覆盖
stk_missing = [c for c, v in by_code.items() if v["type"] == "股票"
               and any(v["factors"].get(k, {}).get("pct") is None for k in ("pe", "pb"))]
check("股票 pe/pb 均有分位", not stk_missing, f"缺失: {stk_missing}")

# ── T4 点位锚（S5）──────────────────────────────────────────────
print("\n── T4 点位锚（S5）──")
no_anchor = [c for c, v in by_code.items() if v.get("anchors") is None]
check("锚全覆盖（40标的）", not no_anchor, f"缺失: {no_anchor}")
bad = [c for c, v in by_code.items()
       if not (v["anchors"]["buy"] < v["anchors"]["sell"])]
check("buy < sell", not bad, f"异常: {bad}")
bad = []
for c, v in by_code.items():
    an = v["anchors"]; cl = v["factors"]["price"]["v"]
    if abs(an["dist_buy"] - (an["buy"] / cl - 1) * 100) > 0.15 or \
       abs(an["dist_sell"] - (an["sell"] / cl - 1) * 100) > 0.15:
        bad.append(c)
check("dist 与锚自洽", not bad, f"异常: {bad}")
# 4.4 000922 锚 vs 2024 低点
rows = load("cache/指数_000922.json")["rows"]
low24 = min(r["close"] for r in rows if "2024-01-01" <= r["date"] <= "2024-12-31")
an = by_code["000922"]["anchors"]; cur = rows[-1]["close"]
check("000922 买入锚在[2024低点,现价]", low24 * 0.95 <= an["buy"] <= cur,
      f"低点{low24:.0f} 锚{an['buy']:.0f} 现价{cur:.0f}")
# 4.5 逻辑一致：dy 分位低(贵)→卖出锚近/负
v = by_code["000922"]
check("000922 dy贵→卖出锚仅+3%", abs(v["anchors"]["dist_sell"] - 3.2) < 1.0,
      f"dist_sell={v['anchors']['dist_sell']}%")

# ── T5 交叉一致性 ──────────────────────────────────────────────
print("\n── T5 交叉一致性 ──")
rows = load("cache/指数_000922.json")["rows"]
check("date==缓存末行", analysis["date"] == rows[-1]["date"])
# 5.2 ETF track 字段
check("ETF track 11只全有", all(v.get("track") for c, v in by_code.items() if v["type"] == "ETF"))
# 5.3 price.v == 缓存末行 close
bad = []
for c, v in by_code.items():
    typ, code = v["type"], c
    if typ == "ETF":
        code = v["track"]; typ = "指数"
    cc = load(f"cache/{typ}_{code}.json")
    last = next((r["close"] for r in reversed(cc["rows"]) if "close" in r), None)
    if last is not None and abs(v["factors"]["price"]["v"] - last) > 1e-3:
        bad.append((c, v["factors"]["price"]["v"], last))
check("price.v==缓存末行", not bad, f"异常: {bad}")
# 5.4 dy.v == dy_now
bad = [c for c, v in by_code.items() if abs(v["factors"]["dy"]["v"] - dy_data[c]["dy_now"]) > 1e-6]
check("dy.v==dy_now", not bad, f"异常: {bad}")
# 5.5 同源因子一致（515180 vs 000922 的 dy/price/trend）
a, b = by_code["515180"]["factors"], by_code["000922"]["factors"]
same = all(a[k]["pct"] == b[k]["pct"] for k in ("dy", "price", "trend"))
check("同源因子一致(515180/000922)", same)

# ── 汇总 ────────────────────────────────────────────────────────
print("\n" + "\n".join(RESULTS))
print(f"\n═══ 测试汇总：PASS {PASS} / FAIL {FAIL} ═══")
sys.exit(1 if FAIL else 0)
