# -*- coding: utf-8 -*-
"""
红利数据更新工具（交互式）
菜单：
  1. 指数历史行情   —— 增量更新（有缓存则从最后日期增量拉取；无缓存全量）[运行前提醒]
  2. ETF历史行情    —— 增量更新（场内K线+净值）[运行前提醒]
  3. 指数成分股     —— 重下载中证官网样本文件 + 重新生成《红利指数与ETF成分股.md》[运行前提醒]
  4. 成分股汇总表   —— 解析成分股md → 行业/行情/股息率 → 缓存 → excel/红利成分股汇总.xlsx
  5. 股票历史行情   —— 推荐20只股票日线（不复权，2004-01-01起）[首次全量较慢]
  6. 全部更新
  0. 退出
用法: python update.py
"""
import sys, io, os, time

BASE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(BASE, "scripts")
sys.path.insert(0, SCRIPTS)

import _fetch_history as fh
import _fetch_stock_data as fsd

# import后包装stdout（fh的包装对象仍被其模块引用，底层buffer不会被关闭）
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

INDICES = fh.INDICES
ETFS = fh.ETFS

def ask(msg, default=True):
    tip = "(y/n) " if default else "(y/N) "
    while True:
        r = input(f"⚠️  {msg}{tip}").strip().lower()
        if r in ("",):
            return default
        if r in ("y", "yes"):
            return True
        if r in ("n", "no"):
            return False
        print("  请输入 y 或 n")

def update_indices(incremental=True):
    print("\n═══ 指数历史行情更新 ═══")
    for code, name, src, tcode in INDICES:
        def fetcher(last_date, src=src, code=code, tcode=tcode):
            if src == "tencent":
                return fh.fetch_tencent_kline(tcode, code, start=last_date)
            if src == "csindex":
                start = last_date.replace("-", "") if last_date else None
                return fh.fetch_csindex_perf(code, start=start)
            return fh.fetch_cnindex_kline(code, start=last_date)
        try:
            fh.update_incremental("指数", code, name, fetcher)
        except Exception as e:
            print(f"  ❌ [{code} {name}] 失败: {repr(e)[:80]}")
    print("\n✅ 指数历史更新完成")

def update_etfs():
    print("\n═══ ETF历史行情更新（场内K线+净值）═══")
    for code, name, tcode in ETFS:
        def fetcher(last_date, code=code, tcode=tcode):
            kline = fh.fetch_tencent_kline(tcode, code, start=last_date)
            nav = fh.fetch_sina_nav(code, start=last_date)
            kmap = {r["date"]: r for r in kline}
            nmap = {r["date"]: r for r in nav}
            rows = []
            for d in sorted(set(kmap) | set(nmap)):
                r = {"date": d}
                if d in kmap:
                    r.update({k: v for k, v in kmap[d].items() if k != "date"})
                if d in nmap:
                    r["nav"] = nmap[d]["nav"]
                    r["acc_nav"] = nmap[d]["acc_nav"]
                rows.append(r)
            return rows
        try:
            fh.update_incremental("ETF", code, name, fetcher)
        except Exception as e:
            print(f"  ❌ [{code} {name}] 失败: {repr(e)[:80]}")
    print("\n✅ ETF历史更新完成")

def update_stocks():
    print("\n═══ 股票历史行情更新（20只，不复权，2004-01-01起）═══")
    fsd.update_dividends()   # 分红缓存缺失才拉（20只约1分钟），删除自愈
    fsd.update_financials()  # 财报缓存缺失才拉，删除自愈
    for code, name, tcode in fsd.STOCKS:
        try:
            fh.update_incremental("股票", code, name, fsd.make_fetcher(tcode, code))
        except Exception as e:
            print(f"  ❌ [{code} {name}] 失败: {repr(e)[:80]}")
    fsd.export_excel()
    print("\n✅ 股票历史更新完成")

def export_excel():
    import pandas as pd
    from datetime import datetime
    from openpyxl import load_workbook
    from _fetch_history import load_cache

    def fmt_dates_file(path):
        """日期列显示为年月日（保留日期类型，去掉时分秒显示）——导出后独立后处理"""
        wb = load_workbook(path)
        for ws in wb.worksheets:
            for row in ws.iter_rows(min_row=2, min_col=1, max_col=1):
                for cell in row:
                    if isinstance(cell.value, datetime):
                        cell.number_format = "yyyy-mm-dd"
        wb.save(path)
    # 展示口径：价格(点/元)、成交量(万手)、成交额(亿元)；单位净值/累计净值不加单位
    # 原始单位：腾讯 volume=手/amount=元(估算)；中证官网 tradingVol=股/tradingValue=亿元；国证 volume=万手/amount=亿元
    IDX_COL_CN = {
        "open": "开盘(点)", "close": "收盘(点)", "high": "最高(点)", "low": "最低(点)",
        "volume": "成交量(万手)", "amount": "成交额(亿元)",
    }
    IDX_DIV = {"tencent": (1e4, 1e8), "csindex": (1e6, 1), "cnindex": (1, 1)}  # (成交量除数, 成交额除数)
    ETF_COL_CN = {
        "open": "开盘(元)", "close": "收盘(元)", "high": "最高(元)", "low": "最低(元)",
        "volume": "成交量(万手)", "amount": "成交额(亿元)",
        "nav": "单位净值", "acc_nav": "累计净值",
    }
    print("\n═══ 重新生成 Excel ═══")
    # 指数
    idx_rows = {}
    for code, name, src, tcode in INDICES:
        c = load_cache("指数", code)
        if c:
            idx_rows[code] = {"name": c.get("name", name), "source": src, "rows": c["rows"]}
    try:
        with pd.ExcelWriter(os.path.join(BASE, "excel", "指数历史.xlsx"), engine="openpyxl") as w:
            for code, info in idx_rows.items():
                rows = info["rows"]
                if not rows:
                    continue
                vdiv, adiv = IDX_DIV[info["source"]]
                df = pd.DataFrame(rows)
                df["date"] = pd.to_datetime(df["date"])
                df = df.sort_values("date").set_index("date")
                df = df.rename(columns=IDX_COL_CN)
                df = df[list(IDX_COL_CN.values())]
                df["成交量(万手)"] = (df["成交量(万手)"] / vdiv).round(2)
                df["成交额(亿元)"] = (df["成交额(亿元)"] / adiv).round(2)
                df.index.name = "日期"
                df.to_excel(w, sheet_name=f"{code} {info['name'][:10]}"[:31])
        fmt_dates_file(os.path.join(BASE, "excel", "指数历史.xlsx"))
    except PermissionError:
        print("⚠️  excel/指数历史.xlsx 被占用（可能已在Excel中打开），请关闭后重新执行导出")
    # ETF（先估算成交额并写回缓存）
    etf_rows = {}
    for code, name, tcode in ETFS:
        c = load_cache("ETF", code)
        if c:
            fh.fill_etf_amount(c["rows"])
            fh.save_cache("ETF", code, c)
            etf_rows[code] = {"name": c.get("name", name), "rows": c["rows"]}
    try:
        with pd.ExcelWriter(os.path.join(BASE, "excel", "ETF历史.xlsx"), engine="openpyxl") as w:
            for code, info in etf_rows.items():
                rows = info["rows"]
                if not rows:
                    continue
                df = pd.DataFrame(rows)
                df["date"] = pd.to_datetime(df["date"])
                df = df.sort_values("date").set_index("date")
                df = df.rename(columns=ETF_COL_CN)
                df["成交量(万手)"] = (df["成交量(万手)"] / 1e4).round(2)
                df["成交额(亿元)"] = (df["成交额(亿元)"] / 1e8).round(2)
                if "单位净值" in df.columns:
                    df = df[["开盘(元)", "收盘(元)", "最高(元)", "最低(元)", "成交量(万手)", "成交额(亿元)", "单位净值", "累计净值"]]
                df.index.name = "日期"
                df.to_excel(w, sheet_name=f"{code} {info['name'][:10]}"[:31])
        fmt_dates_file(os.path.join(BASE, "excel", "ETF历史.xlsx"))
    except PermissionError:
        print("⚠️  excel/ETF历史.xlsx 被占用（可能已在Excel中打开），请关闭后重新执行导出")
    else:
        print("✅ excel/ETF历史.xlsx 已更新")

def update_components():
    print("\n═══ 指数成分股更新 ═══")
    import _gen_components  # scripts/ 已在 sys.path
    idx = _gen_components.build()
    # 摘要
    print("\n更新摘要：")
    for code in ["000922", "000015", "000821", "000825", "H30269", "930955", "932315", "931468", "H30270", "932368", "000151"]:
        info = idx.get(code, {})
        stocks = info.get("stocks") or {}
        fb = " ⚠️旧数据回退" if info.get("fallback") else ""
        print(f"  {code} {info.get('name','')}: {len(stocks)}只, 样本截止 {info.get('date_cons','')}{fb}")
    print("\n⚠️ 请手动核对《红利介绍.md》中相关描述/快照数字是否需要同步（脚本不自动改该文件）。")

def update_summary(force=False):
    print("\n═══ 成分股汇总表更新（解析md→行业/行情/股息率→汇总Excel）═══")
    import _update_summary
    _update_summary.run(force=force)

def main():
    print("═" * 50)
    print("  红利数据更新工具")
    print("═" * 50)
    while True:
        print("""
请选择要更新的部分：
  1. 指数历史行情（增量，11只）
  2. ETF历史行情（增量，11只）
  3. 指数成分股（重新生成《红利指数与ETF成分股.md》）
  4. 成分股汇总表（解析md→行业/行情/股息率→缓存→汇总Excel）
  5. 股票历史行情（20只推荐股，不复权，2004-01-01起）
  6. 全部更新
  0. 退出
""")
        ch = input("请输入编号: ").strip()
        if ch == "0":
            print("已退出")
            break
        if ch == "1":
            if ask("指数历史将增量拉取11只指数（含中证官网5只，可能较慢），是否继续？"):
                update_indices()
                export_excel()
        elif ch == "2":
            update_etfs()
            export_excel()
        elif ch == "3":
            if ask("将重新下载中证官网样本文件并重写《红利指数与ETF成分股.md》，是否继续？"):
                update_components()
        elif ch == "4":
            msg = "将解析最新成分股md并增量补齐行业/行情/股息率（仅新增股票慢，其余秒级），是否继续？"
            if ask(msg):
                update_summary()
        elif ch == "5":
            msg = "将增量更新20只推荐股历史行情（首次全量约2-3分钟），是否继续？"
            if ask(msg):
                update_stocks()
        elif ch == "6":
            print("\n—— 指数历史 ——")
            if ask("指数历史将增量拉取11只指数（含中证官网5只，可能较慢），是否更新？"):
                update_indices()
            print("\n—— ETF历史 ——")
            if ask("ETF历史（K线+净值）是否更新？"):
                update_etfs()
            export_excel()
            print("\n—— 成分股 ——")
            if ask("将重下载样本文件并重写《红利指数与ETF成分股.md》，是否更新？"):
                update_components()
            print("\n—— 成分股汇总表 ——")
            if ask("解析最新成分股md并增量补齐行业/行情/股息率，是否更新？"):
                update_summary()
            print("\n—— 股票历史 ——")
            if ask("20只推荐股历史行情（2004年起，首次全量约2-3分钟）是否更新？"):
                update_stocks()
        else:
            print("无效输入")

if __name__ == "__main__":
    main()
