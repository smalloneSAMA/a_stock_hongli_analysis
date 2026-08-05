# -*- coding: utf-8 -*-
"""买卖区间分析 · S2：股息率分位信号回测（并行验证，独立于主流程）

信号定义（5年滚动窗口）：
  - 买入：dy 上穿 p_buy 分位（dy 进入历史高位区=便宜）→ 次一交易日收盘执行
  - 卖出：dy 下穿 (100-p_buy) 分位（dy 跌入历史低位区=贵）→ 次一交易日收盘执行
统计：信号后 1/3/6/12 个月收益（价格口径，不含分红再投）vs 全期每日买入基准（同口径）
产出：docs/回测报告.md + 控制台摘要
用法: python scripts/_backtest_analysis.py [--only 000922] [--p 90]
"""
import sys, io, os, json, argparse, datetime
import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")   # 不换对象，import 无副作用（避免二次包装关闭 buffer）
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _fetch_history as fh
import _fetch_stock_data as fsd

WINDOW = 1250                       # 5年交易日滚动窗口
HORIZONS = (21, 63, 126, 252)       # 1/3/6/12 个月（交易日）
H_LABEL = ("1M", "3M", "6M", "12M")
MIN_LEN = 300                       # 序列不足则跳过（信号样本太少无意义）


def load_analysis():
    return json.load(open(os.path.join(BASE, "cache", "analysis_dy.json"), encoding="utf-8"))


def merge_close(typ, code, info):
    """(date, dy) 序列 + 缓存 close 按日期合并 → [(date, dy, close)]
    ETF 用跟踪指数的完整行情（自身上市短、rolling 窗口失效；ETF 区间=跟踪指数区间）"""
    if typ == "ETF":
        code = info.get("track") or code
    p = fh.cache_path(typ if typ != "ETF" else "指数", code)
    if not os.path.exists(p):
        return []
    c = json.load(open(p, encoding="utf-8"))
    cmap = {r["date"]: r["close"] for r in c.get("rows", []) if "close" in r}
    return [(d, v, cmap[d]) for d, v in info["series"] if d in cmap]


def run_backtest(code, info, p_buy=90):
    """单标的回测：返回统计 dict 或 None（数据不足/无信号）"""
    rows = merge_close(info["type"], code, info)
    n = len(rows)
    if n < MIN_LEN:
        return {"code": code, "name": info["name"], "type": info["type"], "skip": "序列过短"}
    dates = [r[0] for r in rows]
    dy = np.array([r[1] for r in rows], dtype=float)
    close = np.array([r[2] for r in rows], dtype=float)
    w = min(WINDOW, n - 100)   # 数据不足5年用全部（留100天回测）

    # 滚动分位（raw 加速）：窗口内比当前 dy 小的占比×100
    pct = pd.Series(dy).rolling(w).apply(lambda x: 100.0 * np.mean(x < x[-1]), raw=True).values

    # 信号（t 日收盘确认，t+1 执行）→ 执行日索引
    buy_ex = np.where((pct[1:] >= p_buy) & (pct[:-1] < p_buy))[0] + 1
    sell_ex = np.where((pct[1:] <= 100 - p_buy) & (pct[:-1] > 100 - p_buy))[0] + 1
    buy_ex = buy_ex[buy_ex >= w]   # 窗口冷启动之后
    sell_ex = sell_ex[sell_ex >= w]

    # 信号预测力：执行日起 N 交易日收益
    sig = {h: [] for h in HORIZONS}
    for i in buy_ex:
        if i + HORIZONS[-1] < n:
            for h in HORIZONS:
                sig[h].append(close[i + h] / close[i] - 1)

    # 基准：同区间内每个交易日买入持有 N 日的平均收益
    base = {}
    for h in HORIZONS:
        r = close[w + h:] / close[w:-h] - 1
        base[h] = float(np.mean(r)) if len(r) else 0.0

    # 持仓状态机 → 实际交易对
    bs, ss = set(buy_ex.tolist()), set(sell_ex.tolist())
    pos, trades = None, []
    for t in range(w, n):
        if t in bs and pos is None:
            pos = (t, dates[t], close[t])
        elif t in ss and pos is not None:
            trades.append((pos[1], pos[2], dates[t], close[t],
                           t - pos[0], close[t] / pos[2] - 1))
            pos = None

    if not sig[HORIZONS[0]]:
        return {"code": code, "name": info["name"], "type": info["type"], "skip": "无买入信号"}

    out = {
        "code": code, "name": info["name"], "type": info["type"],
        "n_buy": len(buy_ex), "n_trades": len(trades),
        "win_rate": {H_LABEL[k]: round(100.0 * np.mean(np.array(sig[h]) > 0), 1) for k, h in enumerate(HORIZONS)},
        "avg_ret": {H_LABEL[k]: round(float(np.mean(sig[h])) * 100, 2) for k, h in enumerate(HORIZONS)},
        "excess": {H_LABEL[k]: round((float(np.mean(sig[h])) - base[h]) * 100, 2) for k, h in enumerate(HORIZONS)},
        "base": {H_LABEL[k]: round(base[h] * 100, 2) for k, h in enumerate(HORIZONS)},
        "last_trades": trades[-4:],
    }
    return out


def md_escape(s):
    return s.replace("|", "\\|")


def build_report(results_by_p, order=(85, 90, 95)):
    lines = []
    lines.append("# 股息率分位信号回测报告")
    lines.append("")
    lines.append(f"> 生成日期：{datetime.date.today()} ｜ 窗口：5年滚动（数据不足用全部）")
    lines.append("> 口径：收益为**价格口径**（不含分红再投）；信号次一交易日收盘执行；基准=同区间每日买入平均收益")
    lines.append("> 信号：dy 上穿 p 分位=买、下穿 (100-p) 分位=卖；ETF 用跟踪指数序列")
    lines.append("")

    # 一、明细（第一档）
    lines.append(f"## 一、p{order[0]} 分位明细（信号后 1/3/6/12 个月）")
    lines.append("")
    lines.append("| 代码 | 名称 | 类型 | 信号数 | 胜率1M | 胜率3M | 胜率6M | 胜率12M | 超额1M | 超额3M | 超额6M | 超额12M |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in results_by_p[order[0]]:
        if "skip" in r:
            lines.append(f"| {r['code']} | {md_escape(r['name'])} | {r['type']} | — | — | — | — | — | — | — | — | — | ｜ {r['skip']} |")
            continue
        w = r["win_rate"]; e = r["excess"]
        lines.append(f"| {r['code']} | {md_escape(r['name'])} | {r['type']} | {r['n_buy']} "
                     f"| {w['1M']}% | {w['3M']}% | {w['6M']}% | {w['12M']}% "
                     f"| {e['1M']:+.2f}% | {e['3M']:+.2f}% | {e['6M']:+.2f}% | {e['12M']:+.2f}% |")
    lines.append("")

    # 二、敏感性
    lines.append("## 二、参数敏感性（" + " / ".join(f"p{p}" for p in order) + "）")
    lines.append("")
    head = " | ".join([f"信号数p{p}" for p in order] + [f"超额12M-p{p}" for p in order])
    lines.append(f"| 代码 | 名称 | 类型 | {head} |")
    lines.append("|" + "---|" * (3 + len(order) * 2))
    codes = [r["code"] for r in results_by_p[order[0]]]
    for code in codes:
        def cell(p, key):
            r = next((x for x in results_by_p[p] if x["code"] == code), None)
            if r is None or "skip" in r:
                return "—"
            return str(r[key]) if key == "n_buy" else f"{r['excess']['12M']:+.2f}%"
        cells = [cell(p, "n_buy") for p in order] + [cell(p, "excess12") for p in order]
        name = next(r["name"] for r in results_by_p[order[0]] if r["code"] == code)
        typ = next(r["type"] for r in results_by_p[order[0]] if r["code"] == code)
        lines.append(f"| {code} | {md_escape(name)} | {typ} | {' | '.join(cells)} |")
    lines.append("")

    # 三、结论
    lines.append("## 三、结论")
    lines.append("")
    for p in order:
        valid = [r for r in results_by_p[p] if "skip" not in r]
        if not valid:
            continue
        pos6 = [r for r in valid if r["excess"]["6M"] > 0]
        pos12 = [r for r in valid if r["excess"]["12M"] > 0]
        avg6 = float(np.mean([r["excess"]["6M"] for r in valid]))
        avg12 = float(np.mean([r["excess"]["12M"] for r in valid]))
        idx = [r for r in valid if r["type"] == "指数"]
        stk = [r for r in valid if r["type"] == "股票"]
        lines.append(f"### p{p}")
        lines.append(f"- 有效标的 {len(valid)} 个：6M 正超额 {len(pos6)} 个（{100.0*len(pos6)/len(valid):.0f}%），"
                     f"12M 正超额 {len(pos12)} 个（{100.0*len(pos12)/len(valid):.0f}%）")
        lines.append(f"- 平均超额：6M {avg6:+.2f}% ｜ 12M {avg12:+.2f}%")
        if idx:
            iavg6 = float(np.mean([r["excess"]["6M"] for r in idx]))
            iavg12 = float(np.mean([r["excess"]["12M"] for r in idx]))
            lines.append(f"- 指数（{len(idx)} 个）：6M 平均超额 {iavg6:+.2f}%，12M {iavg12:+.2f}%")
        if stk:
            savg6 = float(np.mean([r["excess"]["6M"] for r in stk]))
            savg12 = float(np.mean([r["excess"]["12M"] for r in stk]))
            lines.append(f"- 股票（{len(stk)} 个）：6M 平均超额 {savg6:+.2f}%，12M {savg12:+.2f}%")
        if idx and iavg6 > 0 and iavg12 > 0:
            lines.append("- **指数/ETF 判定：dy 分位因子有效**（正超额）→ S3 指数体系 dy 权重可用（30~40%）")
        elif idx:
            lines.append("- **指数/ETF 判定：dy 分位因子有效性不足** → 需调权重或放弃")
        if stk and savg6 < 0 and savg12 < 0:
            lines.append("- **股票判定：dy 分位单独使用无效**（高股息陷阱：dy 高=股价已跌，可能继续跌）→ S3 个股 dy 权重应降低，必须与估值/趋势因子配合")
        lines.append("")
    return "\n".join(lines) + "\n"


def main(only=None, p_buy=None, full=False):
    data = load_analysis()
    order = (p_buy,) if p_buy else (85, 90, 95)
    results_by_p = {}
    for p in order:
        print(f"\n═══ 股息率分位信号回测（p_buy={p}，窗口{WINDOW}日）═══")
        results = []
        for code, info in data.items():
            if info.get("dy0") is None:
                continue
            if only and code != only:
                continue
            # 默认仅回测精选池（11指数+11ETF+20推荐股票）；--full 才覆盖全部股票池（307只，较慢）
            if not full and info["type"] == "股票" and code not in {c for c, _, _ in fsd.STOCKS}:
                continue
            r = run_backtest(code, info, p_buy=p)
            results.append(r)
            if "skip" in r:
                print(f"  {code} {info['name']}: {r['skip']}")
            else:
                print(f"  {code} {info['name']:<12} 信号{r['n_buy']:>3}个 交易{r['n_trades']:>2}对 "
                      f"胜率6M {r['win_rate']['6M']}% 超额6M {r['excess']['6M']:+.2f}% 超额12M {r['excess']['12M']:+.2f}%")
        results_by_p[p] = results
    report = build_report(results_by_p, order)
    os.makedirs(os.path.join(BASE, "docs"), exist_ok=True)
    path = os.path.join(BASE, "docs", "回测报告.md")
    open(path, "w", encoding="utf-8").write(report)
    print(f"\n✅ docs/回测报告.md 已生成")

    # S8：结构化输出 → web/data/backtest.json（前端回测报告页）
    def slim(r):
        if "skip" in r:
            return {"code": r["code"], "name": r["name"], "type": r["type"], "skip": r["skip"]}
        return {"code": r["code"], "name": r["name"], "type": r["type"],
                "n_buy": r["n_buy"], "win6": r["win_rate"]["6M"], "win12": r["win_rate"]["12M"],
                "ex6": r["excess"]["6M"], "ex12": r["excess"]["12M"]}
    by_p = {str(p): [slim(r) for r in results_by_p[p]] for p in order}
    summary = {}
    for p in order:
        valid = [r for r in results_by_p[p] if "skip" not in r]
        idx = [r for r in valid if r["type"] == "指数"]
        stk = [r for r in valid if r["type"] == "股票"]
        summary[str(p)] = {
            "n": len(valid),
            "pos6": sum(1 for r in valid if r["excess"]["6M"] > 0),
            "pos12": sum(1 for r in valid if r["excess"]["12M"] > 0),
            "avg6": round(float(np.mean([r["excess"]["6M"] for r in valid])), 2) if valid else 0,
            "avg12": round(float(np.mean([r["excess"]["12M"] for r in valid])), 2) if valid else 0,
            "idx6": round(float(np.mean([r["excess"]["6M"] for r in idx])), 2) if idx else None,
            "idx12": round(float(np.mean([r["excess"]["12M"] for r in idx])), 2) if idx else None,
            "stk6": round(float(np.mean([r["excess"]["6M"] for r in stk])), 2) if stk else None,
            "stk12": round(float(np.mean([r["excess"]["12M"] for r in stk])), 2) if stk else None,
        }
    bt = {"date": str(datetime.date.today()), "order": list(order), "by_p": by_p, "summary": summary}
    os.makedirs(os.path.join(BASE, "web", "data"), exist_ok=True)
    json.dump(bt, open(os.path.join(BASE, "web", "data", "backtest.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print("✅ web/data/backtest.json 已生成（前端回测报告页）")

    # 复盘：000922 最近 4 笔交易（p90）
    r = next((r for r in results_by_p.get(90, []) if r.get("code") == "000922"), None)
    if r and r.get("last_trades"):
        print("\n000922 最近交易复盘：")
        for d0, p0, d1, p1, hold, ret in r["last_trades"]:
            print(f"  买 {d0}@{p0:.1f} → 卖 {d1}@{p1:.1f} 持{hold}日 {ret*100:+.1f}%")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只回测单个代码")
    ap.add_argument("--p", type=int, default=None, help="单档回测（默认三档 p85/90/95）")
    ap.add_argument("--full", action="store_true", help="回测全部股票池（默认仅精选池42只）")
    args = ap.parse_args()
    main(only=args.only, p_buy=args.p, full=args.full)
