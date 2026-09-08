/* 数据层：缓存 JSON 加载（内存缓存，K线文件大只加载一次）
   N4：内存 LRU 上限——小数据（manifest/analysis/dy_series 等）常驻白名单；
   K线/指标按「字节预算 + 条数」淘汰最久未用，避免长时间浏览持续涨堆 */

const cache = new Map();     // url -> json（插入序即 LRU 序，命中时移到末尾）
const sizes = new Map();     // url -> 近似字节（响应 Content-Length，缺失记 0）
let cacheBytes = 0;          // 非白名单条目合计字节
const FETCH_TIMEOUT = 15000;

export async function loadJSON(url) {
  if (cache.has(url)) {
    const v = cache.get(url);
    if (!PINNED.has(url)) { cache.delete(url); cache.set(url, v); }   // LRU touch
    return v;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    const j = await r.json();
    const bytes = Number(r.headers.get('content-length')) || 0;
    cache.set(url, j);
    sizes.set(url, bytes);
    if (!PINNED.has(url)) { cacheBytes += bytes; evictOldest(); }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

function evictOldest() {
  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
    let victim = null;
    for (const k of cache.keys()) {
      if (!PINNED.has(k)) { victim = k; break; }
    }
    if (victim === null) return;   // 只剩白名单，不再淘汰
    cacheBytes -= sizes.get(victim) || 0;
    sizes.delete(victim);
    cache.delete(victim);
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

/* N4：常驻白名单（体积小、每个视图都要用；淘汰后反复重拉反而更慢）与淘汰阈值 */
const PINNED = new Set([
  MANIFEST_URL, ANALYSIS_URL, BACKTEST_URL, PORTFOLIO_URL, SUMMARY_URL, COMPONENTS_URL, DY_SERIES_URL,
]);
const MAX_ENTRIES = 200;                 // 非白名单最多缓存条数
const MAX_BYTES = 48 * 1024 * 1024;      // 非白名单字节预算（≈100 只 K线 + 指标）

export function has(url) {
  return cache.has(url);
}

/* N4：缓存诊断（浏览器验证/调试用） */
export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes, pinned: PINNED.size, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES };
}
