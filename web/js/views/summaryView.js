/* 视图：成分股汇总（289只，统计卡+筛选+行业分布+股息率TOP+全量表格） */

/* 入选推荐20只：动态读 manifest 的 rec 标记（由 scripts/_recommend_stocks.py 评分产物驱动），
   替代原硬编码清单（旧人工20只） */
import { loadJSON, SUMMARY_URL, MANIFEST_URL, COMPONENTS_URL } from '../data.js';
import { el, fmt2, fmt0, fmtPct, dirOf, renderTable, skeleton, errorBox, favStar, openTicker } from './common.js';
import { createDonut, createBar, disposeChart } from '../charts.js';

/* 入选推荐20只标记：动态读 manifest（rec 由评分产物驱动），删除原硬编码清单 */

const columns = [
  { key: 'fav', label: '★', align: 'center', sortable: false, filter: false, fmt: (_v, row) => favStar(row.code) },
  { key: 'code', label: '证券代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: 'name', label: '证券名称', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh'),
    fmt: (v, row) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); openTicker(row.code, row.name, '股票'); }, class: 'jump-link', title: '查看历史K线（股票）' }, v) },
  { key: 'ind', label: '一级行业', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh') },
  { key: 'ind3', label: '细分行业', align: 'left', sortable: true, cmp: (a, b) => a.localeCompare(b, 'zh') },
  { key: 'n', label: '入选指数/ETF数', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'maxw', label: '最大权重(%)', align: 'center', sortable: true, fmt: fmt2 },
  { key: 'price', label: '最新价(元)', align: 'center', sortable: true, fmt: fmt2 },
  { key: 'change_pct', label: '当日涨跌幅(%)', align: 'center', sortable: true, fmt: fmtPct, color: (v) => dirOf(v) },
  { key: 'pe', label: 'PE(TTM)(倍)', align: 'center', sortable: true, fmt: fmt2 },
  { key: 'pb', label: 'PB(倍)', align: 'center', sortable: true, fmt: fmt2 },
  { key: 'mcap', label: '总市值(亿元)', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : fmt0(v)) },
  { key: 'div_yield', label: '近12个月股息率(%)', align: 'center', sortable: true, fmt: fmt2, color: (v) => (v > 0 ? 'brand' : 'flat') },
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
    let donutFilterInd = null;   // 行业分布环形图点击筛选（与搜索/下拉/推荐勾选叠加）
    let all = [];

    const load = async () => {
      const [data, m, comp] = await Promise.all([loadJSON(SUMMARY_URL), loadJSON(MANIFEST_URL), loadJSON(COMPONENTS_URL)]);
      if (!Array.isArray(data) || !data.length) throw new Error('summary.json 无数据');
      const recSet = new Set((m.stocks || []).filter(s => s.rec).map(s => s.code));
      all = data.map((r) => ({ ...r, _rec: recSet.has(r.code) }));
      render(data, all, m, comp);
    };

    const render = (rows, base, m, comp) => {
      body.innerHTML = '';
      /* 重载保护：旧图表实例挂在已清空的 DOM 上，须先销毁（视图常驻+重试场景） */
      if (donutChart) { disposeChart(donutChart); donutChart = null; }
      if (barChart) { disposeChart(barChart); barChart = null; }
      donutFilterInd = null;

      const statCard = (label, value, sub, amber) => el('div', { class: 'stat-card card' + (amber ? ' amber' : '') },
        el('div', { class: 'stat-label' }, label),
        el('div', { class: 'stat-value' }, value),
        el('div', { class: 'stat-sub' }, sub));

      /* ── 统计卡 ── */
      const dyVals = rows.map(r => r.div_yield).filter(v => v != null && v > 0);
      const avgDy = dyVals.length ? dyVals.reduce((a, b) => a + b, 0) / dyVals.length : 0;
      const maxDy = dyVals.length ? Math.max(...dyVals) : 0;
      const maxDyStock = dyVals.length ? rows.find(r => r.div_yield === maxDy) : null;
      const recCount = base.filter(r => r._rec).length;   // 用 base（含 _rec），rows 为原始数据无此字段

      const stats = el('div', { class: 'stat-row' },
        statCard('成分股总数', String(rows.length), `${rows.length} 只`),
        statCard('一级行业', String(new Set(rows.map(r => r.ind)).size), '个行业', 'amber'),
        statCard('平均股息率', fmt2(avgDy) + '%', '近12个月口径'),
        statCard('最高股息率', fmt2(maxDy) + '%', maxDyStock ? `${maxDyStock.name}（${maxDyStock.code}）` : '', 'amber'),
        statCard('入选20只推荐', String(recCount), '量化评分产物 cache/_推荐20.json'));
      body.append(stats);

      /* ── 筛选栏 ── */
      const industries = [...new Set(base.map(r => r.ind))].sort((a, b) => a.localeCompare(b, 'zh'));
      const searchInput = el('input', { class: 'filter-input', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索成分股' });
      const indSelect = el('select', { class: 'filter-select', 'aria-label': '按一级行业筛选' },
        el('option', { value: '' }, '全部行业'), ...industries.map(i => el('option', { value: i }, i)));

      /* ── 指数/ETF 筛选：倒排表 belong[股票code] = Map(指数/ETF code → 权重)
         通道A：summary 行 idx 字段（[名称, 权重]，东财口径）；通道B：components 成分代码（兜底，无权重） */
      const POOL = [
        ...(m.indices || []).map(x => ({ code: x.code, name: x.name.split('(')[0].trim(), type: '指数' })),
        ...(m.etfs || []).map(x => ({ code: x.code, name: x.name.split('(')[0].trim(), type: 'ETF' })),
      ];
      const nameToCode = new Map(POOL.map(p => [p.name, p.code]));
      const belong = new Map();
      for (const r of base) {
        const bm = new Map();
        for (const pair of (r.idx || [])) {
          if (!Array.isArray(pair) || !pair.length) continue;
          const c = nameToCode.get(pair[0]);
          if (c) bm.set(c, pair[1] ?? null);
        }
        belong.set(r.code, bm);
      }
      if (comp) {
        for (const [c, info] of Object.entries(comp.by_index || {})) {
          for (const s of (info.stocks || [])) {
            if (!belong.has(s.code)) belong.set(s.code, new Map());
            if (!belong.get(s.code).has(c)) belong.get(s.code).set(c, null);
          }
        }
        for (const [c, info] of Object.entries(comp.by_etf || {})) {
          for (const s of (info.stocks || [])) {
            if (!belong.has(s.code)) belong.set(s.code, new Map());
            if (!belong.get(s.code).has(c)) belong.get(s.code).set(c, null);
          }
        }
      }
      /* 通道命中统计（510880 无成分数据 → 禁用） */
      const poolN = new Map(POOL.map(p => [p.code, 0]));
      for (const bm of belong.values()) for (const c of bm.keys()) poolN.set(c, (poolN.get(c) || 0) + 1);
      let poolSel = '';   // 选中的指数/ETF code（'' = 全部）

      /* 选项构建（拆中间变量防括号地狱） */
      const optOf = (p) => {
        const empty = (poolN.get(p.code) || 0) === 0;
        return el('option', { value: p.code, disabled: empty ? true : undefined },
          `${p.name}（${p.code}）${empty ? ' · 无成分数据' : ''}`);
      };
      const poolSelect = el('select', { class: 'filter-select', 'aria-label': '按指数/ETF筛选成分' });
      poolSelect.append(
        el('option', { value: '' }, '全部指数和ETF'),
        el('optgroup', { label: '指数' }, POOL.filter(p => p.type === '指数').map(optOf)),
        el('optgroup', { label: 'ETF' }, POOL.filter(p => p.type === 'ETF').map(optOf)));
      const recCheck = el('label', { class: 'check-toggle', style: 'cursor:pointer' },
        el('input', { type: 'checkbox', 'aria-label': '仅看推荐20只' }), '仅看推荐20只');
      const countSpan = el('span', { class: 'filter-count' });
      const filterBar = el('div', { class: 'filter-bar card' }, searchInput, indSelect, poolSelect, recCheck, countSpan);
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
        if (poolSel) out = out.filter(r => belong.get(r.code)?.has(poolSel));   // 指数/ETF 成分（包含语义）
        if (recOnly) out = out.filter(r => r._rec);
        if (donutFilterInd) out = out.filter(r => r.ind === donutFilterInd);   // 环形图行业筛选
        countSpan.textContent = `筛选结果 ${out.length} / ${base.length}`;
        /* 选中指数/ETF 时：动态加“权重(%)”列（该股在所选指数/ETF 中的权重，东财口径；重建表格并按权重降序） */
        const wtMap = new Map(out.map(r => [r.code, poolSel ? (belong.get(r.code)?.get(poolSel) ?? null) : null]));
        const cols = poolSel
          ? [...columns, { key: 'wt', label: `权重%·${POOL.find(p => p.code === poolSel)?.name || ''}`, align: 'center', sortable: true, filter: false,
            fmt: (v) => (v == null ? '—' : fmt2(v) + '%'),
            color: (v) => (v != null && v >= 5 ? 'up' : v != null && v < 1 ? 'down' : '') }]
          : columns;
        const rowsOut = out.map(r => ({ ...r, wt: wtMap.get(r.code) }));
        tableApi = renderTable(tableBox, { columns: cols, rows: rowsOut, pageSize: 50 });
        if (poolSel) tableApi.sortBy('wt', -1);
        renderCharts(out);
      };
      /* 收藏变化：星标自身已同步（表格 ★ 列组件内监听） */

      /* ── 表格 ── */
      const tableBox = grid.querySelector('.table-card');
      const tableApiLocal = renderTable(tableBox, { columns, rows, pageSize: 50 });
      tableApi = tableApiLocal;

      /* ── 图表 ── */
      let donutPoolSel = '';   // 环形图当前数据对应的指数/ETF（变化时重建）
      const renderCharts = (out) => {
        const donutEl = grid.querySelector('.mini-chart');
        const barEl = grid.querySelector('.mini-chart.bar');
        const donutTitleEl = grid.querySelector('.card-title');

        /* 行业分布环形图：数据源 = 当前指数/ETF 成分（切换指数/ETF 时重建；
           搜索/行业下拉/推荐20 不改环形图——保持图表稳定，标题提示筛选） */
        const poolBase = poolSel ? base.filter(r => belong.get(r.code)?.has(poolSel)) : base;
        const rebuildDonut = !donutChart || poolSel !== donutPoolSel;
        donutPoolSel = poolSel;
        if (rebuildDonut) {
          if (donutChart) { disposeChart(donutChart); donutChart = null; }
          const cnt = new Map();
          for (const r of poolBase) cnt.set(r.ind, (cnt.get(r.ind) || 0) + 1);
          const donutData = [...cnt.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
          donutChart = createDonut(donutEl, donutData, { title: '成分股行业分布', selectable: true });
          /* 点击行业扇区 → 表格筛选该行业；再点同一扇区 → 取消 */
          donutChart.on('click', (p) => {
            if (!p || !p.name) return;
            donutFilterInd = (donutFilterInd === p.name) ? null : p.name;
            applyFilter();
          });
        }
        donutTitleEl.textContent = '行业分布'
          + (poolSel ? ' · ' + (POOL.find(x => x.code === poolSel)?.name || '') : '')
          + (donutFilterInd ? ' · 筛选：' + donutFilterInd + '（再点击取消）' : '');

        /* 股息率 TOP15：每次筛选刷新（donut 保持稳定不动） */
        if (barChart) { disposeChart(barChart); barChart = null; }
        const dyTop = out
          .filter(r => r.div_yield != null && r.div_yield > 0)
          .sort((a, b) => b.div_yield - a.div_yield)
          .slice(0, 15)
          .map(r => ({ name: r.name, value: r.div_yield }));
        barChart = createBar(barEl, dyTop, { title: '近12个月股息率 TOP15', unit: '%' });
      };

      searchInput.addEventListener('input', applyFilter);
      indSelect.addEventListener('change', applyFilter);
      poolSelect.addEventListener('change', () => { poolSel = poolSelect.value; applyFilter(); });
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
