# -*- coding: utf-8 -*-
"""其他成份股（精选池 289 − 推荐 20）历史数据拉取 / 增量更新

数据：K线（腾讯，2004 起，未上市自然从上市日起）+ 分红/财报/股本（东财）
防封：节流 0.8s/只（东财由 _fetch_stock_data 内置 0.3s）、指数退避重试、连续 5 次失败熔断暂停 60s、
      断点续拉（缓存存在跳过）、失败清单 cache/_pool_failed.json（--retry-failed 只补失败）
成分股变动：每次运行自动 diff（目标 = 最新汇总表 − 推荐20），新调入的股票自动全量拉取

用法:
  python scripts/_fetch_pool_data.py               # 增量：K线增量 + 缺失补齐（约3分钟）
  python scripts/_fetch_pool_data.py --batch 50    # 首次分批：只处理尚无K线缓存的前 50 只
  python scripts/_fetch_pool_data.py --retry-failed # 只重试失败清单
  python scripts/_fetch_pool_data.py --check-fin   # 季度分红/财报/股本检测（约 15 分钟）
"""
import sys, os, json, time, argparse

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))

import _fetch_history as fh
import _fetch_stock_data as fsd

FAIL_PATH = os.path.join(BASE, "cache", "_pool_failed.json")
SLEEP_KLINE = 0.8      # 腾讯 K 线节流（秒）
MELT_LIMIT = 5         # 连续失败熔断阈值
MELT_PAUSE = 60        # 熔断暂停（秒）


from _common import market_prefix, atomic_dump   # 唯一正确版本（92→bj 先于 9x；全名语义）


def pool_codes():
    """其他成份股 = 成分股汇总表（精选池 289）− 推荐 20 → [(code, name, tcode)]"""
    t_path = os.path.join(BASE, "cache", "_成分股汇总表.json")
    if not os.path.exists(t_path):
        print("⚠️  缺少 cache/_成分股汇总表.json，请先运行 update.py 选项4")
        return []
    table = json.load(open(t_path, encoding="utf-8"))
    rec = {c for c, _, _ in fsd.STOCKS}
    out = [(r["code"], r.get("name", r["code"]), market_prefix(r["code"]))
           for r in table if r["code"] not in rec]
    return out


def load_failed():
    try:
        return json.load(open(FAIL_PATH, encoding="utf-8"))
    except OSError:
        return {}


def save_failed(f):
    atomic_dump(FAIL_PATH, f)


def fetch_one(code, name, tcode):
    """单只：K线增量 + 分红/财报/股本缺失补齐。抛异常表示 K 线失败（入失败清单）"""
    fh.update_incremental("股票", code, name, fsd.make_fetcher(tcode, code))
    fsd.update_dividends(codes=[code])
    fsd.update_financials(codes=[code])
    fsd.update_share_hist(codes=[code])


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

    new_failed = {k: v for k, v in failed.items()}
    consec = 0
    ok = 0
    t0 = time.time()
    for i, (code, name, tcode) in enumerate(todo, 1):
        try:
            fetch_one(code, name, tcode)
            new_failed.pop(code, None)
            consec = 0
            ok += 1
            if i % 10 == 0 or i == len(todo):
                print(f"  进度 {i}/{len(todo)}（成功 {ok}） 已用 {time.time() - t0:.0f}s")
        except Exception as e:
            consec += 1
            new_failed[code] = {"name": name, "err": f"{type(e).__name__}: {str(e)[:70]}"}
            print(f"  ❌ [{i}/{len(todo)}] {code} {name} 拉取失败: {repr(e)[:80]}")
            if consec >= MELT_LIMIT:
                print(f"  ⏸ 连续 {MELT_LIMIT} 次失败，熔断暂停 {MELT_PAUSE}s 防封…")
                time.sleep(MELT_PAUSE)
                consec = 0
        time.sleep(SLEEP_KLINE)
    save_failed(new_failed)
    fail_n = len(todo) - ok
    print(f"✅ 完成：成功 {ok} / 失败 {fail_n}（失败明细 → cache/_pool_failed.json）")
    if fail_n:
        print("   下次运行 --retry-failed 只补失败项")
    print("⚠️  随后请运行 update.py 选项7（前端数据包 + 区间分析），或 python scripts/_gen_web_data.py && python scripts/_gen_analysis.py")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=0, help="首次分批：只处理尚无K线缓存的前 N 只")
    ap.add_argument("--retry-failed", action="store_true", help="只重试失败清单")
    ap.add_argument("--check-fin", action="store_true", help="季度分红/财报/股本检测")
    args = ap.parse_args()
    main(batch=args.batch, retry_failed=args.retry_failed, check_fin=args.check_fin)
