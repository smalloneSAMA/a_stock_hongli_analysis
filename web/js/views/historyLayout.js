/* 历史行情视图共享布局（指数/ETF/股票三视图复用）
   结构：左列标的列表 + 右主区（报价头 + K线图 + 副图 + 数据表格）
   性能：列表信息来自 manifest（含最新价/涨跌），K线与指标在选中标的后按需加载（单文件），
         内存缓存保证切换秒开 */

import { el, renderTickerList, renderTable, skeleton, errorBox, emptyState, fmt2, fmtPct, dirOf, dailyChg, attachDatePicker } from './common.js';
import { loadJSON, klineUrl, indiUrl, COMPONENTS_URL, ANALYSIS_URL } from '../data.js';
import { createKlineChart, createDonut } from '../charts.js';
import { cssVar } from '../theme.js';

const D = { volume: 1e4, amount: 1e8 };  // 默认除数：ETF/股票（腾讯源）手→万手、元→亿元

/* 懒加载共享缓存：analysis.json（区间分析面板 + S7 图表锚线/dy副图共用） */
let analysisCache = null;
async function loadAnalysis() {
  if (!analysisCache) analysisCache = await loadJSON(ANALYSIS_URL);
  return analysisCache;
}

async function loadTickerObj(kind, code) {
  const obj = await loadJSON(klineUrl(kind, code));
  if (!obj || !Array.isArray(obj.rows) || !obj.rows.length) throw new Error('缓存无数据行');
  return obj;
}

function prepareKline(rows, { vdiv = D.volume, adiv = D.amount } = {}) {
  /* 单位换算：manifest 的 vdiv/adiv 已是「原始单位→万手/亿元」的完整除数（与 update.py
     export_excel 同口径，见 scripts/_gen_web_data.py IDX_DIV），直接相除，不得再乘 D。
     腾讯源（ETF/股票）：volume=手→÷1e4=万手，amount=元(估算)→÷1e8=亿元
     中证官网：tradingVol=股→÷1e6=万手，tradingValue=亿元→÷1
     国证官网：volume=万手→÷1，amount=亿元→÷1 */
  const dates = [], klines = [], volumes = [], amounts = [];
  const chgN = [30, 60, 90].map(n => rows.map(r => r['chg' + n] ?? null));
  for (const r of rows) {
    dates.push(r.date);
    klines.push([r.open ?? 0, r.close ?? 0, r.low ?? 0, r.high ?? 0]);
    volumes.push(r.volume == null ? null : r.volume / vdiv);
    amounts.push(r.amount == null ? null : r.amount / adiv);
  }
  return { dates, klines, volumes, amounts, chgN };
}

export function buildHistoryView(container, cfg) {
  /* cfg: {
   *   kind: 'index'|'etf'|'stock',
   *   title,
   *   items: [{code, name, price, chg, subHtml}],   // 来自 manifest，含最新价
   *   groups: [{label, items}...]                  // 可选：左侧列表分组切换（股票：推荐/其他成份股）
   *   chartUnit, subControl, indicatorOptions,
   *   quoteExtra(obj, rows), itemSub(obj, rows),    // 可选兜底
   *   chartNote(obj, rows), columns, buildTableRows(rows, k, ind),
   * } */
  const kinds = { index: '指数', etf: 'ETF', stock: '股票' };

  /* 列表标题：普通（单组）或带分组切换按钮 */
  const totalItems = cfg.groups ? cfg.groups.reduce((a, g) => a + g.items.length, 0) : cfg.items.length;
  const panelTitle = el('div', { class: 'ticker-head' },
    el('div', { class: 'card-title' }, cfg.title + '（' + totalItems + '）'),
    cfg.groups ? el('div', { class: 'seg-group', role: 'group', 'aria-label': '列表分组' }) : null);
  if (cfg.groups) {
    for (const [i, g] of cfg.groups.entries()) {
      /* tab 两行：文字 + 数量（label 形如 "推荐 20" → 拆为 seg-text/seg-num） */
      const m = String(g.label).match(/^(.*?)\s+(\d+)$/);
      const content = m
        ? [el('span', { class: 'seg-text' }, m[1]), el('span', { class: 'seg-num' }, m[2])]
        : g.label;
      panelTitle.querySelector('.seg-group').append(
        el('button', { class: 'seg-btn' + (i === 0 ? ' active' : ''), onclick: () => switchGroup(i) }, content));
    }
  }

  const layout = el('div', { class: 'view-layout' },
    el('aside', { class: 'ticker-panel card' }, panelTitle),
    el('section', { class: 'main-panel' },
      el('div', { class: 'card main-card' }, emptyState('选择左侧标的', '点击列表中的标的查看历史行情'))));
  container.append(layout);

  let state = { code: null, chart: null, range: 'all', view: 'chart' };
  /* 每只标的的视图状态记忆：{range, from, to, view}（切换标的不重置） */
  const codeState = {};

  /* S7 图表叠加：区间锚线（主图虚线）+ 股息率副图（曲线 + 90/10分位线）
     锚与分位线按当前 dataZoom 可见窗口动态计算（拖动/范围按钮/自定义日期统一走 onZoom），
     最小窗口 60 交易日（分位稳定性）。ETF 用跟踪指数序列计算，锚按场内价换算显示 */
  const MIN_WINDOW = 60;   // 交易日
  let analysisEnt = null;      // 当前标的的 analysis 条目
  let analysisCalcRows = null; // 计算用行情（ETF=跟踪指数，其他=自身）
  let analysisScale = 1;       // ETF 场内价/指数点位 换算系数
  let analysisZoomOff = null;  // onZoom 订阅（renderMain 重渲染时先释放）

  /* dy 序列（统一公式）：dy_t = dyNow × closeNow(最新收盘) / close_t
     窗口按 dataZoom 百分比定位（拖动平移时窗口内容随之变化）；最小跨度 MIN_WINDOW 天。
     返回 {dataByDate: Map, p10, p90}，p10/p90 为可见窗口分位 */
  const buildDySeries = (ent, calcRows, sPct, ePct) => {
    const dyNow = ent.factors.dy && ent.factors.dy.v;
    if (dyNow == null || !calcRows.length) return null;
    const n = calcRows.length;
    const closeNow = calcRows[n - 1].close;
    if (!closeNow) return null;
    let si = Math.max(0, Math.round(sPct / 100 * (n - 1)));
    let ei = Math.min(n - 1, Math.round(ePct / 100 * (n - 1)));
    if (ei - si + 1 < MIN_WINDOW) {   // 窄窗口保护：以当前窗口为中心扩展
      const mid = Math.round((si + ei) / 2);
      si = Math.max(0, mid - Math.floor(MIN_WINDOW / 2));
      ei = Math.min(n - 1, si + MIN_WINDOW - 1);
      if (ei - si + 1 < MIN_WINDOW) si = Math.max(0, ei - MIN_WINDOW + 1);
    }
    const vals = [];
    const dataByDate = new Map();
    for (let i = si; i <= ei; i++) {
      const c = calcRows[i].close;
      if (!c) continue;
      const v = Number((dyNow * closeNow / c).toFixed(4));
      dataByDate.set(calcRows[i].date, v);
      vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
    return { dataByDate, p10: q(0.1), p90: q(0.9) };
  };

  /* 按 dataZoom 可见窗口刷新锚线 + dy 副图（chartRows = 图表显示行，锚换算基准） */
  const applyAnalysisToChart = (chartApi, chartRows, sPct, ePct) => {
    if (!analysisEnt || !analysisEnt.anchors) return;
    const calcRows = analysisCalcRows || chartRows;
    const dyS = buildDySeries(analysisEnt, calcRows, sPct, ePct);
    if (!dyS) return;
    const closeCalc = calcRows[calcRows.length - 1].close;
    const dyNow = analysisEnt.factors.dy.v;
    const mk = (name, p, color) => {
      const anchor = closeCalc * dyNow / p;
      /* 锚 label 两行：上行文字（买入锚/卖出锚），下行数字（数值 + 距现价%） */
      return { value: Number((anchor * analysisScale).toFixed(3)), label: `${name}\n${fmt2(anchor * analysisScale)}（${(anchor / closeCalc - 1) * 100 >= 0 ? '+' : ''}${fmt2((anchor / closeCalc - 1) * 100)}%）`, color };
    };
    if (cfg.anchors !== false) {
      chartApi.addAnchorLines([mk('买入锚', dyS.p90, cssVar('--up')), mk('卖出锚', dyS.p10, cssVar('--mint'))]);
    }
    /* dy 副图数据对齐图表日期（ETF 的指数序列按日期映射） */
    const data = new Array(chartRows.length).fill(null);
    for (let i = 0; i < chartRows.length; i++) data[i] = dyS.dataByDate.get(chartRows[i].date) ?? null;
    chartApi.setSubSeries([{
      name: '股息率', data, color: cssVar('--brand'), unit: '%',
      markLines: [
        { value: dyS.p90, label: '90分位 ' + dyS.p90.toFixed(2), color: cssVar('--up') },
        { value: dyS.p10, label: '10分位 ' + dyS.p10.toFixed(2), color: cssVar('--mint') },
      ],
    }]);
  };

  /* dataZoom 变化 → 按当前可见窗口刷新锚/分位线（rAF 节流防拖动卡顿；所见即所得） */
  const bindZoomAnalysis = (chartApi, rows) => {
    if (analysisZoomOff) { analysisZoomOff(); analysisZoomOff = null; }
    let raf = 0;
    analysisZoomOff = chartApi.onZoom((s, e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (state.chart !== chartApi) return;
        applyAnalysisToChart(chartApi, rows, s, e);
      });
    });
  };

  const applyAnalysisOverlay = (chartApi, rows, code) => {
    loadAnalysis().then(async (an) => {
      if (state.chart !== chartApi) return;   // 已切换标的/重新渲染，丢弃过期回调
      const ent = an.by_code[code];
      if (!ent || !ent.anchors) return;
      analysisEnt = ent;
      analysisCalcRows = rows;
      analysisScale = 1;
      /* ETF：用跟踪指数序列计算分位/锚（自身价格含除息/折溢价噪声），锚按场内价比例换算 */
      if (ent.type === 'ETF' && ent.track) {
        try {
          const idx = await loadTickerObj('指数', ent.track);
          if (state.chart === chartApi && idx && idx.rows && idx.rows.length) {
            analysisCalcRows = idx.rows;
            const lastSelf = rows.length ? rows[rows.length - 1].close : null;
            const lastIdx = idx.rows[idx.rows.length - 1].close;
            if (lastSelf && lastIdx) analysisScale = lastSelf / lastIdx;
          }
        } catch { /* 指数行情加载失败则退化为自身序列 */ }
      }
      if (state.chart !== chartApi) return;
      bindZoomAnalysis(chartApi, rows);
      /* 初次按当前 dataZoom 可见窗口计算 */
      const dz = chartApi.getZoom?.() || null;
      applyAnalysisToChart(chartApi, rows, dz ? dz.start : 0, dz ? dz.end : 100);
    }).catch(() => { /* 分析数据加载失败不影响图表 */ });
  };

  const panel = layout.querySelector('.ticker-panel');
  const mainCard = layout.querySelector('.main-card');

  /* 当前分组数据（groups 存在时切换；否则恒为 cfg.items） */
  let groupIdx = 0;
  const itemsOf = () => (cfg.groups ? cfg.groups[groupIdx].items : cfg.items);
  let listApi = null;

  /* 分组切换：保持当前选中 code（若在新组），否则选中新组第一只；
     auto=false 时不自动选中（搜索结果点击场景，由调用方 select） */
  function switchGroup(i, { auto = true } = {}) {
    if (i === groupIdx || !cfg.groups) return;
    groupIdx = i;
    panel.querySelectorAll('.ticker-head .seg-btn').forEach((b, bi) => b.classList.toggle('active', bi === i));
    listApi.refresh(cfg.groups[i].items);
    if (!auto) return;
    if (state.code && cfg.groups[i].items.some(it => it.code === state.code)) {
      listApi.setActive(state.code);
    } else if (cfg.groups[i].items.length) {
      select(cfg.groups[i].items[0]);
    }
  }

  /* 全量列表（搜索范围：全部组可搜；按 code 去重，优先级按组序 推荐>其他>自选，重叠股票跳高优先组）
     非 groups 视图（指数/ETF）无全量列表，搜索用当前列表 */
  const allItems = cfg.groups ? [] : null;
  if (cfg.groups) {
    const seen = new Set();
    for (const g of cfg.groups) {
      for (const it of g.items) {
        if (seen.has(it.code)) continue;
        seen.add(it.code);
        allItems.push(it);
      }
    }
  }

  listApi = renderTickerList(panel, itemsOf(), {
    onSelect: (it) => {
      /* 搜索结果可能属于其他分组：自动切换到该分组 tab（不重复 select，由下方 select 接管）。
         当前分组内点击不切换——自选股与成份股重叠时留在当前 tab，不再被 findIndex 优先序带偏 */
      if (cfg.groups) {
        const inCur = cfg.groups[groupIdx].items.some(x => x.code === it.code);
        if (!inCur) {
          const gi = cfg.groups.findIndex(g => g.items.some(x => x.code === it.code));
          if (gi >= 0 && gi !== groupIdx) switchGroup(gi, { auto: false });
        }
      }
      select(it);
    },
    activeCode: state.code,
    searchable: true,
    searchItems: allItems || undefined,
    title: panelTitle,
  });

  // 默认选中第一只（立即渲染图表）
  const first = itemsOf();
  if (first.length) select(first[0]);

  /* ── 选中标的 → 按需加载 K线（+副图数据） → 图表 + 表格 ── */
  async function select(item) {
    /* 保存当前标的的状态（时间范围/日期/图表成分股tab） */
    if (state.code) {
      const st = codeState[state.code] || (codeState[state.code] = {});
      st.range = state.range || 'all';
      const f = mainCard.querySelector('.dr-from'), t = mainCard.querySelector('.dr-to');
      st.from = f ? f.value : '';
      st.to = t ? t.value : '';
      st.view = state.view || 'chart';
    }
    state.code = item.code;
    listApi.setActive(item.code);

    mainCard.innerHTML = '';
    mainCard.append(skeleton({ style: 'min-height:560px' }));
    const skeletonEl = mainCard.querySelector('.skeleton');

    try {
      const obj = await loadTickerObj(kinds[cfg.kind], item.code);
      const rows = obj.rows;

      /* 指标数据（股票主图叠加曲线用；副图模式已弃用，保留 subControl 分支兼容） */
      let subDefs = null;
      let ind = null;
      if (cfg.subControl === 'indicator' || cfg.withIndicator) {
        try {
          ind = await loadJSON(indiUrl(item.code));
        } catch { ind = null; }
        if (!ind || ind.length !== rows.length) ind = null;
        if (ind && cfg.subControl === 'indicator') {
          const opt = cfg.indicatorOptions[0];
          subDefs = [{ name: opt.label, data: ind.map(x => x[opt.key] ?? null), color: opt.color, unit: opt.unit }];
        }
      }

      renderMain(mainCard, item, obj, rows, ind, subDefs);
    } catch (err) {
      skeletonEl?.remove();
      mainCard.append(errorBox(`「${item.name}（${item.code}）」数据加载失败：${err.message}`, () => select(item)));
    }
    skeletonEl?.remove();
  }

  /* ── 渲染主区 ── */
  function renderMain(mainCard, item, obj, rows, ind, subDefs) {
    mainCard.innerHTML = '';
    const n = rows.length;
    const last = rows[n - 1];
    const chg = dailyChg(rows, n - 1);
    const dir = dirOf(chg);
    const unit = cfg.chartUnit;
    const m = (cfg.manifestMap?.get?.(item.code)) || {};
    const k = prepareKline(rows, { vdiv: m.vdiv, adiv: m.adiv });

    const chartBox = el('div', { class: 'chart-box' },
      el('div', { class: 'chart' + (cfg.subControl !== 'none' ? ' chart-short' : '') }, ''));

    /* 成分股面板（图表/成分股 切换按钮触发；复用成分股汇总板块的展示方式） */
    const compBox = el('div', { class: 'comp-panel', style: 'display:none' });
    /* 区间分析面板（S6：仪表盘 + 因子表 + 三档切换，数据 web/data/analysis.json） */
    const analysisBox = el('div', { class: 'analysis-panel', style: 'display:none' });

    /* 标的简介条（cfg.intros[code] → {intro, note}，插在报价头与图表之间） */
    const intro = cfg.intros ? cfg.intros[item.code] : null;

    const rowsTable = cfg.buildTableRows(rows, k, ind);
    const tableBox = el('div', {});
    const note = el('div', { class: 'chart-note' }, cfg.chartNote(obj, rows));

    // ⚠️ 必须先挂载到 DOM 再初始化 ECharts：容器未挂载时尺寸为 0，canvas 缓冲为 0×0 会空白
    mainCard.append(chartBox, compBox, analysisBox, tableBox, note);
    if (intro) {
      const introBar = el('div', { class: 'intro-bar' },
        el('div', { class: 'intro-text' }, intro.intro),
        el('div', { class: 'intro-note' }, intro.note));
      mainCard.insertBefore(introBar, chartBox);
    }

    if (state.chart) { state.chart.dispose(); }
    const chartApi = createKlineChart(chartBox.querySelector('.chart'), {
      dates: k.dates, klines: k.klines, volumes: k.volumes, amounts: k.amounts, chgN: k.chgN, indData: ind,
      unit, subUnit: subDefs?.[0]?.unit || '',
      mode: cfg.chartType || 'candlestick',
      showMA: cfg.showMA !== false,   // 默认开 MA；ETF 视图关
      showOHLC: cfg.showOHLC !== false,   // 默认显示 开盘/最高/最低；ETF 视图关
      overlay: cfg.overlay ? cfg.overlay(rows, ind) : null,   // 主图右轴叠加（ETF 净值 / 股票指标曲线）
    });
    state.chart = chartApi;
    if (subDefs) chartApi.setSubSeries(subDefs);

    /* 预设时间范围按钮（点击 → setRange → datazoom 事件 → onZoom 联动 UI） */
    const rangeApi = rangeGroup();
    /* 自定义起止日期：手动文本输入（YYYY-MM-DD），旁显上下限 */
    const dateRangeApi = dateRangeGroup();
    const vsGroup = viewSwitchGroup();   // 全部视图都有切换（股票：图表|区间分析；指数/ETF：图表|成分股|区间分析）

    const head = el('div', { class: 'chart-head' },
      el('div', {},
        el('h2', { class: 'chart-title' }, item.name, el('span', { class: 'code' }, item.code)),
        cfg.quoteExtra ? el('div', { class: 'txt-3', style: 'font-size:11.5px;margin-top:2px' }, cfg.quoteExtra(obj, rows)) : null),
      el('div', { class: 'chart-quote' },
        el('span', { class: 'price txt-' + dir }, fmt2(last.close)),
        el('span', { class: 'chg txt-' + dir }, chg == null ? '' : (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'),
        el('span', { class: 'txt-3', style: 'font-size:11.5px' }, unit)),
      el('div', { class: 'chart-meta' },
        rangeApi.el, dateRangeApi.el,
        cfg.subControl !== 'none' ? subControlGroup() : null,
        vsGroup ? vsGroup.el : null),
      );
    mainCard.prepend(head);

    /* 恢复该标的的记忆状态（时间范围/日期/图表成分股tab）；无记忆时继承当前 tab */
    const st = codeState[item.code] || (codeState[item.code] = { range: 'all', from: '', to: '', view: state.view });
    if (st.range && st.range !== 'all') chartApi.setRange(st.range);
    rangeApi.setActive(st.range || 'all');
    state.range = st.range || 'all';
    if (st.from || st.to) chartApi.setDateRange(st.from || null, st.to || null);
    if (vsGroup && st.view && st.view !== 'chart') vsGroup.setView(st.view);
    /* S7：图表叠加区间锚线 + 股息率副图（此时 state.range 已恢复记忆，锚按正确窗口计算） */
    applyAnalysisOverlay(chartApi, rows, item.code);

    /* 图表 ↔ 成分股 ↔ 区间分析 切换按钮组（股票视图无成分股：cfg.compView === false） */
    let compDonut = null;
    function viewSwitchGroup() {
      const g = el('div', { class: 'seg-group', role: 'group', 'aria-label': '视图切换' });
      const btns = [];
      const views = cfg.compView === false
        ? [['chart', '图表'], ['analysis', '区间分析']]
        : [['chart', '图表'], ['comp', '成分股'], ['analysis', '区间分析']];
      const setView = (view) => {
        state.view = view;
        for (const [v, b] of btns) b.classList.toggle('active', v === view);
        chartBox.style.display = view === 'chart' ? '' : 'none';
        compBox.style.display = view === 'comp' ? '' : 'none';
        analysisBox.style.display = view === 'analysis' ? '' : 'none';
        if (view === 'comp') renderComponents();
        if (view === 'analysis') renderAnalysis();
      };
      for (const [v, label] of views) {
        const b = el('button', { class: 'seg-btn' + (v === 'chart' ? ' active' : ''), onclick: () => setView(v) }, label);
        btns.push([v, b]);
        g.append(b);
      }
      return { el: g, setView };
    }

    /* 成分股视图：行业分布环形图 + 成分股表格（数据来自 web/data/components.json） */
    const COMP_COLUMNS = [
      { key: 'code', label: '代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
      { key: 'name', label: '名称', align: 'left', sortable: true },
      { key: 'ind', label: '一级行业', align: 'left', sortable: true },
      { key: 'ind3', label: '二级行业', align: 'left', sortable: true, fmt: (v) => (v ? v : '—') },
      { key: 'weight', label: '权重(%)', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)) },
      { key: 'div_yield', label: '股息率(%)', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)) },
    ];
    async function renderComponents() {
      if (compBox.dataset.loaded === item.code) return;   // 同一标的不重复加载
      compBox.dataset.loaded = item.code;
      compBox.innerHTML = '';
      compBox.append(skeleton({ style: 'min-height:420px' }));
      try {
        const comp = await loadJSON(COMPONENTS_URL);
        const data = (kinds[cfg.kind] === 'ETF' ? comp.by_etf : comp.by_index)[item.code] || null;
        compBox.innerHTML = '';
        if (!data || !data.n) {
          compBox.append(emptyState('暂无成分股数据', '该标的未收录于成分股精选池（指数/ETF成分股md）'));
          return;
        }
        const grid = el('div', { class: 'summary-grid' },
          el('div', { class: 'side-panel' },
            el('div', { class: 'card card-pad' },
              el('div', { class: 'card-title' }, '行业分布（' + data.n + ' 只）'),
              el('div', { class: 'mini-chart' }, ''))),
          el('div', { class: 'card table-card' }, el('div', { class: 'table-wrap', style: 'max-height:620px' }, '')));
        compBox.append(grid);
        const cnt = new Map();
        for (const s of data.stocks) cnt.set(s.ind || '未知', (cnt.get(s.ind || '未知') || 0) + 1);
        const donutData = [...cnt.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
        if (compDonut) { compDonut.dispose(); compDonut = null; }
        compDonut = createDonut(grid.querySelector('.mini-chart'), donutData, { title: '成分股行业分布', selectable: true });
        const compTableApi = renderTable(grid.querySelector('.table-card'), { columns: COMP_COLUMNS, rows: data.stocks, pageSize: 50 });
        /* 点击行业扇区 → 右侧表格筛选该行业；再点同一扇区 → 取消筛选 */
        let filterInd = null;
        const donutTitle = grid.querySelector('.card-title');
        compDonut.on('click', (p) => {
          if (!p || !p.name) return;
          if (filterInd === p.name) {
            filterInd = null;
            compTableApi.refresh(data.stocks);
            donutTitle.textContent = '行业分布（' + data.n + ' 只）';
          } else {
            filterInd = p.name;
            compTableApi.refresh(data.stocks.filter(s => (s.ind || '未知') === p.name));
            donutTitle.textContent = '行业分布 · 筛选：' + p.name + '（再点击取消）';
          }
        });
      } catch (err) {
        compBox.innerHTML = '';
        compBox.append(errorBox(`成分股数据加载失败：${err.message}`, () => { delete compBox.dataset.loaded; renderComponents(); }));
      }
    }

    /* ── 区间分析视图（S6）：仪表盘 + 因子明细表 + 三档切换（本地算分）── */
    const F_UNIT = { dy: '%', price: '', trend: '%', sent: '%', pe: '', pb: '', peg: '' };
    const bandOf = (s) => (s <= 25 ? '买入区间' : s <= 45 ? '逐步建仓' : s <= 65 ? '持有' : s <= 80 ? '逐步卖出' : '卖出区间');
    const bandCls = (b) => ({ '买入区间': 'band-buy', '逐步建仓': 'band-build', '持有': 'band-hold', '逐步卖出': 'band-sell', '卖出区间': 'band-sell2' }[b] || 'band-hold');
    async function renderAnalysis() {
      if (analysisBox.dataset.loaded === item.code) return;   // 同一标的不重复加载
      analysisBox.dataset.loaded = item.code;
      analysisBox.innerHTML = '';
      analysisBox.append(skeleton({ style: 'min-height:420px' }));
      try {
        const an = await loadAnalysis();
        const data = an.by_code[item.code] || null;
        analysisBox.innerHTML = '';
        if (!data) {
          analysisBox.append(emptyState('暂无区间分析', '该标的缺少股息率数据（成分股息率未收录），无法计算买卖区间'));
          return;
        }
        const sysKey = data.type === '股票' ? 'B' : 'A';
        const scoreOf = (pname) => {
          const w = an.presets[pname][sysKey];
          let s = 0, tot = 0;
          for (const k in w) {
            const f = data.factors[k];
            if (f && f.pct != null) { s += f.pct * w[k]; tot += w[k]; }
          }
          return tot ? s / tot : null;
        };
        const dash = el('div', { class: 'ana-dash' },
          el('div', { class: 'ana-card' },
            el('div', { class: 'ana-score-row' },
              el('span', { class: 'ana-score' }, '—'),
              el('span', { class: 'ana-band band-hold' }, '—')),
            el('div', { class: 'ana-preset' },
              ['稳健', '均衡', '进取'].map(p => el('button', { class: 'seg-btn' + (p === '均衡' ? ' active' : ''), onclick: () => { setPreset(p); } }, p))),
            el('div', { class: 'ana-dy' },
              el('span', {}, '股息率 ', el('b', {}, fmt2(data.factors.dy.v) + '%'), ' · 近5年分位 ', el('b', {}, fmt2(data.factors.dy.pct))),
              el('span', { class: 'txt-3' }, '分位为贵贱度：0=最便宜，100=最贵（股息率分位已反向）'))),
          el('div', { class: 'ana-card' },
            el('div', { class: 'ana-factors' }),
            el('div', { class: 'ana-tip' },
              '打分 = Σ(因子分位 × 权重) ÷ 权重和；≤25 买入 / ≤45 建仓 / ≤65 持有 / ≤80 止盈 / >80 卖出。',
              data.anchors ? ` 买入锚 ${fmt2(data.anchors.buy)}（${data.anchors.dist_buy >= 0 ? '+' : ''}${fmt2(data.anchors.dist_buy)}%）、卖出锚 ${fmt2(data.anchors.sell)}（${data.anchors.dist_sell >= 0 ? '+' : ''}${fmt2(data.anchors.dist_sell)}%）` : '')));
        const frowBox = dash.querySelector('.ana-factors');
        const scoreEl = dash.querySelector('.ana-score');
        const bandEl = dash.querySelector('.ana-band');
        const setPreset = (pname) => {
          const w = an.presets[pname][sysKey];
          for (const b of dash.querySelectorAll('.ana-preset .seg-btn')) b.classList.toggle('active', b.textContent === pname);
          const s = scoreOf(pname);
          const band = bandOf(s);
          scoreEl.textContent = fmt2(s);
          bandEl.textContent = band;
          bandEl.className = 'ana-band ' + bandCls(band);
          /* 因子行刷新（权重/得分随档位） */
          for (const k in w) {
            const f = data.factors[k];
            if (!f) continue;
            const row = frowBox.querySelector(`[data-k="${k}"]`);
            if (!row) continue;
            row.querySelector('.ana-fw').textContent = w[k] + '%';
            row.querySelector('.ana-fscore').textContent = f.pct == null ? '—' : fmt2(f.pct * w[k] / 100);
          }
        };
        /* 因子明细表 */
        const order = sysKey === 'B' ? ['pe', 'pb', 'dy', 'price', 'trend', 'peg'] : ['dy', 'price', 'trend', 'sent'];
        for (const k of order) {
          const f = data.factors[k];
          if (!f) continue;
          const w0 = an.presets['均衡'][sysKey];
          const row = el('div', { class: 'ana-frow', 'data-k': k },
            el('span', { class: 'ana-fname' }, f.name),
            el('span', { class: 'ana-fval' }, f.v == null ? '—' : fmt2(f.v) + (F_UNIT[k] || '')),
            el('div', { class: 'ana-bar' }, el('i', { style: 'width:' + (f.pct == null ? 0 : f.pct) + '%' })),
            el('span', { class: 'ana-fpct' }, f.pct == null ? '—' : fmt2(f.pct)),
            el('span', { class: 'ana-fw' }, w0[k] + '%'),
            el('span', { class: 'ana-fscore' }, f.pct == null ? '—' : fmt2(f.pct * w0[k] / 100)));
          frowBox.append(row);
        }
        analysisBox.append(dash);
        setPreset('均衡');
      } catch (err) {
        analysisBox.innerHTML = '';
        analysisBox.append(errorBox(`区间分析加载失败：${err.message}`, () => { delete analysisBox.dataset.loaded; renderAnalysis(); }));
      }
    }

    const tableApi = renderTable(tableBox, { columns: cfg.columns, rows: rowsTable, pageSize: 50 });
    tableApi.sortBy('日期', -1); // 默认最新在上

    /* 预设范围按钮组 */
    function rangeGroup() {
      const ranges = [['all', '全部'], ['5y', '5年'], ['3y', '3年'], ['1y', '1年']];
      const g = el('div', { class: 'seg-group', role: 'group', 'aria-label': '时间范围' });
      const btns = [];
      for (const [key, label] of ranges) {
        const b = el('button', { class: 'seg-btn' + (state.range === key ? ' active' : ''), onclick: () => {
          chartApi.setRange(key);   /* dataZoom 事件 → onZoom 回调统一按可见窗口刷新锚/分位线 */
        } }, label);
        btns.push([key, b]);
        g.append(b);
      }
      const setActive = (key) => {
        state.range = key;
        for (const [k, b] of btns) b.classList.toggle('active', k === key);
      };
      return { el: g, setActive };
    }

    /* 自定义日期范围：手动文本输入 + 日历弹窗选择（超范围禁用） */
    function dateRangeGroup() {
      const minD = k.dates[0], maxD = k.dates[n - 1];
      const fromInput = el('input', { type: 'text', class: 'dr-from', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': '起始日期（YYYY-MM-DD）', placeholder: 'YYYY-MM-DD' });
      const toInput = el('input', { type: 'text', class: 'dr-to', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': '结束日期（YYYY-MM-DD）', placeholder: 'YYYY-MM-DD' });
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const apply = () => {
        let f = fromInput.value.trim(), t = toInput.value.trim();
        const okF = !f || DATE_RE.test(f);
        const okT = !t || DATE_RE.test(t);
        fromInput.classList.toggle('invalid', !okF);
        toInput.classList.toggle('invalid', !okT);
        if (!okF || !okT) return; // 格式非法：红框提示，不应用
        // 越界钳制到数据上下限
        if (f && f < minD) { f = minD; fromInput.value = f; }
        if (f && f > maxD) { f = maxD; fromInput.value = f; }
        if (t && t > maxD) { t = maxD; toInput.value = t; }
        if (t && t < minD) { t = minD; toInput.value = t; }
        // 起 > 止自动交换
        if (f && t && f > t) { [f, t] = [t, f]; fromInput.value = f; toInput.value = t; }
        chartApi.setDateRange(f || null, t || null);
      };
      const fromWrap = attachDatePicker(fromInput, { min: minD, max: maxD, onPick: apply });
      const toWrap = attachDatePicker(toInput, { min: minD, max: maxD, onPick: apply });
      const box = el('div', { class: 'date-range' },
        el('span', { class: 'dr-label' }, '从'), fromWrap.wrap,
        el('span', { class: 'dr-label' }, '至'), toWrap.wrap);

      fromInput.addEventListener('change', apply);
      toInput.addEventListener('change', apply);
      for (const inp of [fromInput, toInput]) {
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); } });
        inp.addEventListener('focus', () => inp.classList.remove('invalid'));
      }

      /* 预设范围对应的起始百分比（用于判断按钮高亮） */
      const presetStartPct = (key) => {
        if (key === 'all') return 0;
        const years = { '5y': 5, '3y': 3, '1y': 1 }[key];
        const bound = new Date(k.dates[n - 1] + 'T00:00:00');
        bound.setFullYear(bound.getFullYear() - years);
        const bs = bound.toISOString().slice(0, 10);
        for (let i = 0; i < n; i++) if (k.dates[i] >= bs) return i / (n - 1) * 100;
        return 0;
      };

      /* slider 拖动 / 预设 / 日期输入 → 统一同步输入框与按钮状态 */
      const sync = (start, end) => {
        const si = Math.max(0, Math.min(n - 1, Math.round(start / 100 * (n - 1))));
        const ei = Math.max(0, Math.min(n - 1, Math.round(end / 100 * (n - 1))));
        // 正在手动输入时不被 slider 联动打断
        if (document.activeElement !== fromInput && document.activeElement !== toInput) {
          fromInput.value = k.dates[si];
          toInput.value = k.dates[ei];
        }
        let match = null;
        if (end >= 99.5) {
          if (start <= 0.5) match = 'all';
          else for (const key of ['5y', '3y', '1y']) if (Math.abs(start - presetStartPct(key)) < 0.5) { match = key; break; }
        }
        rangeApi.setActive(match || '');
      };
      chartApi.onZoom(sync);
      // 初始化：同步当前范围（首次进入默认全部）
      const z0 = chartApi.chart.getOption().dataZoom[0];
      sync(z0.start ?? 0, z0.end ?? 100);
      return { el: box };
    }

    /* 副图控制（仅股票指标） */
    function subControlGroup() {
      if (cfg.subControl !== 'indicator') return null;
      if (!ind) return el('span', { class: 'txt-3', style: 'font-size:12px' }, '指标数据缺失（请运行 python scripts/_gen_web_data.py）');
      const g = el('div', { class: 'seg-group', role: 'group', 'aria-label': '指标副图' });
      cfg.indicatorOptions.forEach((opt, i) => {
        const b = el('button', { class: 'seg-btn' + (i === 0 ? ' active' : ''), onclick: () => {
          g.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          chartApi.setSubSeries([{ name: opt.label, data: ind.map(x => x[opt.key] ?? null), color: opt.color, unit: opt.unit }]);
        } }, opt.label);
        g.append(b);
      });
      return g;
    }
  }

  return { dispose: () => { if (state.chart) state.chart.dispose(); } };
}
