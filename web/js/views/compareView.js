/* 视图：对比分析（同类对比：指数/ETF/股票各自内部多选，归一化净值同图观察趋势关系）
   数据全部来自现有缓存（klineUrl 直读 /cache/），零后端改动 */

import { loadJSON, klineUrl, MANIFEST_URL, ANALYSIS_URL } from '../data.js';
import { el, fmt2, fmtSigned, dirOf, fmtScale, skeleton, errorBox, emptyState } from './common.js';
import { cssVar } from '../theme.js';

const MAX = 8;   // 最多同时对比的标的数
const KIND = { index: '指数', etf: 'ETF', stock: '股票' };
const PALETTE = ['#60A5FA', '#818CF8', '#F87171', '#F472B6', '#34D399', '#FBBF24', '#22D3EE', '#A78BFA'];
const RANGES = [['all', '全部'], ['5y', '5年'], ['3y', '3年'], ['1y', '1年']];
const WIN_N = { '5y': 1250, '3y': 750, '1y': 250 };

export default {
  async mount(root) {
    root.innerHTML = '';
    const m = await loadJSON(MANIFEST_URL);
    const toItem = (x, type) => ({ code: x.code, name: x.name, type, price: x.last_close, chg: x.last_chg, scale: x.scale });
    const allItems = {
      index: m.indices.map(x => toItem(x, 'index')),
      etf: m.etfs.map(x => toItem(x, 'etf')),
    };
    const st = m.stocks || [];
    const stockGroups = [
      { label: '推荐20', items: st.filter(s => s.rec).map(x => toItem(x, 'stock')) },
      { label: '自选股', items: st.filter(s => s.watch && !s.rec).map(x => toItem(x, 'stock')) },
      { label: '其他', items: st.filter(s => !s.rec && !s.watch).map(x => toItem(x, 'stock')) },
    ];

    /* ── 状态 ── */
    let curType = 'index';      // index / etf / stock
    let curGroup = 0;           // 股票分组 tab
    let query = '';
    const selected = new Map(); // code -> item（已选）
    const order = [];           // 选择顺序（chips 展示序）

    /* ── DOM ── */
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '对比分析'),
      el('div', { class: 'txt-3', style: 'font-size:12px' },
        '同类对比：指数↔指数 / ETF↔ETF / 股票↔股票，归一化净值同图观察趋势关系（最多 ' + MAX + ' 只）')));

    const typeTabs = el('div', { class: 'seg-group', role: 'group', 'aria-label': '对比类型' });
    const chipsEl = el('div', { class: 'cmp-chips' });
    const btnClear = el('button', { class: 'seg-btn', disabled: true }, '清空');
    const btnGo = el('button', { class: 'cmp-go', disabled: true }, '开始对比');
    const toolbar = el('div', { class: 'cmp-toolbar' },
      typeTabs,
      el('div', { class: 'cmp-toolbar-right' }, chipsEl, el('div', { class: 'cmp-actions' }, btnClear, btnGo)));

    const searchBox = el('input', { class: 'ticker-search', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索标的' });
    const groupTabs = el('div', { class: 'cmp-groups', style: 'display:none' });
    const listEl = el('ul', { class: 'cmp-list' });
    const listPanel = el('div', { class: 'card cmp-list-panel' }, searchBox, groupTabs, listEl);

    const mainEl = el('div', { class: 'card cmp-main' },
      el('div', { class: 'empty-state', style: 'padding:64px 16px' },
        '选择 ≥2 只同类标的，点击「开始对比」查看归一化净值走势'));
    const body = el('div', { class: 'cmp-body' }, listPanel, mainEl);

    root.append(el('div', { class: 'card cmp-panel' }, toolbar, body));

    /* ═══ 对比图表（步骤2：归一化净值同图）═══ */
    let chartApi = null;
    let navMode = true;      // ETF 净值/场内价
    let rangeKey = 'all';
    let cmp = null;          // 已加载数据 {dates, aligned}
    const rangeBtns = [];

    /* 开始对比：拉数据 → 共同起点对齐 → 归一化 → 图表 */
    async function renderCompare() {
      if (order.length < 2) return;
      mainEl.innerHTML = '';
      mainEl.append(skeleton());
      try {
        const items = order.map(code => selected.get(code));
        const series = [];
        for (const it of items) {
          const obj = await loadJSON(klineUrl(KIND[it.type], it.code));
          const rows = (obj && obj.rows) || [];
          if (!rows.length) throw new Error(`${it.name}（${it.code}）缓存无数据`);
          series.push({ it, rows });
        }
        /* 共同起点 = 各序列起始日期的最大值（保证窗口内全部有数据） */
        const start = series.reduce((mx, s) => (mx < s.rows[0].date ? s.rows[0].date : mx), '');
        const aligned = series.map(s => {
          const useNav = s.it.type === 'etf' && navMode;
          const rows = s.rows.filter(r => r.date >= start);
          const pts = rows.map(r => ({ date: r.date, v: r[useNav ? 'nav' : 'close'] ?? r.close }));
          const base = pts[0] && pts[0].v;
          if (!base) throw new Error(`${s.it.name} 起点无数据`);
          return { it: s.it, pts, base };
        });
        /* 日期轴 = 共同起点后全部交易日并集（缺失填 null 断线） */
        const dateSet = new Set();
        for (const a of aligned) for (const p of a.pts) dateSet.add(p.date);
        const dates = [...dateSet].sort();
        const rows2 = aligned.map(a => {
          const map = new Map(a.pts.map(p => [p.date, p.v / a.base * 100]));
          return { it: a.it, vals: dates.map(d => map.get(d) ?? null) };
        });
        cmp = { dates, aligned: rows2 };
        buildChart();
      } catch (err) {
        mainEl.innerHTML = '';
        mainEl.append(errorBox(`对比加载失败：${err.message}`, () => renderCompare()));
      }
    }

    /* 图表（可被净值切换/range 按钮重绘） */
    function buildChart() {
      if (!cmp) return;
      mainEl.innerHTML = '';
      const n = cmp.dates.length;
      if (n < 250) {
        mainEl.append(el('div', { class: 'cmp-warn' }, `⚠ 共同窗口仅 ${n} 个交易日（不足1年），建议移除上市较晚的标的`));
      }
      /* 工具条：ETF 净值/场内价切换（仅 ETF 对比）+ 时间范围 */
      const segNav = el('div', { class: 'seg-group', role: 'group' },
        ['净值', '场内价'].map((lab, i) => el('button', { class: 'seg-btn' + ((i === 0) === navMode ? ' active' : ''),
          onclick: () => { navMode = i === 0; buildChart(); } }, lab)));
      rangeBtns.length = 0;
      const segRange = el('div', { class: 'seg-group', role: 'group' }, RANGES.map(([key, label]) => {
        const b = el('button', { class: 'seg-btn' + (key === rangeKey ? ' active' : ''), onclick: () => setRange(key) }, label);
        rangeBtns.push([key, b]);
        return b;
      }));
      const bar = el('div', { class: 'cmp-chart-bar' },
        el('span', { class: 'cmp-chart-title' }, '归一化净值（起点=100）'),
        el('div', { style: 'display:flex;gap:8px' },
          curType === 'etf' ? segNav : null,
          segRange));
      const chartEl = el('div', { class: 'chart', style: 'height:460px;margin-top:8px' });
      mainEl.append(bar, chartEl);
      renderDetailCards();

      if (chartApi) { chartApi.dispose(); chartApi = null; }
      chartApi = echarts.init(chartEl);
      const names = cmp.aligned.map(r => r.it.name);
      const axis = cssVar('--text-3');
      const grid = cssVar('--grid-line');
      chartApi.setOption({
        animation: false,
        legend: { top: 0, data: names, icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
        tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'),
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
        grid: { left: 52, right: 16, top: 36, bottom: 60 },
        xAxis: { type: 'category', data: cmp.dates, boundaryGap: false,
          axisLine: { lineStyle: { color: grid } }, axisLabel: { color: axis, fontSize: 10.5 }, axisTick: { show: false } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: axis, fontSize: 10.5 },
          splitLine: { lineStyle: { color: grid } } },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0 },
          { type: 'slider', xAxisIndex: 0, height: 16, bottom: 6, borderColor: 'transparent',
            backgroundColor: cssVar('--input-bg'), fillerColor: 'rgba(96,165,250,.12)',
            handleStyle: { color: cssVar('--brand') } },
        ],
        series: cmp.aligned.map((r, i) => ({
          name: r.it.name, type: 'line', data: r.vals, showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.6, color: PALETTE[i % PALETTE.length] },
          itemStyle: { color: PALETTE[i % PALETTE.length] },
        })),
      });
      applyRange();
    }

    function setRange(key) {
      rangeKey = key;
      for (const [k, b] of rangeBtns) b.classList.toggle('active', k === key);
      applyRange();
    }

    function applyRange() {
      if (!chartApi || !cmp) return;
      const n = cmp.dates.length;
      const win = WIN_N[rangeKey];
      const start = win && n > win ? (n - win) / n * 100 : 0;
      chartApi.dispatchAction({ type: 'dataZoom', start, end: 100 });
    }

    /* ═══ 步骤3/4：区间信号表 + 统计表（共同窗口）═══ */
    const bandOf = (s) => (s <= 25 ? '买入区间' : s <= 45 ? '逐步建仓' : s <= 65 ? '持有' : s <= 80 ? '逐步卖出' : '卖出区间');
    const bandCls = (b) => ({ '买入区间': 'band-buy', '逐步建仓': 'band-build', '持有': 'band-hold', '逐步卖出': 'band-sell', '卖出区间': 'band-sell2' }[b] || 'band-hold');
    let anCache = null;
    const loadAnalysis = async () => (anCache || (anCache = await loadJSON(ANALYSIS_URL)));

    /* 信号表行：档位/均衡分/股息率/5年分位/锚距% */
    async function renderDetailCards() {
      const an = await loadAnalysis();
      const sigRows = [];
      const statRows = [];
      for (const r of cmp.aligned) {
        const it = r.it;
        const ent = an.by_code[it.code];
        let sig = null;
        if (ent) {
          const sysKey = ent.type === '股票' ? 'B' : 'A';
          const w = an.presets['均衡'][sysKey];
          let s = 0, tot = 0;
          for (const k in w) {
            const f = ent.factors[k];
            if (f && f.pct != null) { s += f.pct * w[k]; tot += w[k]; }
          }
          const score = tot ? s / tot : null;
          const band = bandOf(score);
          const dyF = ent.factors.dy;
          const an2 = ent.anchors;
          sig = { score, band,
            dy: dyF && dyF.v != null ? dyF.v : null,
            pct: dyF && dyF.pct != null ? dyF.pct : null,
            db: an2 ? an2.dist_buy : null, ds: an2 ? an2.dist_sell : null };
        }
        sigRows.push({ it, sig });
        /* 统计：用共同窗口归一化序列（null 过滤） */
        const vals = r.vals.filter(v => v != null);
        if (vals.length >= 2) {
          const n = vals.length;
          const ret = vals[n - 1] / vals[0] - 1;
          const ann = Math.pow(1 + ret, 252 / n) - 1;
          let sum = 0, ss = 0;
          const rets = [];
          for (let i = 1; i < n; i++) { const x = vals[i] / vals[i - 1] - 1; rets.push(x); sum += x; ss += x * x; }
          const mean = sum / rets.length;
          const vol = Math.sqrt(Math.max(0, ss / rets.length - mean * mean)) * Math.sqrt(252);
          let peak = vals[0], mdd = 0;
          for (const v of vals) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
          statRows.push({ it, ret, ann, vol, mdd, sharpe: vol > 0 ? ann / vol : null, days: n });
        } else {
          statRows.push({ it, ret: null });
        }
      }
      const tbl = (head, rows) => {
        const h = el('tr', {}, head.map(c => el('th', {}, c)));
        const trs = rows.map((cells) => el('tr', {}, cells.map(c => el('td', {}, c))));
        return el('table', { class: 'cmp-table' }, el('thead', {}, h), el('tbody', {}, trs));
      };
      const fmtPct2 = (v, dg) => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(dg == null ? 1 : dg) + '%');
      /* 信号表 */
      const sigTbl = tbl(['标的', '区间信号', '均衡分', '股息率', '5年分位', '买入锚距', '卖出锚距'],
        sigRows.map(({ it, sig }) => sig
          ? [it.name, el('span', { class: 'ana-band ' + bandCls(sig.band) }, sig.band), fmt2(sig.score),
            sig.dy != null ? sig.dy.toFixed(2) + '%' : '—', sig.pct != null ? sig.pct.toFixed(1) : '—',
            fmtPct2(sig.db, 1), fmtPct2(sig.ds, 1)]
          : [it.name, el('span', { class: 'txt-3' }, '无分析数据'), '—', '—', '—', '—', '—']));
      /* 统计表 */
      const statTbl = tbl(['标的', '区间收益', '年化', '年化波动', '最大回撤', '夏普'],
        statRows.map(({ it, ret, ann, vol, mdd, sharpe }) => [it.name,
          ret == null ? '—' : fmtPct2(ret * 100, 1), ann == null ? '—' : fmtPct2(ann * 100, 1),
          vol == null ? '—' : (vol * 100).toFixed(1) + '%', mdd == null ? '—' : (mdd * 100).toFixed(1) + '%',
          sharpe == null ? '—' : sharpe.toFixed(2)]));
      const grid = el('div', { class: 'cmp-detail-grid' },
        el('div', { class: 'card cmp-detail' },
          el('div', { class: 'cmp-detail-title' }, '区间信号对比（analysis.json，均衡档）'),
          el('div', { style: 'overflow-x:auto' }, sigTbl)),
        el('div', { class: 'card cmp-detail' },
          el('div', { class: 'cmp-detail-title' }, '统计对比（共同窗口 ' + cmp.dates.length + ' 个交易日，无风险利率=0）'),
          el('div', { style: 'overflow-x:auto' }, statTbl)));
      mainEl.append(grid);
    }


    /* ── 当前类型列表（含搜索/分组）── */
    function currentItems() {
      let items = curType === 'stock' ? stockGroups[curGroup].items : allItems[curType];
      if (query) {
        const q = query.toLowerCase();
        items = items.filter(it => it.name.toLowerCase().includes(q) || it.code.includes(q));
      }
      return items;
    }

    function renderList() {
      listEl.innerHTML = '';
      const items = currentItems();
      if (!items.length) {
        listEl.append(el('li', { class: 'empty-state', style: 'padding:20px 8px' }, '无匹配标的'));
        return;
      }
      for (const it of items) {
        const sel = selected.has(it.code);
        const li = el('li', { class: 'cmp-item' + (sel ? ' sel' : ''), role: 'button', tabindex: '0',
            'aria-label': it.name + it.code },
          el('span', { class: 'cmp-check' }, sel ? '✓' : ''),
          el('span', { class: 'cmp-item-name' }, it.name, it.scale != null ? el('em', { class: 'cmp-scale' }, fmtScale(it.scale)) : null),
          el('span', { class: 'cmp-item-code' }, it.code),
          el('span', { class: 'cmp-item-price txt-' + dirOf(it.chg) }, it.price == null ? '—' : fmt2(it.price)));
        const pick = () => toggle(it);
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        listEl.append(li);
      }
    }

    function renderGroupTabs() {
      groupTabs.innerHTML = '';
      groupTabs.style.display = curType === 'stock' ? '' : 'none';
      if (curType !== 'stock') return;
      stockGroups.forEach((g, i) => {
        groupTabs.append(el('button', { class: 'cmp-gtab' + (i === curGroup ? ' active' : ''),
            onclick: () => { curGroup = i; query = ''; searchBox.value = ''; renderList(); } },
          g.label, el('em', {}, g.items.length)));
      });
    }

    /* ── 已选 chips ── */
    function renderChips() {
      chipsEl.innerHTML = '';
      if (!order.length) {
        chipsEl.append(el('span', { class: 'txt-3', style: 'font-size:12px' }, '未选择标的'));
      }
      for (const code of order) {
        const it = selected.get(code);
        const chip = el('span', { class: 'cmp-chip' }, it.name, el('i', { class: 'cmp-chip-x', role: 'button', 'aria-label': '移除' }, '×'));
        chip.querySelector('.cmp-chip-x').addEventListener('click', () => toggle(it));
        chipsEl.append(chip);
      }
      btnClear.disabled = !order.length;
      btnGo.disabled = order.length < 2;
    }

    /* ── 勾选/取消（上限保护）── */
    function toggle(it) {
      if (selected.has(it.code)) {
        selected.delete(it.code);
        order.splice(order.indexOf(it.code), 1);
      } else {
        if (order.length >= MAX) {
          btnGo.textContent = '最多对比 ' + MAX + ' 只';
          setTimeout(() => { btnGo.textContent = '开始对比'; }, 1200);
          return;
        }
        selected.set(it.code, it);
        order.push(it.code);
      }
      renderChips();
      renderList();
    }

    /* ── 类型切换（同类约束：切换即清空已选）── */
    function setType(t) {
      if (t === curType) return;
      curType = t;
      curGroup = 0;
      query = '';
      searchBox.value = '';
      selected.clear();
      order.length = 0;
      for (const b of typeTabs.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.t === t);
      renderGroupTabs();
      renderList();
      renderChips();
    }

    /* 类型 Tab */
    for (const [key, label] of [['index', '指数'], ['etf', 'ETF'], ['stock', '股票']]) {
      typeTabs.append(el('button', { class: 'seg-btn' + (key === 'index' ? ' active' : ''), 'data-t': key, onclick: () => setType(key) }, label));
    }

    searchBox.addEventListener('input', () => { query = searchBox.value.trim(); renderList(); });
    btnClear.addEventListener('click', () => { selected.clear(); order.length = 0; renderChips(); renderList(); });
    btnGo.addEventListener('click', () => renderCompare());

    renderGroupTabs();
    renderList();
    renderChips();
  },
  dispose() {},
};

