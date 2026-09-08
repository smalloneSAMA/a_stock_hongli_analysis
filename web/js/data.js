/* 数据层：缓存 JSON 加载（内存缓存，K线文件大只加载一次） */

const cache = new Map();
const FETCH_TIMEOUT = 15000;

export async function loadJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    const j = await r.json();
    cache.set(url, j);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

export function klineUrl(kind, code) {
  return `/cache/${kind}_${code}.json`;
}

export function indiUrl(code) {
  return `/web/data/stocks/${code}.json`;
}

/* T17：行数据列式编码 {cols, rows:[[…]]} → [{…}]（cache/*.json 与 web/data/stocks/*.json 统一格式）；
   旧格式（rows 为对象数组）原样返回；非行数据返回 []。None 位不落键，与旧格式「键缺失」语义一致 */
export function decodeRows(obj) {
  const rows = obj && obj.rows;
  if (!Array.isArray(rows)) return [];
  const cols = obj.cols;
  if (!Array.isArray(cols) || !rows.length || !Array.isArray(rows[0])) return rows;
  /* 按 cols 补齐全部键（缺失位为 null）——与 Python _common.decode_rows 完全一致 */
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });
}

/* T18：阶梯型列按变更点前向填充（与 Python _common.decode_sparse 等价） */
export function decodeSparse(rows, sparse) {
  if (!sparse || typeof sparse !== 'object') return rows;
  for (const k of Object.keys(sparse)) {
    const pts = sparse[k];
    if (!Array.isArray(pts)) continue;
    let cur = null, j = 0;
    for (let i = 0; i < rows.length; i++) {
      if (j < pts.length && pts[j][0] === i) { cur = pts[j][1]; j++; }
      rows[i][k] = cur;
    }
  }
  return rows;
}

/* T16/T17/T18：指标文件解码 = 列式行 + 稀疏列前向填充 */
export function decodeIndicator(obj) {
  return decodeSparse(decodeRows(obj), obj && obj.sparse);
}

export const COMPONENTS_URL = '/web/data/components.json';
export const ANALYSIS_URL = '/web/data/analysis.json';

export const MANIFEST_URL = '/web/data/manifest.json';
export const SUMMARY_URL = '/web/data/summary.json';
export const BACKTEST_URL = '/web/data/backtest.json';
export const DY_SERIES_URL = '/web/data/dy_series.json';   // 指数+ETF 的 dy 全量序列（T11 产出）
export const PORTFOLIO_URL = '/web/data/portfolio_backtest.json';

export function has(url) {
  return cache.has(url);
}
