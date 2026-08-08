# AGENTS.md — A股红利研究项目（代理工作指南）

面向 AI 代理与协作者的开发手册。**结构/数据源等静态信息详见 README.md，本文件侧重"会踩坑的约定"与"改代码前必读的约束"。**

## 1. 项目定位

A股红利研究终端：红利指数/ETF/股票的行情、成分、股息率研究 + 回测分析 + 信号扫描 + 自选股清单维护。纯静态前端（无构建步骤），数据全部由 Python 脚本预计算。

## 2. 数据流拓扑（最核心，改代码前先定位环节）

```
抓取(_fetch_*) → cache/ 原始缓存(git跟踪) → 预计算(_gen_*/_recommend_*) → web/data/(git跟踪) → 前端读取
```

- **改抓取脚本**：只影响 cache/ → 需重跑 `update.py web`（或对应生成命令）前端才生效
- **改预计算脚本**：直接跑该脚本命令 + `update.py web`
- **改前端**：刷新页面即可（serve.py no-cache），但**数据包未重生成时前端改动无法体现新数据**
- cache/、web/data/ 共 1700+ 文件被 git 跟踪，属产物数据；功能提交不要混入大体积数据文件，涉及数据漂移的提交需在说明中注明

## 3. 命令速查

```bash
python update.py daily|full|idx|etf|rec|pool|watch|web|comp|summary|fin|bt|retry|excel|status [--yes]
```
- 交互式维护菜单：`python update.py`（含回测重跑/失败重试/缓存清理/重导Excel）
- 快捷命令：`python update.py wq`（自选股指标刷新）；`bt`（回测）；`status`（数据过期检测）
- 本地服务：**必须在项目根目录启动** `python serve.py`（默认 8000，no-cache），页面入口 **`http://localhost:8000/web/`**（资源路径为 `/web/...` 绝对路径，从 web/ 目录启动会导致 404）
- 脚本可单独运行：`python scripts/_fetch_watchlist.py --indicators` 等

## 4. 数据口径与约束（踩坑清单，违反必出事）

- **红涨绿跌**（A股习惯）：CSS 变量 `--up/--down`；K线颜色、涨跌% 全部遵守，勿按国际习惯反转
- **腾讯批量接口** `qt.gtimg.cn`：`v[45]` 总市值**已是亿元**（勿再除 1e8，曾致全为 0）；`v[39]`=PE(TTM)、`v[46]`=PB；北交所前缀 `bj`；50只/批防封
- **写用户维护的 Excel**（excel/ 自选股清单.xlsx 等）：先探测第1行表头→同名列原位覆盖（幂等）→否则**追加末尾新列**；**绝不用固定列号覆盖**（曾覆盖用户 E/F/G 列事故，困难总结133）
- 回测口径：超额 = 信号组均值 − 同区间每日买入基准均值（百分点差）；基准可为负，超额正=少亏也赢；报告含 基准6M/基准12M 列与分组基准12M
- 均线系统：**默认全关**，开关=主图图例点击（无按钮）；四色 金MA5/青MA20/紫MA60/蓝MA250；`maCache` 预计算，tooltip 固定行（null 显示 —）
- 收藏：localStorage key `pi_favs`，写后派发 `fav-change` 自定义事件（detail.code）驱动跨视图同步；星标按钮必须 `stopPropagation` 防触发行选中
- 自选股清单 xlsx 10 列（序号/名称/代码/展示/上市板块/一级行业/二级行业/总市值(亿)/PE(TTM)/PB），缓存 `cache/_自选股指标.json`（先落盘缓存再写文件，文件被占用时可重跑不重拉）
- 锚线：近5年价格分位（如招行 买31.46/卖50.01）；买卖区间分析 S1-S8
- 数据源：腾讯(行情)/中证官网(成分+指数)/国证官网(980092)/东财(分红、财报、成分)/新浪(ETF净值)，详见 README 数据源表

## 5. 前端架构约束

- 纯 ES Module + 全局 `echarts`（`vendor/echarts.min.js`，charts.js 直接引用全局，无 import）
- hash 路由 8 视图：`#/index|etf|stock|summary|backtest|portfolio|compare|scan`；**视图容器常驻不销毁**（切视图保留状态），收藏等跨视图状态靠事件同步
- **ESM 语法验证必须转 `.mjs`**：`cp f.js /tmp/f.mjs && node --check /tmp/f.mjs`——普通 `.js` 的 `node --check` 按 CJS 解析会漏检（困难总结127）
- **图表重建陷阱**：`setSubSeries` 用 `replaceMerge: ['series','legend']` 整体替换系列——按名字切片/查找系列（如 `cur.series.find(s => s.name === '成交量')`），**新增/改名系列后重建逻辑必须同步**（曾致指数板块 MA60/MA250 图例丢失，commit c65c520）
- tooltip 自定义 formatter 逐行拼接 HTML；成交量/成交额单位：万手/亿元
- 搜索历史 key：`pi_search_hist_{list_index|list_etf|list_stock|compare}`

## 6. 脚本/视图职责索引

| 文件 | 职责 |
|---|---|
| update.py | 数据更新总入口（交互菜单+快捷命令） |
| serve.py | 本地静态服务（项目根启动，no-cache） |
| _fetch_history.py | 指数/ETF 历史行情（增量拉取，INDICES/ETFS 常量在此） |
| _fetch_stock_data.py | 推荐20股票日线（不复权 2004 起） |
| _fetch_pool_data.py | 精选池−推荐20 的 K线/分红/财报/股本 + check-fin |
| _fetch_watchlist.py | 自选股清单.xlsx 行情/分红/财报 + `--indicators` 指标刷新 |
| _fetch_etf_data.py / _fetch_etf_holdings.py | ETF 行情 / ETF 持仓 |
| _fetch_cnindex_components.py / _gen_components.py | 国证成分 / 中证成分md重生成 |
| _recommend_stocks.py | ★ 推荐20量化评分（硬过滤+三组10因子+三档权重+组合约束→cache/_推荐20.json） |
| _gen_analysis.py / _gen_web_data.py | 逐日指标预计算 / 前端数据包生成 |
| _backtest_analysis.py / _backtest_portfolio.py | 回测分析（含基准6M/12M）/ 组合回测 |
| _update_summary.py / _gen_summary_excel.py | 成分股汇总 / 汇总 Excel |
| _classify.py / _candidate_dy.py / _find_index_code.py / _full_backfill.py | 行业分类 / 股息率候选 / 指数代码查找 / 全量回填 |
| web/js/views/*.js | 各视图（indexView/etfView/stockView/summaryView/backtestView/portfolioView/compareView/scanView） |
| web/js/charts.js | ECharts 工厂（K线/折线/环形/条形，图表重建逻辑） |
| web/js/views/common.js | 通用：收藏(localStorage)、renderTable、列表渲染 |

## 7. 验证流程（改代码后必做）

- **Python 脚本**：直接运行对应命令，检查 cache/ 与 web/data/ 产物字段/数值合理性
- **前端语法**：所有改动 JS 转 `.mjs` 后 `node --check`
- **前端行为**：真实浏览器验证用 **playwright-core + 系统 Edge headless**（`executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`）打开 `http://localhost:8000/web/#/视图`，用 `echarts.getInstanceByDom(document.querySelector('.chart')).getOption()` 探测 legend/series/selected（模型无法直接查看截图，此路径为唯一可靠验证；CloakBrowser Chromium 下载被网络阻断不可用）
- 回测 T7 快照随行情更新会漂移（因子微变），属正常非回归，同步刷新并注释即可

## 8. 协作工作流

- **"先不改代码"模式**：复杂需求（口径设计、方案取舍、UI 交互）先给方案/分析，用户明确确认后才编码
- git 提交：**中文主题 + 要点分列**（每条含根因/修复/验证），如 `修复指数板块 MA60/MA250 图例丢失：...`
- **困难总结.md 持续追加编号清单**（当前到 ~134），新坑必记：现象/根因/修复/教训
- 数据文件（cache/、web/data/）勿混入功能提交；提交前检查 diff 是否夹带产物
- 前端文件用 ESM；Python 用 UTF-8 + `# -*- coding: utf-8 -*-` 头部
