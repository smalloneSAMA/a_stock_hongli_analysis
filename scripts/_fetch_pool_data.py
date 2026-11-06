# -*- coding: utf-8 -*-
"""其他成份股（精选池 289 − 推荐 20）历史数据拉取 / 增量更新

数据：K线（腾讯，2004 起，未上市自然从上市日起）+ 分红/财报/股本（东财）
防封（N9/T162）：腾讯源**串行**，限速/封禁等待全部由 _common.tencent_json 统一（全局限速 1.0s/请求；
      撞 501 时全局睡到解封再续，不逐只失败；成功后速率缓慢回落），
      东财仍由 em_get 全局 1s/请求串行；连续 5 次失败熔断暂停 60s、
      断点续拉（缓存存在跳过）、失败清单 cache/_pool_failed.json（--retry-failed 只补失败）；
      整轮出现部分失败时自动补拉一轮
成分股变动：每次运行自动 diff（目标 = 最新汇总表 − 推荐20），新调入的股票自动全量拉取

用法:
  python scripts/_fetch_pool_data.py               # 增量：K线增量 + 缺失补齐（约3分钟）
  python scripts/_fetch_pool_data.py --batch 50    # 首次分批：只处理尚无K线缓存的前 50 只
  python scripts/_fetch_pool_data.py --retry-failed # 只重试失败清单
  python scripts/_fetch_pool_data.py --check-fin   # 季度分红/财报/股本检测（约 15 分钟）
"""
import argparse
import json
import os
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))

import _fetch_history as fh
import _fetch_stock_data as fsd

FAIL_PATH = os.path.join(BASE, "cache", "_pool_failed.json")
STALE_PATH = os.path.join(BASE, "cache", "_stale.json")   # 陈旧检测报告（T1，各池分段合并）
CONCURRENCY = 1        # 腾讯 K 线串行：实测 3 并发即使全局限速 1s 也会在 ~130 个请求后触发 501，
                       # 只有「串行 + 每只约 1s」的口径实测能连续拉完 308 只（见困难总结 162）
MELT_LIMIT = 5         # 连续失败熔断阈值
MELT_PAUSE = 60        # 熔断暂停（秒）


from _common import (  # 唯一正确版本（92→bj 先于 9x；全名语义）
    STALE_GAP_DAYS,
    TENCENT_BAN_WAIT,  # 腾讯 501 封禁冷却（秒），补拉一轮前等待
    atomic_dump,
    find_stale,  # T1 陈旧检测
    is_bj,  # T6 北交所剔除（R2）
    market_prefix,
    parallel_map,
    update_stale_report,
)


def pool_codes():
    """其他成份股 = 成分股汇总表（精选池 289）− 推荐 20 → [(code, name, tcode)]"""
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if not os.path.exists(t_path):
        print("⚠️  缺少 cache/_成分股汇总表.json，请先运行 update.py 选项4")
        return []
    table = json.load(open(t_path, encoding="utf-8"))
    rec = {c for c, _, _ in fsd.STOCKS}
    out = [(r["code"], r.get("name", r["code"]), market_prefix(r["code"]))
           for r in table if r["code"] not in rec and not is_bj(r["code"])]   # 北交所剔除（R2）
    return out


def load_failed():
    try:
        return json.load(open(FAIL_PATH, encoding="utf-8"))
    except OSError:
        return {}


def save_failed(f):
    atomic_dump(FAIL_PATH, f)


def fetch_one(code, name, tcode):
    """单只：K线增量 + 分红/财报/股本缺失补齐。抛异常表示 K 线失败（入失败清单）。
    返回 K 线增量结果 (新增条数, 总条数, 最后日期)——供 main 做陈旧检测（T1）"""
    ret = fh.update_incremental("股票", code, name, fsd.make_fetcher(tcode, code))
    fsd.update_dividends(codes=[code])
    fsd.update_financials(codes=[code])
    fsd.update_share_hist(codes=[code])
    return ret


def main(batch=0, retry_failed=False, check_fin=False):
    pool = pool_codes()
    if not pool:
        return
    if check_fin:
        print(f"═══ 其他成份股分红/财报/股本季度检测（{len(pool)} 只）═══")
        fsd.check_financials(codes=[c for c, _, _ in pool])
        fsd.update_share_hist(codes=[c for c, _, _ in pool])
        print("✅ 季度检测完成（后续运行 python scripts/_gen_web_data.py 重算指标）")
        return

    failed = load_failed()
    # 剔除已掉出池内的失败项：这些标的不会再被拉取，条目若不清会永远留在清单里（status 一直报"可重试"）
    pool_set = {c for c, _, _ in pool}
    dropped = sorted(c for c in failed if c not in pool_set)
    if dropped:
        print(f"  清理已不在池内的失败项 {len(dropped)} 只：{'、'.join(dropped[:8])}")
        failed = {c: v for c, v in failed.items() if c in pool_set}
        save_failed(failed)
    todo = pool
    if retry_failed:
        fset = set(failed)
        todo = [(c, n, t) for c, n, t in pool if c in fset]
        if not todo:
            print("✅ 失败清单无待重试项（cache/_pool_failed.json 已清空或全成功）")
            save_failed({})
            return
        print(f"═══ 重试失败清单（{len(todo)} 只）═══")
    elif batch:
        # 首次分批：只取尚无 K 线缓存的前 N 只（有缓存的属于已完成的批次）
        missing = [(c, n, t) for c, n, t in todo if not os.path.exists(fh.cache_path("股票", c))]
        todo = missing[:batch]
        if not todo:
            print("✅ 本批无可拉取项（缓存已齐全，后续直接增量运行即可）")
            return
        print(f"═══ 其他成份股分批拉取（本批 {len(todo)} 只，池共 {len(pool)} 只）═══")
    else:
        print(f"═══ 其他成份股增量更新（{len(pool)} 只）═══")

    new_failed = dict(failed)
    records = []          # [(code, last_date)] —— 陈旧检测（T1）
    t0 = time.time()
    plock = threading.Lock()

    def run_round(round_todo):
        done = {"n": 0, "ok": 0}

        def on_done(_idx, item, ok_i, res):
            with plock:
                done["n"] += 1
                if ok_i:
                    done["ok"] += 1
                n, ok_n = done["n"], done["ok"]
            if not ok_i:
                print(f"  ❌ [{n}/{len(round_todo)}] {item[0]} {item[1]} 拉取失败: {repr(res)[:80]}")
            if n % 10 == 0 or n == len(round_todo):
                print(f"  进度 {n}/{len(round_todo)}（成功 {ok_n}） 已用 {time.time() - t0:.0f}s")

        res = parallel_map(round_todo, lambda it: fetch_one(*it), workers=CONCURRENCY,
                           melt_limit=MELT_LIMIT, melt_pause=MELT_PAUSE, on_done=on_done)
        for (code, name, _), ok_i, r in res:
            if ok_i:
                records.append((code, r[2] if isinstance(r, tuple) else None))
                new_failed.pop(code, None)
            else:
                new_failed[code] = {"name": name, "err": f"{type(r).__name__}: {str(r)[:70]}"}
        save_failed(new_failed)
        return sum(1 for _it, ok_i, _r in res if ok_i)

    ok = run_round(todo)
    fail_n = len(todo) - ok
    print(f"✅ 完成：成功 {ok} / 失败 {fail_n}（失败明细 → cache/_pool_failed.json）")
    # 封禁/抖动造成的部分失败：等封禁冷却过后自动补拉一轮（只一次，避免网络故障时空转两遍）
    if fail_n and ok and not (retry_failed or batch):
        retry_todo = [(c, n, t) for c, n, t in pool if c in new_failed]
        if retry_todo:
            print(f"⚠️  {len(retry_todo)} 只失败，等待 {TENCENT_BAN_WAIT + 15}s（封禁冷却）后自动补拉一轮…")
            time.sleep(TENCENT_BAN_WAIT + 15)
            ok2 = run_round(retry_todo)
            print(f"   补拉完成：成功 {ok2} / 仍失败 {len(retry_todo) - ok2}")
            ok += ok2
            fail_n = len(todo) - ok
    if fail_n:
        print("   下次运行 --retry-failed 只补失败项")
    # ── 陈旧检测（T1）：抓取"成功"但数据没跟上的标的必须可见，不再静默 ──
    base, stale = find_stale(records)
    if base:
        update_stale_report(STALE_PATH, "其他成份股", base, stale)
    if stale:
        print(f"⚠️  数据陈旧 {len(stale)} 只（落后基准 {base} >{STALE_GAP_DAYS} 自然日）："
              + "、".join(f"{c}({l}, {g}天)" for c, l, g in stale[:8])
              + ("…" if len(stale) > 8 else ""))
        print("   详见 cache/_stale.json")
    print("⚠️  随后请运行 update.py 选项7（前端数据包 + 区间分析），或 python scripts/_gen_web_data.py && python scripts/_gen_analysis.py")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=0, help="首次分批：只处理尚无K线缓存的前 N 只")
    ap.add_argument("--retry-failed", action="store_true", help="只重试失败清单")
    ap.add_argument("--check-fin", action="store_true", help="季度分红/财报/股本检测")
    args = ap.parse_args()
    main(batch=args.batch, retry_failed=args.retry_failed, check_fin=args.check_fin)
