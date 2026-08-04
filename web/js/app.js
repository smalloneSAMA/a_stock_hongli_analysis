/* 应用入口：hash 路由 + 视图懒加载 + 数据日期徽章 */

import { loadJSON, MANIFEST_URL } from './data.js';

const VIEWS = ['index', 'etf', 'stock', 'summary'];

const viewEl = document.getElementById('view');
const dateEl = document.getElementById('data-date');

function currentView() {
  const h = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(h) ? h : 'index';
}

function paintNav(active) {
  document.querySelectorAll('.nav-tab').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === active);
  });
}

let loading = null;

async function navigate() {
  const name = currentView();
  paintNav(name);
  viewEl.innerHTML = '';
  if (loading) loading.dispose?.();
  const mod = await import(`./views/${name}View.js`);
  const view = mod.default;
  loading = view;
  try {
    await view.mount(viewEl);
  } catch (err) {
    console.error(err);
    viewEl.innerHTML = '';
    const { errorBox } = await import('./views/common.js');
    viewEl.append(errorBox(`视图加载失败：${err.message}`, () => navigate()));
  }
}

/* 数据日期徽章 */
async function initDateBadge() {
  try {
    const m = await loadJSON(MANIFEST_URL);
    dateEl.textContent = `数据日期 ${m.data_date || '—'}`;
  } catch {
    dateEl.textContent = '数据日期 缓存未生成';
  }
}

window.addEventListener('hashchange', () => { navigate().catch(console.error); });
navigate().catch(console.error);
initDateBadge();
