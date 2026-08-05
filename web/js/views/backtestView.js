/* 回测报告视图：股息率分位信号回测结果（web/data/backtest.json）
   三档（p85/90/95）切换 + 汇总卡 + 明细表；数据由 scripts/_backtest_analysis.py 生成 */

import { el, renderTable, skeleton, errorBox, fmt2 } from './common.js';
import { loadJSON, BACKTEST_URL } from '../data.js';

const COLS = [
  { key: 'code', label: '代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: 'name', label: '名称', align: 'left', sortable: true },
  { key: 'type', label: '类型', align: 'center', sortable: true },
  { key: 'n_buy', label: '信号数', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v) },
  { key: 'win6', label: '胜率6M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v + '%') },
  { key: 'win12', label: '胜率12M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v + '%') },
  { key: 'ex6', label: '超额6M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
  { key: 'ex12', label: '超额12M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
];

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton({ style: 'min-height:320px' }));
    try {
      const bt = await loadJSON(BACKTEST_URL);
      root.innerHTML = '';

      const head = el('div', { class: 'bt-head' },
        el('h2', { class: 'chart-title' }, '股息率分位信号回测报告'),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8;margin-top:4px' },
          `生成日期 ${bt.date} · 信号：dy 上穿 p 分位=买、下穿 ${100 - bt.order[0]}~${100 - bt.order[bt.order.length - 1]} 分位=卖（5年滚动窗口），次一交易日收盘执行；ETF 用跟踪指数序列`),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8' },
          '收益为价格口径（不含分红再投）；基准 = 同区间每日买入的平均收益；超额 = 信号组均值 − 基准'),
      );
      const presetBar = el('div', { class: 'seg-group', style: 'margin-top:10px' },
        bt.order.map(p => el('button', { class: 'seg-btn' + (p === 90 ? ' active' : ''), onclick: () => render(p) }, 'p' + p)));
      const sumCard = el('div', { class: 'bt-summary' });
      const tableBox = el('div', {});
      root.append(head, presetBar, sumCard, tableBox);

      let tableApi = null;
      function render(p) {
        for (const b of presetBar.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.textContent === 'p' + p);
        const rows = bt.by_p[String(p)] || [];
        const s = bt.summary[String(p)] || {};
        /* 汇总卡 */
        sumCard.innerHTML = '';
        const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');
        const cells = [
          ['有效标的', s.n + ' 个', ''],
          ['6M正超额', pct(s.pos6, s.n), ''],
          ['12M正超额', pct(s.pos12, s.n), ''],
          ['平均超额6M', s.avg6 == null ? '—' : (s.avg6 >= 0 ? '+' : '') + s.avg6 + '%', s.avg6 > 0 ? 'up' : 'down'],
          ['平均超额12M', s.avg12 == null ? '—' : (s.avg12 >= 0 ? '+' : '') + s.avg12 + '%', s.avg12 > 0 ? 'up' : 'down'],
          ['指数12M超额', s.idx12 == null ? '—' : (s.idx12 >= 0 ? '+' : '') + s.idx12 + '%', 'up'],
          ['股票12M超额', s.stk12 == null ? '—' : (s.stk12 >= 0 ? '+' : '') + s.stk12 + '%', s.stk12 > 0 ? 'up' : 'down'],
        ];
        for (const [k, v, cls] of cells) {
          sumCard.append(el('div', { class: 'bt-cell' },
            el('div', { class: 'txt-3', style: 'font-size:11px' }, k),
            el('div', { class: 'bt-val ' + (cls === 'up' ? 'txt-up' : cls === 'down' ? 'txt-down' : '') }, v)));
        }
        /* 明细表（复用 renderTable；skip 行数字列显示 —） */
        tableBox.innerHTML = '';
        tableApi = renderTable(tableBox, { columns: COLS, rows, pageSize: 20 });
        tableApi.sortBy('ex12', -1);
      }
      render(90);
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox(`回测报告加载失败：${err.message}（数据由 python scripts/_backtest_analysis.py 生成）`, () => this.mount(root)));
    }
  },
};
