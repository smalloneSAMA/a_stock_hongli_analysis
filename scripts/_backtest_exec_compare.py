# -*- coding: utf-8 -*-
"""回测执行日口径对比（T31）：t+1 vs t+2 收盘执行 → docs/回测执行日对比.md

只读分析池、跑两遍回测（p90），**不写任何默认产物**（docs/回测报告.md / web/data/backtest.json 保持不变）。
用法: python scripts/_backtest_exec_compare.py
"""
import os, sys, datetime
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _backtest_analysis as bta

GROUPS = ("指数", "ETF", "推荐20", "其他成份股", "自选股")
H = ("1M", "3M", "6M", "12M")


def agg(rows):
    """按分组聚合 → {分组: {n, n_buy, ex{h}, win{h}, pos12}}（全量 = 所有有效标的）"""
    out = {}
    for g in ("全量",) + GROUPS:
        sub = [r for r in rows if "skip" not in r and (g == "全量" or r.get("group") == g)]
        if not sub:
            out[g] = None
            continue
        out[g] = {
            "n": len(sub),
            "n_buy": int(sum(r["n_buy"] for r in sub)),
            "ex": {h: float(np.mean([r["excess"][h] for r in sub])) for h in H},
            "win": {h: float(np.mean([r["win_rate"][h] for r in sub])) for h in H},
            "pos12": 100.0 * sum(1 for r in sub if r["excess"]["12M"] > 0) / len(sub),
        }
    return out


def fmt(v, signed=True):
    if v is None:
        return "—"
    return (f"{v:+.2f}" if signed else f"{v:.2f}") + "%"


def main():
    data, group_of = bta.load_pool_and_groups()
    n_pool = sum(1 for v in data.values() if v.get("dy0") is not None)
    res = {}
    for off in (1, 2):
        print(f"═══ 跑 t+{off} 口径（分析池 {n_pool} 标的，p90）═══")
        res[off] = bta.collect_results((90,), data, group_of, exec_offset=off, verbose=False)[90]
    a1, a2 = agg(res[1]), agg(res[2])

    lines = []
    lines.append("# 回测执行日口径对比（t+1 vs t+2 收盘执行）")
    lines.append("")
    lines.append(f"> 生成日期：{datetime.date.today()} ｜ 分位：p90 ｜ 窗口：5 年滚动（数据不足用全部） ｜ 分析池 {n_pool} 标的")
    lines.append("> 口径：信号在 t 日收盘确认；**t+1 收盘执行**（现行默认）vs **t+2 收盘执行**（研究口径）；"
                 "收益为价格口径（不含分红再投），自执行日收盘起算")
    lines.append("> 超额 = 信号组平均收益 − 同区间每日买入基准；正超额 = 少亏也赢")
    lines.append("> 本报告由 scripts/_backtest_exec_compare.py 生成，**不改默认口径产物**")
    lines.append("")
    lines.append("## 一、平均超额（单位 %，Δ = t+2 − t+1）")
    lines.append("")
    lines.append("| 分组 | 有效 | 信号数 | " + " | ".join(f"{h} t+1 | {h} t+2 | Δ{h}" for h in H) + " |")
    lines.append("|" + "---|" * (3 + len(H) * 3))
    for g in ("全量",) + GROUPS:
        x, y = a1[g], a2[g]
        if not x or not y:
            lines.append(f"| {g} | — | — | " + " | ".join("—" for _ in range(len(H) * 3)) + " |")
            continue
        cells = []
        for h in H:
            cells += [fmt(x["ex"][h]), fmt(y["ex"][h]), f"{y['ex'][h] - x['ex'][h]:+.2f}"]
        lines.append(f"| {g} | {x['n']} | {x['n_buy']} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## 二、平均胜率（单位 %，Δ = t+2 − t+1）")
    lines.append("")
    lines.append("| 分组 | " + " | ".join(f"{h} t+1 | {h} t+2 | Δ{h}" for h in H) + " |")
    lines.append("|" + "---|" * (len(H) * 3))
    for g in ("全量",) + GROUPS:
        x, y = a1[g], a2[g]
        if not x or not y:
            lines.append(f"| {g} | " + " | ".join("—" for _ in range(len(H) * 3)) + " |")
            continue
        cells = []
        for h in H:
            cells += [fmt(x["win"][h], signed=False), fmt(y["win"][h], signed=False), f"{y['win'][h] - x['win'][h]:+.1f}"]
        lines.append(f"| {g} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## 三、12M 正超额占比（标的层面，Δ = t+2 − t+1）")
    lines.append("")
    lines.append("| 分组 | t+1 | t+2 | Δ |")
    lines.append("|---|---|---|---|")
    for g in ("全量",) + GROUPS:
        x, y = a1[g], a2[g]
        if not x or not y:
            lines.append(f"| {g} | — | — | — |")
            continue
        lines.append(f"| {g} | {x['pos12']:.0f}% | {y['pos12']:.0f}% | {y['pos12'] - x['pos12']:+.0f} |")
    lines.append("")
    lines.append("## 四、结论（T32 决策门输入）")
    lines.append("")
    for g in ("指数", "ETF", "推荐20", "全量"):
        x, y = a1[g], a2[g]
        if not x or not y:
            continue
        d6 = y["ex"]["6M"] - x["ex"]["6M"]
        d12 = y["ex"]["12M"] - x["ex"]["12M"]
        flip = (x["ex"]["12M"] > 0) != (y["ex"]["12M"] > 0)
        if flip:
            verdict = "结论反转（符号相反）"
        elif abs(d12) < 0.5:
            verdict = f"两者等价（|Δ|={abs(d12):.2f}pp < 0.5pp）"
        elif d12 > 0:
            verdict = "t+2 更强"
        else:
            verdict = "t+1 更强"
        lines.append(f"- **{g}**：12M 超额 t+1 {x['ex']['12M']:+.2f}% → t+2 {y['ex']['12M']:+.2f}%（Δ{d12:+.2f}pp）；"
                     f"6M Δ{d6:+.2f}pp；胜率12M {x['win']['12M']:.1f}% → {y['win']['12M']:.1f}% → **{verdict}**")
    lines.append("")
    lines.append("> 判读提示：若两个口径结论同向（符号一致、量级接近），说明该信号对执行日不敏感，"
                 "维持 t+1 即可；若 t+2 明显更强或结论反转，需评估是否改默认口径（并同步重跑全部产物）。")
    lines.append("")
    lines.append("## 五、决策记录（T32）")
    lines.append("")
    key_groups = [g for g in ("指数", "ETF", "推荐20") if a1[g] and a2[g]]
    c1 = all(abs(a2[g]["ex"]["12M"] - a1[g]["ex"]["12M"]) < 0.5
             and (a1[g]["ex"]["12M"] > 0) == (a2[g]["ex"]["12M"] > 0) for g in key_groups)
    c2 = all(abs(a2[g]["pos12"] - a1[g]["pos12"]) <= 2 for g in key_groups)
    c3 = all(abs(a2[g]["win"]["12M"] - a1[g]["win"]["12M"]) <= 1.1 for g in key_groups)
    lines.append("判据（三条**同时**满足即视为信号对执行日不敏感、无需改默认口径）：")
    lines.append("")
    lines.append("| 判据 | 阈值 | 结果 |")
    lines.append("|---|---|---|")
    lines.append(f"| ① 关键分组（指数/ETF/推荐20）12M 超额 \|Δ\| 且无符号反转 | < 0.5pp | {'✅ 通过' if c1 else '❌ 不通过'} |")
    lines.append(f"| ② 关键分组 12M 正超额占比变化 | ≤ 2pp | {'✅ 通过' if c2 else '❌ 不通过'} |")
    lines.append(f"| ③ 关键分组胜率 12M 变化 | ≤ 1.1pp | {'✅ 通过' if c3 else '❌ 不通过'} |")
    lines.append("")
    if c1 and c2 and c3:
        lines.append("**决策：维持默认口径 t+1（次一交易日收盘执行），不改。**")
        lines.append("")
        lines.append("理由：三个关键分组的 12M 超额差异均 < 0.5pp 且无符号反转，正超额占比与胜率变化可忽略——"
                     "信号对执行日不敏感；改口径会破坏历史报告可比性而无收益，故不动默认口径与产物。")
    else:
        lines.append("**决策：需人工复核（存在对执行日敏感的关键分组）**，"
                     "若确认 t+2 更优则改默认口径并全量重跑产物（独立 commit + 在回测报告注明口径）。")
    lines.append("")
    path = os.path.join(BASE, "docs", "回测执行日对比.md")
    open(path, "w", encoding="utf-8").write("\n".join(lines))
    print("✅ docs/回测执行日对比.md 已生成")
    for g in ("指数", "ETF", "推荐20", "全量"):
        if a1[g] and a2[g]:
            print(f"  {g:6s} 12M 超额 t+1 {a1[g]['ex']['12M']:+.2f}% → t+2 {a2[g]['ex']['12M']:+.2f}%")


if __name__ == "__main__":
    main()
