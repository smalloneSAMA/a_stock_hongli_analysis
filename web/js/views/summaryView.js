/* 视图：成分股汇总（289只，统计卡+筛选+行业分布+股息率TOP+全量表格） */

import { loadJSON, SUMMARY_URL } from '../data.js';
import { el, fmt2, fmt0, fmtPct, dirOf, renderTable, skeleton, errorBox } from './common.js';
import { createDonut, createBar } from '../charts.js';

const FINAL20 = new Set(['600036', '601838', '601088', '601225', '600938', '601857', '600350', '601006',
  '600900', '600795', '000858', '000895', '000651', '000333', '000423', '600566',
  '600019', '601668', '600582', '600757']);

const columns = [
  { key: 'code', label: '证券代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: 'name', label: '证券名称', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh') },
  { key: 'ind', label: '一级行业', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh') },
  { key: 'ind3', label: '细分行业', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh') },
  { key: 'n', label: '入选指数/ETF数', sortable: true, fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'maxw', label: '最大权重(%)', sortable: true, fmt: fmt2 },
  { key: 'price', label: '最新价(元)', sortable: true, fmt: fmt2 },
  { key: 'change_pct', label: '当日涨跌幅(%)', sortable: true, fmt: fmtPct, color: (v) => dirOf(v) },
  { key: 'pe', label: 'PE(TTM)(倍)', sortable: true, fmt: fmt2 },
  { key: 'pb', label: 'PB(倍)', sortable: true, fmt: fmt2 },
  { key: 'mcap', label: '总市值(亿元)', sortable: true, fmt: (v) => (v == null ? '—' : fmt0(v)) },
  { key: 'div_yield', label: '近12个月股息率(%)', sortable: true, fmt: fmt2, color: (v) => (v > 0 ? 'brand' : 'flat') },
  { key: 'div_rec', label: '近5次分红记录', align: 'left', fmt: (v) => (v && v.length ? v.slice(0, 5).map(([d, b]) => `${d}派${b}元/10股`).join('；') : '近12个月无派息记录') },
  { key: 'idx', label: '主要入选指数及权重(%)', align: 'left', fmt: (v) => (v && v.length ? v.slice(0, 8).map(([n, w]) => (w == null ? `${n}(权重未公开)` : `${n} ${w}%`)).join('；') : '—') },
  { key: '_rec', label: '入选20只推荐', align: 'center', fmt: (v) => (v ? '是' : '否') },
];

export default {
  async mount(container) {
    container.append(el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, '成分股汇总'),
        el('div', { class: 'desc' }, '精选池（10只指数 + 11只ETF）全部成分股 · 行业 / 估值 / 股息率')),
      el('div', { class: 'txt-3', style: 'font-size:12px' }, '数据源：东财行业 + 腾讯估值 + 东财分红')));

    const body = el('div', {}, skeleton({ style: 'min-height:400px' }));
    container.append(body);

    let tableApi = null, donutChart = null, barChart = null;
    let all = [];

    const load = async () => {
      const data = await loadJSON(SUMMARY_URL);
      if (!Array.isArray(data) || !data.length) throw new Error('summary.json 无数据');
      all = data.map((r) => ({ ...r, _rec: FINAL20.has(r.code) }));
      render(data, all);
    };

    const render = (rows, base) => {
      body.innerHTML = '';

      const statCard = (label, value, sub, amber) => el('div', { class: 'stat-card card' + (amber ? ' amber' : '') },
        el('div', { class: 'stat-label' }, label),
        el('div', { class: 'stat-value' }, value),
        el('div', { class: 'stat-sub' }, sub));

      /* ── 统计卡 ── */
      const dyVals = rows.map(r => r.div_yield).filter(v => v != null && v > 0);
      const avgDy = dyVals.length ? dyVals.reduce((a, b) => a + b, 0) / dyVals.length : 0;
      const maxDy = dyVals.length ? Math.max(...dyVals) : 0;
      const maxDyStock = dyVals.length ? rows.find(r => r.div_yield === maxDy) : null;
      const recCount = rows.filter(r => r._rec).length;

      const stats = el('div', { class: 'stat-row' },
        statCard('成分股总数', String(rows.length), `${rows.length} 只`),
        statCard('一级行业', String(new Set(rows.map(r => r.ind)).size), '个行业', 'amber'),
        statCard('平均股息率', fmt2(avgDy) + '%', '近12个月口径'),
        statCard('最高股息率', fmt2(maxDy) + '%', maxDyStock ? `${maxDyStock.name}（${maxDyStock.code}）` : '', 'amber'),
        statCard('入选20只推荐', String(recCount), '《红利股票推荐20只.md》'));
      body.append(stats);

      /* ── 筛选栏 ── */
      const industries = [...new Set(base.map(r => r.ind))].sort((a, b) => a.localeCompare(b, 'zh'));
      const searchInput = el('input', { class: 'filter-input', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索成分股' });
      const indSelect = el('select', { class: 'filter-select', 'aria-label': '按一级行业筛选' },
        el('option', { value: '' }, '全部行业'), ...industries.map(i => el('option', { value: i }, i)));
      const recCheck = el('label', { class: 'check-toggle', style: 'cursor:pointer' },
        el('input', { type: 'checkbox', 'aria-label': '仅看推荐20只' }), '仅看推荐20只');
      const countSpan = el('span', { class: 'filter-count' });
      const filterBar = el('div', { class: 'filter-bar card' }, searchInput, indSelect, recCheck, countSpan);
      body.append(filterBar);

      /* ── 图表 + 表格 ── */
      const grid = el('div', { class: 'summary-grid' },
        el('div', { class: 'side-panel' },
          el('div', { class: 'card card-pad' },
            el('div', { class: 'card-title' }, '行业分布'),
            el('div', { class: 'mini-chart' }, '')),
          el('div', { class: 'card card-pad' },
            el('div', { class: 'card-title' }, '股息率 TOP15'),
            el('div', { class: 'mini-chart bar' }, ''))),
        el('div', { class: 'card table-card' }, el('div', { class: 'table-wrap', style: 'max-height:680px' }, '')));
      body.append(grid);

      const applyFilter = () => {
        const q = searchInput.value.trim().toLowerCase();
        const ind = indSelect.value;
        const recOnly = recCheck.querySelector('input').checked;
        let out = base;
        if (q) out = out.filter(r => r.name.toLowerCase().includes(q) || r.code.includes(q));
        if (ind) out = out.filter(r => r.ind === ind);
        if (recOnly) out = out.filter(r => r._rec);
        countSpan.textContent = `筛选结果 ${out.length} / ${base.length}`;
        tableApi.refresh(out);
        renderCharts(out);
      };

      /* ── 表格 ── */
      const tableBox = grid.querySelector('.table-card');
      const tableApiLocal = renderTable(tableBox, { columns, rows, pageSize: 50 });
      tableApi = tableApiLocal;

      /* ── 图表 ── */
      const renderCharts = (out) => {
        const donutEl = grid.querySelector('.mini-chart');
        const barEl = grid.querySelector('.mini-chart.bar');
        if (donutChart) { donutChart.dispose(); donutChart = null; }
        if (barChart) { barChart.dispose(); barChart = null; }

        const cnt = new Map();
        for (const r of out) cnt.set(r.ind, (cnt.get(r.ind) || 0) + 1);
        const donutData = [...cnt.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
        donutChart = createDonut(donutEl, donutData, { title: '成分股行业分布' });

        const dyTop = out
          .filter(r => r.div_yield != null && r.div_yield > 0)
          .sort((a, b) => b.div_yield - a.div_yield)
          .slice(0, 15)
          .map(r => ({ name: r.name, value: r.div_yield }));
        barChart = createBar(barEl, dyTop, { title: '近12个月股息率 TOP15', unit: '%' });
      };

      searchInput.addEventListener('input', applyFilter);
      indSelect.addEventListener('change', applyFilter);
      const recInput = recCheck.querySelector('input');
      recInput.addEventListener('change', () => { recCheck.classList.toggle('on', recInput.checked); applyFilter(); });
      applyFilter();
    };

    load().catch((err) => {
      body.innerHTML = '';
      body.append(errorBox(`成分股汇总数据加载失败：${err.message}（请先运行 update.py 选项4 生成汇总缓存，再运行 python scripts/_gen_web_data.py）`, () => {
        body.innerHTML = ''; body.append(skeleton({ style: 'min-height:400px' })); load().catch(console.error);
      }));
    });
  },
};
