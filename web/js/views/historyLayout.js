/* 历史行情视图共享布局（指数/ETF/股票三视图复用）
   结构：左列标的列表 + 右主区（报价头 + K线图 + 副图 + 数据表格）
   性能：列表信息来自 manifest（含最新价/涨跌），K线与指标在选中标的后按需加载（单文件），
         内存缓存保证切换秒开 */

import { el, renderTickerList, renderTable, skeleton, errorBox, emptyState, fmt2, fmtPct, dirOf, dailyChg, attachDatePicker } from './common.js';
import { loadJSON, klineUrl, indiUrl } from '../data.js';
import { createKlineChart } from '../charts.js';

const D = { volume: 1e4, amount: 1e8 };  // 默认除数：ETF/股票（腾讯源）手→万手、元→亿元

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
   *   chartUnit, subControl, indicatorOptions,
   *   quoteExtra(obj, rows), itemSub(obj, rows),    // 可选兜底
   *   chartNote(obj, rows), columns, buildTableRows(rows, k, ind),
   * } */
  const kinds = { index: '指数', etf: 'ETF', stock: '股票' };

  const layout = el('div', { class: 'view-layout' },
    el('aside', { class: 'ticker-panel card' },
      el('div', { class: 'card-title', style: 'margin:12px 14px 4px' }, cfg.title + '（' + cfg.items.length + '）')),
    el('section', { class: 'main-panel' },
      el('div', { class: 'card main-card' }, emptyState('选择左侧标的', '点击列表中的标的查看历史行情'))));
  container.append(layout);

  let state = { code: null, chart: null, range: 'all' };
  const panel = layout.querySelector('.ticker-panel');
  const mainCard = layout.querySelector('.main-card');

  const listApi = renderTickerList(panel, cfg.items, {
    onSelect: (it) => select(it),
    activeCode: state.code,
    searchable: true,
  });

  // 默认选中第一只（立即渲染图表）
  if (cfg.items.length) select(cfg.items[0]);

  /* ── 选中标的 → 按需加载 K线（+副图数据） → 图表 + 表格 ── */
  async function select(item) {
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

    const rowsTable = cfg.buildTableRows(rows, k, ind);
    const tableBox = el('div', {});
    const note = el('div', { class: 'chart-note' }, cfg.chartNote(obj, rows));

    // ⚠️ 必须先挂载到 DOM 再初始化 ECharts：容器未挂载时尺寸为 0，canvas 缓冲为 0×0 会空白
    mainCard.append(chartBox, tableBox, note);

    if (state.chart) { state.chart.dispose(); }
    const chartApi = createKlineChart(chartBox.querySelector('.chart'), {
      dates: k.dates, klines: k.klines, volumes: k.volumes, amounts: k.amounts, chgN: k.chgN,
      unit, subUnit: subDefs?.[0]?.unit || '',
      mode: cfg.chartType || 'candlestick',
      showMA: cfg.showMA !== false,   // 默认开 MA；ETF 视图关
      overlay: cfg.overlay ? cfg.overlay(rows, ind) : null,   // 主图右轴叠加（ETF 净值 / 股票指标曲线）
    });
    state.chart = chartApi;
    if (subDefs) chartApi.setSubSeries(subDefs);

    /* 预设时间范围按钮（点击 → setRange → datazoom 事件 → onZoom 联动 UI） */
    const rangeApi = rangeGroup();
    /* 自定义起止日期：手动文本输入（YYYY-MM-DD），旁显上下限 */
    const dateRangeApi = dateRangeGroup();

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
        cfg.subControl !== 'none' ? subControlGroup() : null));
    mainCard.prepend(head);

    const tableApi = renderTable(tableBox, { columns: cfg.columns, rows: rowsTable, pageSize: 50 });
    tableApi.sortBy('日期', -1); // 默认最新在上

    /* 预设范围按钮组 */
    function rangeGroup() {
      const ranges = [['all', '全部'], ['5y', '5年'], ['3y', '3年'], ['1y', '1年']];
      const g = el('div', { class: 'seg-group', role: 'group', 'aria-label': '时间范围' });
      const btns = [];
      for (const [key, label] of ranges) {
        const b = el('button', { class: 'seg-btn' + (state.range === key ? ' active' : ''), onclick: () => chartApi.setRange(key) }, label);
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
