/* 视图：对比分析（同类对比：指数/ETF/股票各自内部多选，归一化净值同图观察趋势关系）
   数据全部来自现有缓存（klineUrl 直读 /cache/），零后端改动 */

import { el } from './common.js';

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '对比分析'),
      el('div', { class: 'txt-3' }, '同类内多选（指数/ETF/股票各自对比），归一化净值同图观察趋势关系')));
    const panel = el('div', { class: 'view-card' },
      el('div', { class: 'empty-state', style: 'padding:48px 16px' },
        '选择器开发中——请稍候'));
    root.append(panel);
  },
  dispose() {},
};
