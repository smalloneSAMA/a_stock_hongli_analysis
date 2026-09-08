# tests/ —— 回归测试目录

| 目录 | 内容 | 运行方式 | 是否进 CI |
| :--- | :--- | :--- | :--- |
| `frontend/` | 前端纯函数单测（`analysis.js` / `reco.js`：权重表、分档边界、候选池构建、评分公式） | `node --test --test-isolation=none tests/frontend/analysis.test.mjs tests/frontend/reco.test.mjs` | ✅（CI 前置步骤） |
| `browser/` | 浏览器端冒烟（陈旧角标渲染、三主视图不请求 `analysis_dy`、对比页改读 `dy_series`） | 见下 | ❌（需 Edge + playwright-core，本地人工） |

> Python 侧测试不在此目录：`python scripts/_common.py`（公共模块自测，54 项）、`python scripts/_test_analysis.py [--no-snapshot]`（65 项 / CI 63 项结构断言）。

## 浏览器冒烟 `tests/browser/smoke.mjs`

前置：

```bash
python serve.py 8125                                  # 项目根启动（no-cache）
npm install --prefix "%TEMP%\dsh-pw" playwright-core   # 只装驱动，不下载浏览器
```

运行（PowerShell）：

```powershell
$env:PW_PATH = Join-Path $env:TEMP "dsh-pw\node_modules\playwright-core"
node tests/browser/smoke.mjs          # 端口默认 8125，可用 DSH_PORT 覆盖
```

断言清单（15 项）：

- **T4**：向 `manifest.json` 注入一条 `stale`（列表首项）→ 角标文本含日期 + K线图已渲染；**结束后自动还原 manifest**
- **T12**：`#/scan`、`#/recommend`、`#/holdings` 各 0 次 `analysis_dy.json` 请求、已读 `analysis.json`、无错误框
- **T13**：`#/compare` 选中 2 只指数后请求 `dy_series.json`、0 次 `analysis_dy.json`、图表 ≥2 条系列
- 全程无未捕获 JS 异常
