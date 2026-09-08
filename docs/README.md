# docs/ 目录索引

> 本目录混放**自动生成物**与**手写文档**，边界见下表。判断规则：
> 顶部有 `> 🤖 本文件由脚本自动生成` 头注的即为生成物（同时已在 `.gitattributes` 标记 `linguist-generated`）。

## 自动生成（勿手工编辑，重生成会覆盖）

| 文件 | 生成脚本 | 复跑命令 |
| :--- | :--- | :--- |
| `回测报告.md` | `scripts/_backtest_analysis.py` | `python scripts/_backtest_analysis.py` |
| `组合回测报告.md` | `scripts/_backtest_portfolio.py` | `python scripts/_backtest_portfolio.py` |
| `回测执行日对比.md` | `scripts/_backtest_exec_compare.py` | `python scripts/_backtest_exec_compare.py` |

## 手写文档（可自由编辑）

| 文件 | 说明 |
| :--- | :--- |
| `买卖区间分析-设计方案.md` | 区间分析（S1-S8）口径与设计 |
| `改进方案-代码质量专项.md` | 代码质量专项改进方案 |
| `市赚率（PR）指标详细分析.md` | 市赚率指标研究 |
| `20260908优化方向分析.md` / `20260908需求设计方案.md` / `20260908执行方案.md` | 2026-09-08 优化专项三件套 |
| `20260908TODO.md` | 执行清单与验收记录（T1-T32 + N1-N20） |
| `基金概况_红利ETF.html` | 参考资料快照 |

## 项目根目录的其他文档

- `README.md`（结构与数据源）、`AGENTS.md`（代理开发指南）、`困难总结.md`（踩坑编号清单，当前 157 条）、
  `红利介绍.md` / `红利指数与ETF成分股.md` / `红利股票推荐20只.md`（研究笔记，脚本只读不写）
