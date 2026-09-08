# -*- coding: utf-8 -*-
"""推荐20组合约束单测（N20）：行业 ≤4 + 四象限各 ≥3 + 名单按总分重排

运行：python -m unittest discover -s tests/python -t . -v
"""
import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, "scripts"))

import _recommend_stocks as rs  # noqa: E402


def _item(code, score, ind):
    """ranked 条目结构：(code, scores, grp, fac, meta)"""
    return (code, {"均衡": score}, {}, {}, {"ind": ind, "name": code})


class TestApplyConstraints(unittest.TestCase):
    def test_quadrant_floor_and_industry_cap(self):
        # 金融 8 只（银行/非银金融，各 4）、防御 3 只、周期 3 只、消费 3 只 → 总分集中在金融
        ranked = []
        for i in range(4):
            ranked.append(_item(f"B{i}", 90 - i, "银行"))
        for i in range(4):
            ranked.append(_item(f"N{i}", 88 - i, "非银金融"))
        ranked += [_item("D0", 10, "公用事业"), _item("D1", 9, "交通运输"), _item("D2", 8, "环保")]
        ranked += [_item("C0", 7, "煤炭"), _item("C1", 6, "钢铁"), _item("C2", 5, "石油石化")]
        ranked += [_item("F0", 4, "食品饮料"), _item("F1", 3, "家用电器"), _item("F2", 2, "医药生物")]
        picked, backup = rs.apply_constraints(ranked, top=20)

        inds = [m["ind"] for _c, _s, _g, _f, m in picked]
        quads = [rs.QUADRANT.get(i, "其他") for i in inds]
        for q in ("金融", "防御", "周期", "消费"):
            self.assertGreaterEqual(quads.count(q), 3, f"{q} 象限保底 3 只")
        for ind in set(inds):
            self.assertLessEqual(inds.count(ind), 4, f"{ind} 行业上限 4 只")
        self.assertEqual(len(picked), len(ranked))          # 总量不足 20 时全进名单
        self.assertEqual(sorted(c for c, *_ in picked), sorted(c for c, *_ in ranked))
        self.assertEqual(backup, [])                        # 全部入选则无备选

    def test_sorted_by_score_and_backup_complete(self):
        # 20 只同象限、同行业（银行）→ 行业上限 4 只，其余进备选
        ranked = [_item(f"X{i:02d}", 100 - i, "银行") for i in range(20)]
        picked, backup = rs.apply_constraints(ranked, top=20)
        self.assertEqual(len(picked), 4)
        self.assertEqual([c for c, *_ in picked], ["X00", "X01", "X02", "X03"])
        self.assertEqual(len(backup), 16)
        self.assertEqual(sorted(c for c, *_ in picked + backup), sorted(c for c, *_ in ranked))
        scores = [s["均衡"] for _c, s, *_ in picked]
        self.assertEqual(scores, sorted(scores, reverse=True))   # 名单按总分降序

    def test_top_limit(self):
        ranked = [_item(f"Y{i:02d}", 100 - i, "银行") for i in range(4)]
        ranked += [_item(f"Z{i:02d}", 50 - i, "公用事业") for i in range(10)]
        picked, _backup = rs.apply_constraints(ranked, top=5)
        self.assertEqual(len(picked), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
