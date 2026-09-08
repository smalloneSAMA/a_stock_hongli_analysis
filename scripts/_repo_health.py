# -*- coding: utf-8 -*-
"""仓库健康与体积监控（N2）

只读，不修改仓库。用法: python scripts/_repo_health.py [--json]
退出码：0 = 健康；1 = 发现垃圾对象（可用于 CI 告警）。

检查项：
  · .git 体积与 pack 数、垃圾对象（orphan idx / tmp_pack 等，git count-objects -v 的 garbage）
  · 工作区数据体积（cache / web/data / excel）
  · 跟踪文件数（git ls-files）
"""
import contextlib
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def du(path):
    """目录字节数（不存在返回 0）"""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            with contextlib.suppress(OSError):
                total += os.path.getsize(os.path.join(root, f))
    return total


def git(*args):
    r = subprocess.run(["git", *args], cwd=BASE, capture_output=True, text=True, errors="replace")
    return r.stdout.strip()


def mb(n):
    return f"{n / 1048576:.1f} MB"


def main():
    as_json = "--json" in sys.argv
    stat = {}
    # count-objects -v：包含 garbage / size-pack 等（-H 是人类可读，这里要数字）
    for line in git("count-objects", "-v").splitlines():
        k, _, v = line.partition(":")
        stat[k.strip()] = v.strip()
    packs = sorted(p for p in os.listdir(os.path.join(BASE, ".git", "objects", "pack")) if p.endswith(".pack")) \
        if os.path.isdir(os.path.join(BASE, ".git", "objects", "pack")) else []
    garbage = int(stat.get("garbage", 0) or 0)
    out = {
        "git_dir_mb": round(du(os.path.join(BASE, ".git")) / 1048576, 1),
        "pack_count": len(packs),
        "size_pack_mb": round(int(stat.get("size-pack", 0) or 0) / 1024, 1),
        "loose_count": int(stat.get("count", 0) or 0),
        "garbage": garbage,
        "cache_mb": round(du(os.path.join(BASE, "cache")) / 1048576, 1),
        "web_data_mb": round(du(os.path.join(BASE, "web", "data")) / 1048576, 1),
        "excel_mb": round(du(os.path.join(BASE, "excel")) / 1048576, 1),
        "tracked_files": len([x for x in git("ls-files").splitlines() if x]),
    }
    if as_json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print("═══ 仓库健康与体积（N2）═══")
        print(f"  .git            {out['git_dir_mb']:>7.1f} MB（pack {out['pack_count']} 个 / "
              f"size-pack {out['size_pack_mb']:.1f} MB / 松散对象 {out['loose_count']}）")
        print(f"  工作区数据       {out['cache_mb'] + out['web_data_mb'] + out['excel_mb']:>7.1f} MB"
              f"（cache {out['cache_mb']} / web/data {out['web_data_mb']} / excel {out['excel_mb']}）")
        print(f"  跟踪文件         {out['tracked_files']:>7d} 个")
        if garbage:
            print(f"  ❌ 垃圾对象       {garbage:>7d} 个 → 建议 git gc --prune=now（或删孤儿 idx/tmp_pack）")
        else:
            print("  ✅ 垃圾对象       0（git fsck/count-objects 无告警）")
    return 1 if garbage else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
