# -*- coding: utf-8 -*-
"""
指数成分股更新：重新下载中证官网样本文件 → 解析 → 重新生成《红利指数与ETF成分股.md》
- 9只中证指数：oss-ch 官方 cons/closeweight Excel（下载失败则用旧md数据回退并标注）
- 980092：国证官网样本详情接口缓存（cache/成分_980092.json，_fetch_cnindex_components.py 生成）
- 000151：东财成分表 + 腾讯名称
用法: python _gen_components.py [--force]
"""
import sys, io, os, json, re, time, glob, datetime, requests, pandas as pd, urllib.request

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根（scripts/的父目录）
TMP = os.path.join(BASE, "_cons_tmp")
os.makedirs(TMP, exist_ok=True)
MD = os.path.join(BASE, "红利指数与ETF成分股.md")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
S = requests.Session()
S.headers.update({"User-Agent": UA, "Referer": "https://www.csindex.com.cn/"})

# 9只中证指数 + 932368 + 000151
CSINDICES = ["000922", "000015", "000821", "000825", "H30269", "930955", "932315", "931468", "H30270"]

INDEX_META = {
    "000922": ("中证红利", "从沪深A股中选取三年连续分红、平均股息率最高的100只股票"),
    "000015": ("上证红利", "从上证180成分股中选取50只股息率最高的股票"),
    "000821": ("沪深300红利", "从沪深300成分股中选取50只股息率最高的股票"),
    "000825": ("中证央企红利", "从中央企业中选取股息率高、分红较稳定的50只证券"),
    "H30269": ("中证红利低波动", "红利+低波动双因子，银行权重约50%，每年12月调仓"),
    "930955": ("红利低波动100", "红利+低波动双因子，行业均衡（银行约20%），季度调仓"),
    "932315": ("中证全指红利质量", "连续分红、股息率较高且盈利持续性较好的50只证券"),
    "931468": ("中证红利质量", "红利质量另一编制口径"),
    "H30270": ("中证红利价值", "高股息基础上挑选低PE/低PB股票，深度价值"),
    "000151": ("上证国有企业红利", "从沪市国有企业中选取股息率较高的50只证券（官网样本文件未公开，东财成分表口径30只）"),
    "980092": ("国证自由现金流", "剔除成交额后20%、金融/房地产行业及近12季度ROE稳定性后10%的证券，选取近一年自由现金流率最高的100只；季度调样、单只权重上限10%（国证官网口径，权重仅前十大公开）"),
}
ETF_META = [
    ("512890", "红利低波ETF华泰柏瑞", "H30269", "核心", "348亿"),
    ("515180", "红利ETF易方达", "000922", "核心", "193亿"),
    ("563020", "红利低波ETF易方达", "H30269", "核心", "134亿"),
    ("515080", "中证红利ETF招商", "000922", "核心", "122亿"),
    ("159549", "红利低波ETF天弘", "930955", "互补", "63亿"),
    ("561580", "央企红利ETF华泰柏瑞", "000825", "互补", "28亿"),
    ("510720", "红利国企ETF国泰", "000151", "互补", "24亿"),
    ("159209", "红利质量ETF招商", "932315", "互补", "24亿"),
    ("159758", "华夏中证红利质量ETF", "931468", "观察", "16亿"),
    ("563700", "红利价值ETF易方达", "H30270", "观察", "4.3亿"),
    ("159201", "自由现金流ETF华夏", "980092", "核心", "173亿"),
]
TRACK_NAME = {"H30269": "中证红利低波动", "000922": "中证红利", "930955": "红利低波动100",
              "000825": "中证央企红利", "000151": "上证国有企业红利", "932315": "中证全指红利质量",
              "931468": "中证红利质量", "H30270": "中证红利价值", "980092": "国证自由现金流"}

# ── 1. 下载中证官网样本文件 ───────────────────────────────────────
def download_xls(code, kind):
    url = f"https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/{kind}/{code}{kind}.xls"
    for attempt in range(3):
        try:
            r = S.get(url, timeout=25)
            if r.content[:2] == b"\xd0\xcf" or r.content[:4] == b"PK":
                fp = os.path.join(TMP, f"{code}_{kind}.xls")
                open(fp, "wb").write(r.content)
                return fp
        except Exception:
            pass
        time.sleep(2 + attempt * 2)
    return None

# ── 2. 解析 ───────────────────────────────────────────────────────
def parse_xls(code):
    cons_fp = os.path.join(TMP, f"{code}_cons.xls")
    w_fp = os.path.join(TMP, f"{code}_closeweight.xls")
    stocks = {}
    d_cons = d_w = ""
    if os.path.exists(cons_fp):
        c = pd.read_excel(cons_fp, header=0).iloc[:, [0, 4, 5, 7]]
        c.columns = ["date", "code", "name", "exchange"]
        c["code"] = c["code"].astype(str).str.zfill(6)
        d_cons = str(c["date"].iloc[0])
        stocks = {r.code: {"name": r.name, "exchange": r.exchange, "weight": None} for r in c.itertuples()}
    if os.path.exists(w_fp):
        try:
            w = pd.read_excel(w_fp, header=0).iloc[:, [0, 4, 5, 9]]
            w.columns = ["date", "code", "name", "weight"]
            w["code"] = w["code"].astype(str).str.zfill(6)
            d_w = str(w["date"].iloc[0])
            for r in w.itertuples():
                if r.code in stocks:
                    stocks[r.code]["weight"] = r.weight
        except Exception:
            pass
    return d_cons, d_w, stocks

# ── 3. 东财成分表（932368/000151）────────────────────────────────
def fetch_em_members(index_code):
    u = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    p = {"reportName": "RPT_INDEX_COMPONENT", "columns": "ALL", "pageNumber": "1", "pageSize": "500",
         "filter": f'(INDEX_CODE="{index_code}")', "source": "WEB", "client": "WEB"}
    for attempt in range(3):
        try:
            d = S.get(u, params=p, timeout=15).json()
            if d.get("result") and d["result"].get("data"):
                return [x["SECURITY_CODE"] for x in d["result"]["data"]]
        except Exception:
            pass
        time.sleep(2)
    return []

# ── 4. 中证官网十大权重（932368）─────────────────────────────────
def fetch_top10(code):
    try:
        d = S.get(f"https://www.csindex.com.cn/csindex-home/index/weight/top10new/{code}", timeout=15).json()
        return {w["securityCode"]: w["weight"] for w in d.get("data", {}).get("weightList", [])}
    except Exception:
        return {}

# ── 5. 腾讯名称 ───────────────────────────────────────────────────
def tencent_names(codes):
    out = {}
    for i in range(0, len(codes), 60):
        batch = codes[i:i+60]
        prefixed = []
        for c in batch:
            if c.startswith(("5", "6", "9")):
                prefixed.append(f"sh{c}")
            elif c.startswith("92"):
                prefixed.append(f"bj{c}")
            else:
                prefixed.append(f"sz{c}")
        url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            resp = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")
            for line in resp.strip().split(";"):
                if "=" not in line or '"' not in line:
                    continue
                key = line.split("=")[0].split("_")[-1]
                vals = line.split('"')[1].split("~")
                if len(vals) >= 2:
                    out[key[2:]] = vals[1]
        except Exception:
            pass
    return out

# ── 6. 从旧md解析成分（下载失败时回退）────────────────────────────
def parse_old_md_stocks(code):
    if not os.path.exists(MD):
        print(f"  ⚠️ {code}: 官网下载失败且旧md不存在（{MD}），无法回退，跳过该指数")
        return None, ""
    t = open(MD, encoding="utf-8").read()
    m = re.search(rf"^### .+?（{re.escape(code)}）$(.*?)(?=^### |\Z)", t, re.M | re.S)
    if not m:
        return None, ""
    seg = m.group(1)
    stocks = {}
    for l in seg.split("\n"):
        mm = re.match(r"^\| \d+ \| (\d{6}) \| (.+?) \| (.+?) \|$", l)
        if mm:
            w = mm.group(3)
            stocks[mm.group(1)] = {"name": mm.group(2), "weight": (float(w) if w not in ("—", "") else None)}
    # 取旧章节的样本日期（兼容 20260731 与 2026-07-31）
    dm = re.search(r"样本截止 (\d{4}-\d{2}-\d{2}|\d{8})", seg)
    return stocks, (dm.group(1) if dm else "旧数据")

# ── 主流程 ───────────────────────────────────────────────────────
def build():
    print("═══ 步骤1/3：下载中证官网样本文件 ═══")
    idx = {}
    fail_all = True
    for code in CSINDICES:
        c_ok = download_xls(code, "cons") is not None
        w_ok = download_xls(code, "closeweight") is not None
        if c_ok and w_ok:
            fail_all = False
            d_cons, d_w, stocks = parse_xls(code)
            idx[code] = {"name": INDEX_META[code][0], "desc": INDEX_META[code][1],
                         "date_cons": d_cons, "date_weight": d_w, "stocks": stocks,
                         "fallback": False}
            print(f"  {code} {idx[code]['name']}: 下载成功 {len(stocks)}只 (cons {d_cons}, 权重 {d_w})")
        else:
            stocks, d_cons = parse_old_md_stocks(code)
            idx[code] = {"name": INDEX_META[code][0], "desc": INDEX_META[code][1],
                         "date_cons": d_cons, "date_weight": "旧数据", "stocks": stocks,
                         "fallback": True}
            print(f"  ⚠️ {code}: 官网文件下载失败，使用旧md数据回退（{len(stocks or {})}只，样本截止 {d_cons}）")
        time.sleep(1)
    if fail_all:
        print("⚠️  中证官网样本文件全部下载失败（oss风控），本次不重写md，请稍后重试或检查网络。")
        return idx

    print("═══ 步骤2/3：980092（国证缓存）/ 000151（东财）═══")
    # 980092：国证官网样本详情接口缓存（_fetch_cnindex_components.py 生成）
    cc_path = os.path.join(BASE, "cache", "成分_980092.json")
    if os.path.exists(cc_path):
        cc = json.load(open(cc_path, encoding="utf-8"))
        stocks = {x["code"]: {"name": x["name"], "weight": x.get("weight")} for x in cc.get("stocks", [])}
        idx["980092"] = {"name": INDEX_META["980092"][0], "desc": INDEX_META["980092"][1],
                         "date_cons": cc.get("sample_date", ""), "date_weight": "前十大公开",
                         "stocks": stocks, "fallback": False}
        print(f"  980092 国证自由现金流: {len(stocks)}只 (国证官网，样本 {cc.get('sample_date', '')})")
    else:
        print("  ⚠️ 980092: 缺少 cache/成分_980092.json，请先运行 _fetch_cnindex_components.py")
    # 000151：东财成分表
    for code in ["000151"]:
        members = fetch_em_members(code)
        names = tencent_names(members) if members else {}
        stocks = {}
        for c in members:
            stocks[c] = {"name": names.get(c, ""), "weight": None}
        idx[code] = {"name": INDEX_META[code][0], "desc": INDEX_META[code][1],
                     "date_cons": "2026-07-31", "date_weight": "未公开",
                     "stocks": stocks, "fallback": False}
        print(f"  {code} {idx[code]['name']}: {len(stocks)}只 (东财成分表)")
        time.sleep(1.5)

    print("═══ 步骤3/3：生成 md ═══")
    out = []
    out.append("# 红利指数与ETF成分股一览")
    out.append("")
    out.append(f"> **数据日期：{datetime.date.today().strftime('%Y-%m-%d')}** · 对应《红利介绍.md》精选池（指数10只 + ETF 11只）")
    out.append(">")
    out.append("> **数据来源**：")
    out.append("> - 指数成分股：中证指数官网（csindex.com.cn）官方样本/权重文件（成分截止 2026-07-31，权重按 2026-06-30 收盘计算）；国证自由现金流 980092 为国证指数官网样本详情接口（仅前十大权重公开）；上证国有企业红利 000151 为东方财富指数成分表")
    out.append("> - ETF持仓：ETF实际持仓与跟踪指数成分股一致（合同约定），直接采用跟踪指数成分股列示")
    out.append("> - 注：上证国有企业红利(000151) 官网样本文件未公开，采用东方财富指数成分表（30只，可能不完整，官方为50只）")
    out.append(">")
    out.append("> ETF为指数化投资，实际股票持仓与跟踪指数成分股一致（存在极小跟踪误差）；下方每个ETF均单独列出其跟踪指数的完整成分股（即实际持仓构成）。")
    out.append("")

    out.append("---")
    out.append("")
    out.append("## 一、精选指数成分股（10只 + 1只辅助）")
    out.append("")
    for code in ["000922", "000015", "000821", "000825", "H30269", "930955", "932315", "931468", "H30270", "980092", "000151"]:
        info = idx[code]
        stocks = info["stocks"] or {}
        note = f"> {info['desc']} · **样本数：{len(stocks)} 只** · 样本截止 {info['date_cons']}"
        if info["date_weight"] not in ("", "旧数据", "未公开"):
            note += f"，权重截至 {info['date_weight']}"
        elif info["date_weight"] == "旧数据":
            note += "（权重为旧数据）"
        elif info["date_weight"] == "未公开":
            note += "（权重未公开）"
        if info["fallback"]:
            note += " · ⚠️ 本次官网文件下载失败，为上次数据"
        src = "中证指数官网官方样本文件" if code in CSINDICES else (
            "国证指数官网样本详情接口（sample-detail/detail，权重仅前十大公开）" if code == "980092" else "东方财富数据中心指数成分表（官网样本文件未公开）")
        out.append(f"### {info['name']}（{code}）")
        out.append("")
        out.append(note)
        out.append(f"> **数据来源**：{src}")
        out.append("")
        out.append("| 序号 | 证券代码 | 证券名称 | 权重(%) |")
        out.append("| :--: | :--: | :--: | :--: |")
        items = sorted(stocks.items(), key=lambda x: (-(x[1]["weight"] or 0), x[0]))
        for i, (c, v) in enumerate(items, 1):
            w = v["weight"]
            ws = "—" if w is None else f"{w:.2f}"
            out.append(f"| {i} | {c} | {v['name']} | {ws} |")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## 二、精选ETF成分股（11只）")
    out.append("")
    out.append("> ETF为指数化投资，实际股票持仓与跟踪指数成分股一致（指数基金合同约定跟踪标的指数，实际组合与指数样本一致，仅存在极小跟踪误差），故直接列出其跟踪指数的全部成分股作为其持仓构成。")
    out.append("")
    for code, name, track, pool, scale in ETF_META:
        info = idx[track]
        stocks = info["stocks"] or {}
        tname = TRACK_NAME[track]
        wnote = ""
        if track == "980092":
            wnote = "；权重为国证官网披露的前十大权重，其余未公开"
        out.append(f"### {name}（{code}）")
        out.append("")
        out.append(f"> 池：{pool} · 规模约{scale} · 跟踪指数：**{tname}（{track}）**")
        out.append(f"> **数据来源**：持仓构成 = 跟踪指数 {tname}（{track}）成分股（基金合同约定实际持仓与指数一致），来源同指数章节；跟踪标的经天天基金基金档案（fundf10 jbgk_{code}.html『跟踪标的』字段）核实")
        out.append("")
        out.append(f"**完整成分股**（跟踪 {tname} 全部{len(stocks)}只样本，即本ETF实际持仓构成{wnote}）")
        out.append("")
        out.append("| 序号 | 证券代码 | 证券名称 | 权重(%) |")
        out.append("| :--: | :--: | :--: | :--: |")
        items = sorted(stocks.items(), key=lambda x: (-(x[1]["weight"] or 0), x[0]))
        for i, (c, v) in enumerate(items, 1):
            w = v["weight"]
            ws = "—" if w is None else f"{w:.2f}"
            out.append(f"| {i} | {c} | {v['name']} | {ws} |")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## 附：数据来源明细")
    out.append("")
    out.append("### 1. 指数成分股来源")
    out.append("")
    out.append("| 指数 | 代码 | 成分数据来源 | 权重数据来源 | 数据日期 |")
    out.append("| :-- | :-- | :-- | :-- | :-- |")
    src_rows = [
        ("中证红利", "000922"), ("上证红利", "000015"), ("沪深300红利", "000821"),
        ("中证央企红利", "000825"), ("中证红利低波动", "H30269"), ("红利低波动100", "930955"),
        ("中证全指红利质量", "932315"), ("中证红利质量", "931468"), ("中证红利价值", "H30270"),
    ]
    for i, (nm, code) in enumerate(src_rows):
        dc = idx[code]["date_cons"]
        dw = idx[code]["date_weight"]
        date_str = f"成分 {dc} / 权重 {dw}" if i == 0 else "同上"
        out.append(f"| {nm} | {code} | 中证指数官网样本文件 `{code}cons.xls` | 中证官网权重文件 `{code}closeweight.xls` | {date_str} |")
    out.append("| 国证自由现金流 | 980092 | 国证指数官网样本详情接口（`sample-detail/detail`） | 官网仅披露前十大权重 | " + (idx.get("980092", {}).get("date_cons") or "") + " |")
    out.append("| 上证国有企业红利 | 000151 | 东方财富数据中心指数成分表（`RPT_INDEX_COMPONENT`，官网样本文件未公开，仅30只） | 未公开 | 2026-07-31 |")
    out.append("")
    out.append("**中证指数官网文件抓取路径**：指数详情页数据接口 `csindex-home/indexInfo/index-details-data?fileLang=2&indexCode={code}` 返回样本文件下载链接 → `https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/{code}cons.xls`（成分）与 `.../closeweight/{code}closeweight.xls`（权重）。")
    out.append("")
    out.append("### 2. ETF持仓构成来源")
    out.append("")
    out.append("| ETF | 代码 | 跟踪指数 | 持仓构成来源 |")
    out.append("| :-- | :-- | :-- | :-- |")
    for code, name, track, pool, scale in ETF_META:
        out.append(f"| {name} | {code} | {TRACK_NAME[track]}（{track}） | 跟踪指数成分股（同指数章节来源），跟踪标的经天天基金档案核实 |")
    out.append("")
    out.append("**说明**：ETF为指数基金，基金合同/招募说明书约定跟踪标的指数，实际股票持仓与指数成分股一致（仅存在极小跟踪误差），故以跟踪指数成分股作为ETF持仓构成列示；跟踪标的字段来自天天基金网基金档案（`fundf10.eastmoney.com/jbgk_{code}.html`）。")
    out.append("")

    out.append("---")
    out.append("")
    out.append("## 附：数据说明与风险提示")
    out.append("")
    out.append("1. **指数成分**：9只中证指数来自中证指数官网官方样本文件（cons/closeweight），样本为最新定期调整后生效样本；权重按官网惯例滞后一个月发布。")
    out.append("2. **国证自由现金流(980092)**：官网仅披露前十大权重，其余未公开；成分来自国证指数官网样本详情接口。")
    out.append("3. **ETF持仓说明**：ETF为指数基金，实际持仓与跟踪指数成分股一致（存在极小跟踪误差），故直接以跟踪指数全部成分股作为其持仓构成列示。")
    out.append("4. **上证国有企业红利(000151)**：官网样本文件未公开，此处为东方财富指数成分表（官方为50只，可能不完整）。")
    out.append("5. **权重说明**：指数权重随季度调整与市场涨跌变动，本表为静态快照。")
    out.append("6. **风险警示**：基金有风险，投资须谨慎。以上内容仅为基于公开数据的客观信息梳理，**不构成任何投资建议**。")
    out.append("")

    # 附录：非精选池国证指数成分（cache/成分_*.json，国证官网 sample-detail 接口）
    comp_files = sorted(glob.glob(os.path.join(BASE, "cache", "成分_*.json")))
    comp_files = [fp for fp in comp_files if os.path.basename(fp)[len("成分_"):-5] not in idx]   # 已收录的（980092）不进附录
    if comp_files:
        out.append("---")
        out.append("")
        out.append("## 附：非精选池指数成分（国证系列）")
        out.append("")
        out.append("> 数据来源：国证指数官网样本详情接口（sample-detail/detail）· 官网仅披露前十大权重，其余未公开 · 行业为国证行业分类（与申万口径不同）")
        out.append("")
        for fp in comp_files:
            try:
                cc = json.load(open(fp, encoding="utf-8"))
            except Exception:
                continue
            stocks = cc.get("stocks", [])
            w10 = sum((s.get("weight") or 0) for s in cc.get("top10", []))
            out.append(f"### {cc.get('name', '')}（{cc.get('code', '')}）")
            out.append("")
            out.append(f"> 样本日期 {cc.get('sample_date', '')} · 样本数 {cc.get('total', len(stocks))} 只 · 权重仅前十大公开（合计 {w10:.2f}%）")
            out.append("")
            out.append("| 序号 | 证券代码 | 证券名称 | 国证行业 | 权重(%) |")
            out.append("| :--: | :--: | :--: | :--: | :--: |")
            for i, s in enumerate(stocks, 1):
                w = "—" if s.get("weight") is None else f"{s['weight']:.2f}"
                out.append(f"| {i} | {s.get('code', '')} | {s.get('name', '')} | {s.get('ind', '')} | {w} |")
            out.append("")

    with open(MD, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"✅ 已重新生成 {MD}")
    return idx

if __name__ == "__main__":
    build()
