# scripts/_archive —— 无引用脚本归档

> 归档日期：2026-09-08（T9）· 依据：`docs/20260908执行方案.md` B6-6、`docs/20260908优化方向分析.md` §4.4

## 为什么归档

下列脚本在**全链路中已无任何引用**（`update.py` / `serve.py` / 其他 `scripts/*.py` 均不 import、不调用；
全仓扫描仅剩文档与 README 的说明性提及），且多为一次性研究/回填工具，保留在 `scripts/` 会干扰
"公共模块单一来源"的阅读与检索。

## 清单

| 脚本 | 原用途 | 归档原因 |
| :--- | :--- | :--- |
| `_fetch_index_data.py` | （原研究）候选指数行情/估值 | 指数行情已由 `_fetch_history.py` 统一承担 |
| `_find_index_code.py` | 指数代码查询 | 一次性查询工具，已由成分/指数清单常量取代 |
| `_recommend_data.py` | 早期推荐数据抓取 | 已被 `_recommend_stocks.py`（量化评分）取代 |
| `_candidate_dy.py` | 股息率候选筛选 | 已被 `_recommend_stocks.py` 硬过滤 + 汇总表取代 |
| `_full_backfill.py` | 全量回填（分红历史/股息率） | 一次性回填已完成；**北交所补估值分支已删除**（2026-09-08 起北交所标的从个股池剔除，R2） |
| `_gen_summary_excel.py` | 汇总 Excel | 与 `_update_summary.gen_excel()` 重复，后者为唯一实现 |

## 注意

- 这些脚本使用**相对路径**读写 `cache/`，只能在项目根目录运行：`python scripts/_archive/<脚本>.py`
- 它们**不在** `update.py` 的任何链路中，正常数据更新不会触达
- 若确需复用：`git mv scripts/_archive/<脚本>.py scripts/`（并确认与现行单一来源实现不冲突）

## 恢复归档前的版本

```bash
git log --oneline -- scripts/_archive/<脚本>.py   # 找到归档 commit
git show <commit>^:scripts/<脚本>.py > scripts/<脚本>.py
```
