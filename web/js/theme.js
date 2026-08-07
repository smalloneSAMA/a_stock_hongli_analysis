/* 主题切换（深色/浅色）
   切换 = 保存偏好 + reload：ECharts 为 canvas 渲染，图表色在模块加载/mount 时读取
   CSS 变量（cssVar），reload 后全部图表按新主题重建，零漏改。 */

const KEY = 'pi_theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; }
}

export function setTheme(t) {
  try { localStorage.setItem(KEY, t); } catch { /* 隐私模式忽略 */ }
  location.reload();
}

/* 读取当前主题下 CSS 变量值（供 ECharts 等 canvas 取色；DOM 挂载后调用） */
export function cssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '';
  } catch {
    return '';
  }
}

/* 顶栏切换按钮：当前深色显示 ☀（目标浅色），浅色显示 🌙 */
export function mountThemeToggle(container) {
  const cur = getTheme();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.title = cur === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  btn.setAttribute('aria-label', btn.title);
  btn.textContent = cur === 'dark' ? '☀' : '🌙';
  btn.addEventListener('click', () => setTheme(cur === 'dark' ? 'light' : 'dark'));
  container.append(btn);
}
