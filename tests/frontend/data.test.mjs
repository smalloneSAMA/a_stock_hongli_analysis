/* 前端数据层单测（N4）：loadJSON 内存 LRU 上限
   运行：node --test --test-isolation=none "tests/frontend/*.test.mjs"
   用假 fetch 驱动（每条约 1 MB），验证：命中缓存不重复请求 / 超预算按 LRU 淘汰 / 白名单常驻 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJSON, cacheStats, has, MANIFEST_URL } from '../../web/js/data.js';

const MB = 1024 * 1024;

function mockFetch(bytes = MB) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes) : null) },
      json: async () => ({ url }),
    };
  };
  return () => calls;
}

test('loadJSON：同 URL 命中内存缓存，不重复请求', async () => {
  const calls = mockFetch();
  await loadJSON('/cache/指数_000001.json');
  await loadJSON('/cache/指数_000001.json');
  assert.equal(calls(), 1);
});

test('loadJSON：非白名单超字节预算 → 按 LRU 淘汰最久未用', async () => {
  const calls = mockFetch();
  const st0 = cacheStats();
  const n = Math.ceil(st0.maxBytes / MB) + 12;   // 预算条数 + 12
  const urls = [];
  for (let i = 0; i < n; i++) { const u = '/cache/压力_' + i + '.json'; urls.push(u); await loadJSON(u); }
  const st = cacheStats();
  assert.ok(st.bytes <= st.maxBytes, '字节 ' + st.bytes + ' 应 ≤ ' + st.maxBytes);
  assert.ok(st.entries <= st.maxEntries, '条数 ' + st.entries + ' 应 ≤ ' + st.maxEntries);
  const before = calls();
  await loadJSON(urls[0]);
  assert.equal(calls(), before + 1, '最早条目应已被淘汰（需重新请求）');
  const before2 = calls();
  await loadJSON(urls[urls.length - 1]);
  assert.equal(calls(), before2, '最近条目应命中缓存');
});

test('白名单常驻：大量 K线 之后 manifest 仍命中缓存', async () => {
  const calls = mockFetch();
  await loadJSON(MANIFEST_URL);
  for (let i = 0; i < 60; i++) await loadJSON('/cache/白名单压力_' + i + '.json');
  assert.ok(has(MANIFEST_URL), 'manifest 应仍在缓存');
  const before = calls();
  await loadJSON(MANIFEST_URL);
  assert.equal(calls(), before, 'manifest 应常驻，不重新请求');
  assert.ok(cacheStats().entries <= cacheStats().maxEntries);
});