/* 应用入口：hash 路由 + 视图懒加载（容器常驻，切换不销毁——保留各板块操作状态）+ 数据日期徽章 */

import { loadJSON, MANIFEST_URL } from './data.js';

const VIEWS = ['index', 'etf', 'stock', 'summary', 'backtest', 'portfolio'];

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

/* 视图容器常驻：首次进入才 mount，之后切换只改 display（保留 DOM 与图表状态） */
const containers = {};

async function navigate() {
  const name = currentView();
  paintNav(name);

  let c = containers[name];
  if (!c) {
    c = containers[name] = { el: document.createElement('div'), ready: null, mounted: false };
    viewEl.appendChild(c.el);
    c.ready = (async () => {
      const mod = await import(`./views/${name}View.js`);
      await mod.default.mount(c.el);
      c.mounted = true;
    })().catch(async (err) => {
      delete containers[name];
      c.el.remove();
      console.error(err);
      const { errorBox } = await import('./views/common.js');
      viewEl.append(errorBox(`视图加载失败：${err.message}`, () => navigate()));
    });
  }

  /* 显示当前视图，隐藏其余（不销毁） */
  for (const k in containers) {
    containers[k].el.style.display = k === name ? '' : 'none';
  }

  if (c.ready) await c.ready;
  /* 隐藏期间图表容器尺寸为 0，切回时触发 resize 校准 */
  window.dispatchEvent(new Event('resize'));
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
