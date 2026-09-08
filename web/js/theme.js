/* 主题切换（深色/浅色）
   N8：热切换——只改 <html data-theme>，CSS 变量即时生效（无 reload、无数据请求、视图状态保留）；
   canvas 图表（ECharts）颜色取自 cssVar，无法被 CSS 变量直接刷新，故切换时按「CSS 变量旧值→新值」
   映射重写着色并重绘（charts.js#rethemeCharts / compareView 各自订阅）。 */

const KEY = 'pi_theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; }
}

/* 读取当前主题下 CSS 变量值（供 ECharts 等 canvas 取色；DOM 挂载后调用） */
export function cssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '';
  } catch {
    return '';
  }
}

/* :root 全部自定义属性快照（切换前后对比 → 旧色→新色映射） */
function cssVarSnapshot() {
  const out = new Map();
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const name of cs) {
      if (name.startsWith('--')) out.set(name, cs.getPropertyValue(name).trim());
    }
  } catch { /* 忽略 */ }
  return out;
}

/* 把主题应用到 <html>（dark = 无属性，与 index.html 预置脚本一致） */
function applyTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

const listeners = [];

/* 订阅主题变化：回调收到 Map<旧色, 新色>（颜色未变的变量不在其中） */
export function onThemeChange(cb) {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
}

/* 切换主题：写偏好 → 改 data-theme（CSS 立即生效）→ 通知 canvas 图表重着色重绘 */
export function setTheme(t) {
  if (t !== 'light' && t !== 'dark') return;
  if (t === getTheme()) return;
  const before = cssVarSnapshot();
  try { localStorage.setItem(KEY, t); } catch { /* 隐私模式忽略 */ }
  applyTheme(t);
  const after = cssVarSnapshot();
  const colorMap = new Map();
  for (const [name, oldVal] of before) {
    const newVal = after.get(name);
    if (oldVal && newVal && newVal !== oldVal) colorMap.set(oldVal, newVal);
  }
  for (const cb of listeners) {
    try { cb(colorMap); } catch (e) { console.error('[theme] 重绘失败', e); }
  }
}

/* 顶栏切换按钮：当前深色显示 ☀（目标浅色），浅色显示 🌙；热切换后按钮自身同步 */
export function mountThemeToggle(container) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  const sync = () => {
    const cur = getTheme();
    btn.title = cur === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    btn.setAttribute('aria-label', btn.title);
    btn.textContent = cur === 'dark' ? '☀' : '🌙';
  };
  btn.addEventListener('click', () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'));
  onThemeChange(sync);
  sync();
  container.append(btn);
}
