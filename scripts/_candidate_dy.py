# -*- coding: utf-8 -*-
"""候选池股息率计算：对候选股票拉取分红历史，计算近12个月每股派息/现价"""
import json, sys, time, random, urllib.request, os
from _common import em_get   # 东财限流请求（1s/请求防封，全局限流）

sys.stdout.reconfigure(encoding="utf-8")

CANDIDATES = [
    # 银行
    "600036", "600919", "601838", "601398", "601328",
    # 煤炭
    "601088", "601225", "601898", "600188",
    # 石油石化
    "601857", "600938", "600028",
    # 交通运输
    "601006", "600350", "600012", "001965", "600377", "601000",
    # 公用事业
    "600900", "600863", "600795", "600236",
    # 食品饮料
    "600519", "000858", "000895", "600887", "603288", "600132",
    # 医药生物
    "000538", "000423", "000999", "600332", "600566", "600750",
    # 家用电器
    "000651", "000333", "002032", "600690",
    # 有色金属
    "601168", "601600", "000408", "000975",
    # 钢铁
    "600019", "000708",
    # 建筑
    "601668", "600039", "601186",
    # 机械设备
    "600582", "000157", "000425", "600031", "601369",
    # 传媒
    "601928", "601098", "600373", "600757",
    # 基础化工
    "600096", "600989", "600309", "002001", "600873",
    # 汽车
    "601633", "600741", "000625",
    # 纺织服饰
    "600398", "600177",
    # 非银金融
    "601318", "600901",
    # 通信
    "600941", "601728", "600050",
    # 计算机/电子
    "002415", "600183",
    # 其他质量成长
    "300033", "002555", "605117",
]

def main():
    for p in ("cache/_成分股汇总.json", "cache/_成分股汇总表.json"):
        if not os.path.exists(p):
            sys.exit(f"❌ 缺少 {p}，请先运行 update.py 选项4（解析成分股md→行业/行情/股息率→缓存→Excel）")
    stock = json.load(open("cache/_成分股汇总.json", encoding="utf-8"))
    rows = json.load(open("cache/_成分股汇总表.json", encoding="utf-8"))
    row_map = {r["code"]: r for r in rows}
    import datetime
    today = datetime.date.today()
    out = []
    for i, c in enumerate(CANDIDATES):
        s = stock.get(c, {})
        price = s.get("t_price") or s.get("price") or 0
        url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?"
               "reportName=RPT_SHAREBONUS_DET&columns=ALL"
               f"&filter=(SECURITY_CODE%3D%22{c}%22)"
               "&pageNumber=1&pageSize=8&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&source=WEB&client=WEB")
        try:
            d = json.loads(em_get(url))
            rows_ = (d.get("result") or {}).get("data") or []
            rec = []
            for r in rows_:
                exdate = str(r.get("EX_DIVIDEND_DATE") or "")[:10]
                bonus = r.get("PRETAX_BONUS_RMB") or 0
                if exdate and bonus:
                    rec.append((exdate, round(bonus, 3)))
            total12 = 0.0
            for exdate, bonus10 in rec:
                try:
                    y, m, _ = map(int, exdate.split("-"))
                    if (today.year - y) * 12 + (today.month - m) <= 12:
                        total12 += bonus10 / 10.0   # PRETAX_BONUS_RMB 为每10股口径，÷10 → 每股
                except Exception:
                    pass
            dy = round(total12 / price * 100, 2) if price and total12 else None
        except Exception as e:
            rec, dy = [], None
        r = row_map.get(c, {})
        out.append({
            "code": c, "name": s.get("name"), "ind": r.get("ind"), "ind3": r.get("ind3"),
            "n": r.get("n"), "maxw": r.get("maxw"), "pe": r.get("pe"), "pb": r.get("pb"),
            "mcap": r.get("mcap"), "price": price,
            "div_yield": dy, "div_rec": rec[:5],
        })
        if (i + 1) % 10 == 0:
            print(f"  进度 {i+1}/{len(CANDIDATES)}")
    json.dump(out, open("cache/_候选股息率.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("\n候选股息率:")
    for r in sorted(out, key=lambda x: -(x["div_yield"] or 0)):
        print(f"  {r['code']} {r['name']:<8} {r['ind']:<6} 股息率={r['div_yield']}% PE={r['pe']} PB={r['pb']} 市值={r['mcap']:.0f}亿 分红={r['div_rec'][:3]}")

if __name__ == "__main__":
    main()
