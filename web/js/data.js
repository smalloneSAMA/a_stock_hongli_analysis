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

export const COMPONENTS_URL = '/web/data/components.json';
export const ANALYSIS_URL = '/web/data/analysis.json';

export const MANIFEST_URL = '/web/data/manifest.json';
export const SUMMARY_URL = '/web/data/summary.json';
export const BACKTEST_URL = '/web/data/backtest.json';
export const PORTFOLIO_URL = '/web/data/portfolio_backtest.json';

export function has(url) {
  return cache.has(url);
}
