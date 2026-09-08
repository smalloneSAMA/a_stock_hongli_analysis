# -*- coding: utf-8 -*-
"""后端关键函数单测（N20）：回测信号执行日 / 组合回测因子取值 / 收盘价合并

运行：python -m unittest discover -s tests/python -t . -v
（纯函数 + 小型 fixture，不触网、不读 cache/，秒级）
"""
import datetime
import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, "scripts"))

import _backtest_analysis as ba  # noqa: E402
import _backtest_portfolio as bp  # noqa: E402
import _gen_analysis as ga  # noqa: E402


def _days(n, start="2020-01-01"):
    d0 = datetime.date(*[int(x) for x in start.split("-")])
    return [(d0 + datetime.timedelta(days=i)).isoformat() for i in range(n)]


class TestRunBacktestExecOffset(unittest.TestCase):
    """锁定执行日索引口径：buy_dates = [dates[k + exec_offset - 1]]，
    k = 首次 pct ≥ p 的索引（分位上穿确认日）。即 exec_offset=1 → 确认当日收盘执行；=2 → 确认次日收盘执行。

    注意（N20 发现）：报告文案写「信号次一交易日收盘执行」，而实现是「上穿确认当日收盘执行」，
    两者相差一天——本测试锁定现状，口径若调整会立即失败（详见 docs/20260908TODO.md N20 记录）。"""

    @classmethod
    def setUpClass(cls):
        # 序列需 ≥ WINDOW(1250)+100 天，且信号落在 w=1250 之后、尾部留足 252 天（否则无 12M 收益样本）
        cls.dates = _days(1600)
        dy = [5.0] * 1250 + [10.0] * 350          # 第 1250 天跳到 10.0 → 恰好一次「上穿 p90」
        close = [100.0 + i * 0.1 for i in range(1600)]
        cls.rows = [(cls.dates[i], dy[i], close[i]) for i in range(1600)]
        cls.info = {"name": "测试标的", "type": "股票"}
        cls._orig = ba.merge_close
        ba.merge_close = lambda typ, code, info: cls.rows

    @classmethod
    def tearDownClass(cls):
        ba.merge_close = cls._orig

    def _run(self, exec_offset):
        return ba.run_backtest("000000", self.info, p_buy=90, exec_offset=exec_offset)

    def test_signal_count_and_index(self):
        out = self._run(1)
        self.assertEqual(out["n_buy"], 1)
        self.assertEqual(out["buy_dates"], [self.dates[1250]])   # k=1250：exec_offset=1 → 确认当日

    def test_exec_offset_shifts_one_trading_day(self):
        self.assertEqual(self._run(2)["buy_dates"], [self.dates[1251]])   # exec_offset=2 → 确认次日
        self.assertEqual(self._run(1)["buy_dates"], [self.dates[1250]])

    def test_short_series_skipped(self):
        orig = ba.merge_close
        ba.merge_close = lambda typ, code, info: self.rows[:200]
        try:
            self.assertEqual(ba.run_backtest("000000", self.info)["skip"], "序列过短")
        finally:
            ba.merge_close = orig


class TestMergeClose(unittest.TestCase):
    """merge_close：close 缺失日剔除；ETF 改用跟踪指数缓存与序列"""

    def setUp(self):
        self.calls = []
        self._orig_load = ba.fh.load_cache
        self._orig_dys = ba.stock_dy_series

        def fake_load(typ, code):
            self.calls.append((typ, code))
            return {"rows": [{"date": "2020-01-01", "close": 10.0},
                             {"date": "2020-01-02", "close": None},
                             {"date": "2020-01-03", "close": 11.0}]}
        ba.fh.load_cache = fake_load
        ba.stock_dy_series = lambda code, c: [("2020-01-01", 5.0), ("2020-01-02", 6.0), ("2020-01-03", 7.0)]

    def tearDown(self):
        ba.fh.load_cache = self._orig_load
        ba.stock_dy_series = self._orig_dys

    def test_drops_missing_close(self):
        out = ba.merge_close("股票", "600036", {"type": "股票"})
        self.assertEqual(out, [("2020-01-01", 5.0, 10.0), ("2020-01-03", 7.0, 11.0)])

    def test_etf_uses_track_index_cache(self):
        out = ba.merge_close("ETF", "515180", {"type": "ETF", "track": "000922",
                                               "series": [("2020-01-01", 4.0), ("2020-01-03", 4.5)]})
        self.assertEqual(self.calls, [("指数", "000922")])
        self.assertEqual(out, [("2020-01-01", 4.0, 10.0), ("2020-01-03", 4.5, 11.0)])

    def test_missing_cache_returns_empty(self):
        ba.fh.load_cache = lambda typ, code: None
        self.assertEqual(ba.merge_close("指数", "000922", {"type": "指数", "series": []}), [])


class TestPortfolioFactorHelpers(unittest.TestCase):
    def test_div_metrics_annual_sum(self):
        dc = {"rows": [{"ex_date": "2023-06-10", "bonus10": 2.0},
                       {"ex_date": "2023-11-10", "bonus10": 3.0},
                       {"ex_date": "2022-07-01", "bonus10": 4.0},
                       {"ex_date": "2024-05-01", "bonus10": 9.0}]}   # 晚于 t_date，须忽略
        self.assertEqual(bp.div_metrics_at(dc, "2024-01-01"), (0.5, 0.4))   # 2023 年 0.2+0.3；2022 年 0.4
        self.assertIsNone(bp.div_metrics_at(None, "2024-01-01"))
        self.assertIsNone(bp.div_metrics_at({"rows": []}, "2024-01-01"))
        self.assertIsNone(bp.div_metrics_at(dc, "2022-01-01"))   # 无完整年度

    def test_annual_eps_only_full_year(self):
        fc = {"rows": [{"report_date": "2024-03-31", "eps": 0.3, "roe": 3.0},
                       {"report_date": "2023-12-31", "eps": 1.2, "roe": 12.0},
                       {"report_date": "2022-12-31", "eps": 1.0, "roe": 10.0}]}
        self.assertEqual(bp.annual_eps_at(fc, "2024-01-01"), (1.2, 12.0))
        self.assertEqual(bp.annual_eps_at(fc, "2022-01-01"), (None, None))
        self.assertEqual(bp.annual_eps_at(None, "2024-01-01"), (None, None))

    def test_roe_stability(self):
        rows = [{"report_date": f"20{20 + i // 4}-12-31", "roe": 12.0} for i in range(12)]
        self.assertEqual(bp.roe_stability_at({"rows": rows}, "2030-01-01"), 100.0)   # 恒定 roe → CV=0
        self.assertIsNone(bp.roe_stability_at({"rows": rows[:7]}, "2030-01-01"))     # 不足 8 期
        neg = [{"report_date": f"20{20 + i // 4}-12-31", "roe": -5.0} for i in range(12)]
        self.assertIsNone(bp.roe_stability_at({"rows": neg}, "2030-01-01"))          # 均值 ≤0

    def test_trend_matches_gen_analysis(self):
        up = [100.0 * (1.002 ** i) for i in range(250)]
        self.assertGreater(bp.trend_pct_at(up), 50.0)
        _v, pct = ga.build_trend(__import__("numpy").array(up))
        self.assertAlmostEqual(round(bp.trend_pct_at(up), 1), float(pct), places=6)   # 与 _gen_analysis.build_trend 同口径（后者保留 1 位）
        self.assertEqual(bp.trend_pct_at([1.0] * 10), 50.0)          # 不足 20 天

    def test_q_end_dates(self):
        rows = {"A": [("2020-03-30", 1, 1), ("2020-03-31", 1, 1), ("2020-06-30", 1, 1)],
                "B": [("2020-03-31", 1, 1), ("2020-06-29", 1, 1), ("2020-09-30", 1, 1)]}
        self.assertEqual(bp.q_end_dates(rows), ["2020-03-31", "2020-06-30", "2020-09-30"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
