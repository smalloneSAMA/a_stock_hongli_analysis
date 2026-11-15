# -*- coding: utf-8 -*-
"""连续天数回溯 · 把 _gen_analysis 截断到历史交易日重算，产出 cache/_replay/an_<date>.json

链路：本脚本（30 个历史截面）→ scripts/_reco_streak.mjs（评分 + 连续判定）→ web/data/reco_streak.json
口径见 docs/智能推荐-连续天数-设计方案.md。回放产物不进 git（约 18MB，运行时生成）。

用法:
  python scripts/_reco_replay.py                  # 回放最近 30 个交易日 → 调用 node 生成连续天数
  python scripts/_reco_replay.py --days 30        # 指定回放天数（交易日）
  python scripts/_reco_replay.py --verify         # 自检：asof=今日 与 web/data/analysis.json 因子分位一致
  python scripts/_reco_replay.py --no-streak      # 只回放，不跑 node
"""
import argparse
import contextlib
import io
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
import _fetch_history as fh
import _fetch_watchlist  # noqa: F401  —— 预导入：该模块 import 时会 sys.stdout.reconfigure
import _gen_analysis as ga

REPLAY = os.path.join(BASE, "cache", "_replay")
CAL_CODE = "000922"          # 交易日历基准（中证红利）


def trading_days(before):
    """交易日历：000922 收盘序列中 < before 的日期（升序）"""
    c = fh.load_cache("指数", CAL_CODE) or {}
    return [r["date"] for r in c.get("rows", []) if r.get("date") and r.get("close") is not None and r["date"] < before]


def production_date():
    with open(os.path.join(BASE, "web", "data", "analysis.json"), encoding="utf-8") as f:
        return json.load(f)["date"]


def replay_one(date, out_path):
    """截断到 date 重算一个截面（静默 main 的控制台输出）"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ga.main(asof=date, out_path=out_path)
    return out_path


def verify():
    """自检：asof=今日 的回放产物应与生产 analysis.json 逐字段一致（截断到今日=无未来数据）"""
    today = production_date()
    tmp = os.path.join(REPLAY, f"_verify_{today}.json")
    replay_one(today, tmp)
    with open(os.path.join(BASE, "web", "data", "analysis.json"), encoding="utf-8") as f:
        prod = json.load(f)
    with open(tmp, encoding="utf-8") as f:
        rep = json.load(f)
    worst, miss, ncmp = 0.0, 0, 0
    for code, ent in prod["by_code"].items():
        other = rep["by_code"].get(code)
        if other is None:
            miss += 1
            continue
        for k, fac in ent.get("factors", {}).items():
            p1 = fac.get("pct")
            p2 = (other.get("factors", {}).get(k) or {}).get("pct")
            if p1 is None or p2 is None:
                continue
            ncmp += 1
            worst = max(worst, abs(p1 - p2))
    os.remove(tmp)
    print(f"自检：比较 {ncmp} 个因子分位，缺标的 {miss}，最大差 {worst:.6f} → {'✅ 通过' if worst <= 0.1 and not miss else '❌ 失败'}")
    return worst <= 0.1 and not miss


def main(days=30, run_streak=True):
    today = production_date()
    hist = trading_days(today)[-days:]
    if not hist:
        raise SystemExit("交易日历为空，检查 cache/指数_000922.json")
    os.makedirs(REPLAY, exist_ok=True)
    print(f"═══ 连续天数回溯：{hist[0]} ~ {hist[-1]}（{len(hist)} 个交易日）═══")
    for i, d in enumerate(hist, 1):
        out = os.path.join(REPLAY, f"an_{d}.json")
        replay_one(d, out)
        print(f"  [{i:>2}/{len(hist)}] {d} → {os.path.relpath(out, BASE)}")
    print(f"✅ 回放完成（{len(hist)} 个截面，{REPLAY}）")
    if run_streak:
        if not _node_available():
            print("⚠️ 未找到 node，跳过连续天数生成（可手动：node scripts/_reco_streak.mjs）")
            return
        r = subprocess.run(["node", os.path.join(BASE, "scripts", "_reco_streak.mjs"), "--check"],
                           cwd=BASE)
        if r.returncode:
            raise SystemExit(r.returncode)


def _node_available():
    from shutil import which
    return which("node") is not None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="回放交易日数（默认 30）")
    ap.add_argument("--verify", action="store_true", help="只做 asof=今日 的一致性自检")
    ap.add_argument("--no-streak", action="store_true", help="只回放，不生成连续天数")
    a = ap.parse_args()
    if a.verify:
        sys.exit(0 if verify() else 1)
    main(days=a.days, run_streak=not a.no_streak)
