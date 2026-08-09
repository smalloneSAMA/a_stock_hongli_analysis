/* ECharts 工厂：行情图（K线或收盘折线+成交量）、环形图、条形图
   A股习惯：红涨绿跌 */
import { cssVar } from './theme.js';

const C = {
  up: cssVar('--up'), down: cssVar('--down'),
  ma5: cssVar('--brand'), ma20: cssVar('--accent'), ma60: '#A78BFA', ma250: '#60A5FA',
  volUp: cssVar('--up-bg'), volDown: cssVar('--down-bg'),
  axis: cssVar('--text-3'), split: cssVar('--grid-line'), text2: cssVar('--text-2'), text3: cssVar('--text-3'),
  accent: cssVar('--accent'), brand: cssVar('--brand'), indigo: cssVar('--indigo'),
};

const MA_STYLE = { type: 'line', smooth: true, symbol: 'none', sampling: 'lttb', lineStyle: { width: 1.2 }, z: 6 };

/* 移动平均（前 n-1 位为 null） */
function ma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] || 0;
    if (i >= n) sum -= arr[i - n] || 0;
    if (i >= n - 1) out[i] = +(sum / n).toFixed(2);
  }
  return out;
}

/* 日涨跌幅 */
function chgArr(klines) {
  return klines.map((k, i) => i === 0 ? null : (k[1] - klines[i - 1][1]) / klines[i - 1][1] * 100);
}

/**
 * 行情图
 * opts: { dates, klines:[[o,c,l,h]...], volumes, unit('点'|'元'), subUnit,
 *         mode: 'candlestick'（K线+MA+成交量+可切换副图，默认）| 'line'（收盘折线+成交量） }
 * 返回 { chart, setRange(range), setSubSeries(defs|null), dispose }
 */
export function createKlineChart(el, opts) {
  const { dates, klines, volumes, amounts = [], chgN = [], indData = null, unit = '', subUnit = '', mode = 'candlestick', showMA = true, showOHLC = true } = opts;
  const maCount = showMA ? 4 : 0;   // MA5/MA20/MA60/MA250 数量（函数级作用域：setSubSeries 需要访问）
  const overlay = opts.overlay || [];
  const chg = chgArr(klines);
  const closes = klines.map(k => k[1]);
  /* 均线预计算缓存（tooltip 高频调用查表 O(1)，避免每次全量重算） */
  const maCache = { 5: ma(closes, 5), 20: ma(closes, 20), 60: ma(closes, 60), 250: ma(closes, 250) };
  const MA_DEFS = [['MA5', 5, C.ma5], ['MA20', 20, C.ma20], ['MA60', 60, C.ma60], ['MA250', 250, C.ma250]];

  const axisBase = {
    axisLine: { lineStyle: { color: 'rgba(51,65,85,0.6)' } },
    axisTick: { show: false },
    axisLabel: { color: C.text3, fontSize: 10.5, hideOverlap: true },
    min: 'dataMin', max: 'dataMax',
  };

  const tooltipBase = {
    trigger: 'axis', axisPointer: { type: 'cross' },
    backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border-strong'), borderWidth: 1,
    padding: [10, 14], textStyle: { color: cssVar('--text'), fontSize: 12 },
  };

  /* 浮动面板行：一行一个字段（字段名左对齐、值右对齐） */
  const tipRow = (k, v, color) =>
    '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.9;white-space:nowrap">'
    + `<span style="color:#94A3B8">${k}</span>`
    + `<b style="font-weight:600;color:${color || cssVar('--text')}">${v}</b></div>`;

  const dataZoomBase = [
    // slider 拖拉条（index 0，zoomDispatch 依赖）
    { type: 'slider', bottom: 2, height: 16, borderColor: cssVar('--border-strong'), backgroundColor: cssVar('--input-bg'), fillerColor: cssVar('--brand-dim'), handleStyle: { color: C.brand }, moveHandleStyle: { color: C.brand }, textStyle: { color: C.text3, fontSize: 9 }, dataBackground: { lineStyle: { color: cssVar('--border-strong') }, areaStyle: { color: cssVar('--row-line') } }, minValueSpan: 20 },
    // 鼠标按住左右拖动平移（滚轮缩放按用户要求保持关闭）
    { type: 'inside', zoomOnMouseWheel: false, moveOnMouseMove: true, moveOnMouseWheel: false, preventDefaultMouseMove: true, minValueSpan: 20 },
  ];

  const zoomDispatch = (start, end) => {
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start, end });
  };

  const idxOfDate = (ds) => {
    for (let i = 0; i < dates.length; i++) if (dates[i] >= ds) return i;
    return dates.length - 1;
  };

  /* 时间范围：all | 5y | 3y | 1y */
  function setRange(range) {
    const n = dates.length;
    let start = 0, end = 100;
    const today = new Date(dates[n - 1] + 'T00:00:00');
    const years = { '1y': 1, '3y': 3, '5y': 5 }[range];
    if (years) {
      const bound = new Date(today);
      bound.setFullYear(bound.getFullYear() - years);
      const bs = bound.toISOString().slice(0, 10);
      let idx = n - 1;
      for (let i = 0; i < n; i++) { if (dates[i] >= bs) { idx = i; break; } }
      start = idx / (n - 1) * 100;
      end = 100;
    }
    zoomDispatch(start, end);
  }

  /* 自定义起止日期（YYYY-MM-DD，可空） */
  function setDateRange(startDate, endDate) {
    const n = dates.length;
    let si = 0, ei = n - 1;
    if (startDate) si = idxOfDate(startDate);
    if (endDate) {
      for (let i = n - 1; i >= 0; i--) { if (dates[i] <= endDate) { ei = i; break; } }
    }
    if (si > ei) return;
    zoomDispatch(si / (n - 1) * 100, ei / (n - 1) * 100);
  }

  /* 当前 dataZoom 可见窗口（百分比 0-100） */
  function getZoom() {
    const z = chart.getOption().dataZoom[0] || {};
    return { start: z.start ?? 0, end: z.end ?? 100 };
  }

  /* slider 拖动/范围变更回调：cb(startPct, endPct)；返回取消函数
     多 dataZoom 实例（slider+inside）时事件参数在 batch 数组里，取 slider(index 0) 的值 */
  let zoomCbs = [];
  const onZoomHandler = (p) => {
    const items = Array.isArray(p.batch) && p.batch.length ? p.batch : [p];
    const it = items.find((x) => x.dataZoomIndex === 0) || items[0];
    if (it && typeof it.start === 'number') {
      for (const cb of zoomCbs) cb(it.start, it.end);
    }
  };
  function onZoom(cb) {
    zoomCbs.push(cb);
    return () => { zoomCbs = zoomCbs.filter((x) => x !== cb); };
  }

  /* ── line 模式：收盘折线 + 成交量 ── */
  let option;
  /* S7 区间锚线（买入红/卖出绿虚线），line/candlestick 共用 */
  const anchorLines = opts.anchorLines || [];
  if (mode === 'line') {
    const xAxisIndex = [0, 1];
    option = {
      animationDuration: 420,
      animationDurationUpdate: 0,   // dataZoom 拖动时不播放过渡动画（防卡顿）
      animationEasing: 'cubicOut',
      backgroundColor: 'transparent',
      textStyle: { fontFamily: "'Fira Code','Consolas',monospace", color: C.text2 },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: cssVar('--surface-3') } },
      tooltip: {
        ...tooltipBase,
        formatter(params) {
          const i = params[0].dataIndex;
          const c = chg[i];
          const rows = [
            `<div style="font-weight:700;font-size:12.5px;margin-bottom:5px">${dates[i]}</div>`,
            '<div style="border-top:1px solid #334155;margin-bottom:4px"></div>',
            tipRow('收盘', `${closes[i].toFixed(2)} ${unit}`),
            tipRow('涨跌', c == null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%', c == null ? C.text2 : (c >= 0 ? C.up : C.down)),
            tipRow('MA60', maCache[60][i] == null ? '—' : maCache[60][i].toFixed(2), C.ma60),
            tipRow('MA250', maCache[250][i] == null ? '—' : maCache[250][i].toFixed(2), C.ma250),
          ];
          if (volumes[i] != null) rows.push(tipRow('成交量', volumes[i].toFixed(0) + ' 万手'));
          rows.push(tipRow('成交额', amounts[i] == null ? '—' : amounts[i].toFixed(2) + ' 亿元'));
          // N 交易日涨跌幅（缓存行 chg30/chg60/chg90，存在才显示；交易日口径）
          if (chgN.length) {
            const nDays = [30, 60, 90];
            for (let k = 0; k < chgN.length; k++) {
              const v = chgN[k][i];
              if (v != null) rows.push(tipRow(nDays[k] + '日涨跌', (v >= 0 ? '+' : '') + v.toFixed(2) + '%', v >= 0 ? C.up : C.down));
            }
          }
          return rows.join('');
        },
      },
      grid: [
        { left: 62, right: 108, top: 30, height: '58%' },
        { left: 62, right: 108, top: '74%', height: '12%' },
      ],
      xAxis: xAxisIndex.map((g) => ({ type: 'category', data: dates, gridIndex: g, boundaryGap: true, ...axisBase, axisLabel: { ...axisBase.axisLabel, show: g === 1 }, splitLine: { show: false } })),
      yAxis: [
        { gridIndex: 0, scale: true, position: 'left', axisLabel: { color: C.text3, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.split } }, axisLine: { show: false }, axisTick: { show: false }, name: unit, nameTextStyle: { color: C.text3, fontSize: 10, padding: [0, 0, 0, 28] } },
        { gridIndex: 1, scale: true, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } },
      ],
      dataZoom: dataZoomBase.map((z, i) => ({ ...z, xAxisIndex: xAxisIndex })),
      series: [
        {
          name: '收盘', type: 'line', data: closes, symbol: 'none', smooth: true, sampling: 'lttb', z: 6,
          lineStyle: { color: C.brand, width: 1.6 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(251,191,36,0.20)' },
              { offset: 1, color: 'rgba(251,191,36,0.01)' },
            ]),
          },
          ...(anchorLines.length ? {
            markLine: {
              silent: true, symbol: 'none', z: 7,
              label: { position: 'end', fontSize: 11.5, fontWeight: 700, backgroundColor: cssVar('--tooltip-bg'), borderWidth: 1, borderRadius: 4, padding: [3, 6], formatter: (p) => p.name },
              data: anchorLines.map(a => ({
                yAxis: a.value, name: a.label,
                lineStyle: { color: a.color, type: 'dashed', width: 1 },
                label: { color: a.color, borderColor: a.color },
              })),
            },
          } : {}),
        },
        { name: 'MA60', ...MA_STYLE, data: maCache[60], lineStyle: { ...MA_STYLE.lineStyle, color: C.ma60 } },
        { name: 'MA250', ...MA_STYLE, data: maCache[250], lineStyle: { ...MA_STYLE.lineStyle, color: C.ma250 } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes, barMaxWidth: 5, sampling: 'lttb', itemStyle: { color: 'rgba(251,191,36,0.30)' } },
      ],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['收盘', 'MA60', 'MA250', '成交量'], selected: { MA60: false, MA250: false } },
    };
  } else {
    /* ── candlestick 模式：K线 + MA(可关) + 成交量 + 副图（默认）；支持主图右轴叠加 overlay 折线（净值） ── */
    const overlaySeries = overlay.map((d, i) => ({
      name: d.name, type: 'line', xAxisIndex: 0, yAxisIndex: 3, data: d.data,
      symbol: 'none', smooth: true, connectNulls: false, sampling: 'lttb', z: 9,
      lineStyle: { width: i === 0 ? 1.6 : 1.2, color: d.color, type: d.dash ? 'dashed' : 'solid' },
      itemStyle: { color: d.color },
    }));
    option = {
      animationDuration: 420,
      animationDurationUpdate: 0,   // dataZoom 拖动时不播放过渡动画（防卡顿）
      animationEasing: 'cubicOut',
      backgroundColor: 'transparent',
      textStyle: { fontFamily: "'Fira Code','Consolas',monospace", color: C.text2 },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: cssVar('--surface-3') } },
      tooltip: {
        ...tooltipBase,
        formatter(params) {
          const i = params[0].dataIndex;
          const k = klines[i];
          const d = dates[i];
          const c = chg[i];
          const rows = [
            `<div style="font-weight:700;font-size:12.5px;margin-bottom:5px">${d}</div>`,
            '<div style="border-top:1px solid #334155;margin-bottom:4px"></div>',
          ];
          if (showOHLC) rows.push(tipRow('开盘', k[0].toFixed(2)));
          rows.push(tipRow('收盘', k[1].toFixed(2)));
          if (showOHLC) {
            rows.push(tipRow('最高', k[3].toFixed(2)));
            rows.push(tipRow('最低', k[2].toFixed(2)));
          }
          rows.push(tipRow('涨跌', c == null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%', c == null ? C.text2 : (c >= 0 ? C.up : C.down)));
          // 均线固定行（默认不画线也显示数值；null → —）
          if (maCount) {
            for (const [k, n, color] of MA_DEFS) {
              const v = maCache[n][i];
              rows.push(tipRow(k, v == null ? '—' : v.toFixed(2), color));
            }
          }
          if (volumes[i] != null) rows.push(tipRow('成交量', volumes[i].toFixed(0) + ' 万手'));
          rows.push(tipRow('成交额', amounts[i] == null ? '—' : amounts[i].toFixed(2) + ' 亿元'));
          // N 交易日涨跌幅（缓存行 chg30/chg60/chg90，存在才显示；交易日口径）
          if (chgN.length) {
            const nDays = [30, 60, 90];
            for (let k = 0; k < chgN.length; k++) {
              const v = chgN[k][i];
              if (v != null) rows.push(tipRow(nDays[k] + '日涨跌', (v >= 0 ? '+' : '') + v.toFixed(2) + '%', v >= 0 ? C.up : C.down));
            }
          }
          // 估值/盈利指标（股票 indData，存在才显示）
          if (indData && indData[i]) {
            const x = indData[i];
            const defs = [
              ['PE-TTM', x.pe_ttm, ' 倍'], ['PE动', x.pe_dyn, ' 倍'], ['PB', x.pb, ' 倍'],
              ['PEG', x.peg, ''], ['ROE', x.roe, '%'], ['ROA', x.roa, '%'],
            ];
            for (const [k, v, u] of defs) {
              if (v != null) rows.push(tipRow(k, v.toFixed(2) + u));
            }
          }
          for (const p of params) {
            if (p.seriesType !== 'candlestick' && p.seriesType !== 'bar') {
              if (p.seriesName.startsWith('MA')) continue;   // 均线已在固定字段行显示，避免重复
              if (indData && ['PE-TTM', 'PE(动)', 'PB', 'PEG', 'ROE', 'ROA'].includes(p.seriesName)) continue;   // 指标曲线已在固定字段行显示，避免重复
              rows.push(tipRow(`${p.marker} ${p.seriesName}`, p.value == null ? '—' : Number(p.value).toFixed(2)));
            }
          }
          return rows.join('');
        },
      },
      grid: [
        { left: 62, right: 108, top: 30, height: '62%' },
        { left: 62, right: 108, top: '76%', height: '9%' },
        { left: 62, right: 108, top: '76%', height: '12%', show: false },
      ],
      xAxis: [0, 1, 2].map((g) => ({ type: 'category', data: dates, gridIndex: g, boundaryGap: true, ...axisBase, axisLabel: { ...axisBase.axisLabel, show: g === 1 }, splitLine: { show: false } })),
      yAxis: [
        { gridIndex: 0, scale: true, position: 'left', axisLabel: { color: C.text3, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.split } }, axisLine: { show: false }, axisTick: { show: false }, name: unit, nameTextStyle: { color: C.text3, fontSize: 10, padding: [0, 0, 0, 28] } },
        { gridIndex: 1, scale: true, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } },
        { gridIndex: 2, scale: true, splitNumber: 2, axisLabel: { color: C.text3, fontSize: 10, formatter: (v) => Number(v).toFixed(1) }, splitLine: { lineStyle: { color: C.split, type: 'dashed' } }, axisLine: { show: false }, name: subUnit, nameTextStyle: { color: C.text3, fontSize: 10, padding: [0, 0, 0, 20] } },
        // 主图右轴：叠加折线（单位净值/累计净值）专用
        ...(overlay.length ? [{ gridIndex: 0, position: 'right', scale: true, splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.text3, fontSize: 10 }, name: '净值(元)', nameTextStyle: { color: C.text3, fontSize: 10, padding: [0, 22, 0, 0] } }] : []),
      ],
      dataZoom: dataZoomBase.map((z, i) => ({ ...z, xAxisIndex: [0, 1, 2] })),
      series: [
        {
          name: 'K线', type: 'candlestick', data: klines, sampling: 'lttb',
          itemStyle: {
            color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down,
            borderWidth: 1,
          },
          ...(anchorLines.length ? {
            markLine: {
              silent: true, symbol: 'none', z: 7,
              label: { position: 'end', fontSize: 11.5, fontWeight: 700, backgroundColor: cssVar('--tooltip-bg'), borderWidth: 1, borderRadius: 4, padding: [3, 6], formatter: (p) => p.name },
              data: anchorLines.map(a => ({
                yAxis: a.value, name: a.label,
                lineStyle: { color: a.color, type: 'dashed', width: 1 },
                label: { color: a.color, borderColor: a.color },
              })),
            },
          } : {}),
        },
        ...(maCount ? [
          { name: 'MA5', ...MA_STYLE, data: ma(closes, 5), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma5 } },
          { name: 'MA20', ...MA_STYLE, data: ma(closes, 20), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma20 } },
          { name: 'MA60', ...MA_STYLE, data: ma(closes, 60), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma60 } },
          { name: 'MA250', ...MA_STYLE, data: ma(closes, 250), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma250 } },
        ] : []),
        {
          name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes,
          itemStyle: { color: (p) => (klines[p.dataIndex][1] >= klines[p.dataIndex][0] ? C.volUp : C.volDown) },
          barMaxWidth: 5, sampling: 'lttb',
        },
        ...overlaySeries,
      ],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['K线', ...(maCount ? ['MA5', 'MA20', 'MA60', 'MA250'] : []), ...overlay.map(d => d.name)], selected: { ...Object.fromEntries(overlay.map(d => [d.name, d.visible !== false])), ...(maCount ? { MA5: false, MA20: false, MA60: false, MA250: false } : {}) } },
    };
  }

  const chart = echarts.init(el, null, { renderer: 'canvas' });
  chart.setOption(option);
  chart.on('datazoom', onZoomHandler);

  /* ── 键盘 ←/→ 移动光标（十字线+浮动面板跟随；移出可视窗口时自动平移窗口）──
     · 首次按键：从鼠标 hover 位置开始（无 hover 时从最新日期）
     · 左键点击图表任意位置：光标立即锚定到该日期，方向键从锚定点开始移动 */
  let keyIdx = -1;
  let mouseIdx = -1;   // 鼠标 hover 的日期索引（键盘未启动时更新）
  const n = dates.length;
  const pixelToIdx = (px, py) => {
    const r = chart.convertFromPixel({ seriesIndex: 0 }, [px, py]);
    if (r && Array.isArray(r) && typeof r[0] === 'number') {
      return Math.max(0, Math.min(n - 1, Math.round(r[0])));
    }
    return -1;
  };

  /* ── 左上角浮层：光标日期 → 最新日期的累计涨幅（跟随鼠标/键盘/点击）── */
  if (!el.style.position || el.style.position === 'static') el.style.position = 'relative';
  const floatEl = document.createElement('div');
  floatEl.style.cssText = "position:absolute;top:28px;left:64px;z-index:6;pointer-events:none;display:none;background:" + cssVar('--tooltip-bg') + ";border:1px solid " + cssVar('--border-strong') + ";border-radius:8px;padding:6px 10px;font-family:'Fira Code',monospace;line-height:1.55";
  el.appendChild(floatEl);
  let lastFloatIdx = -2;
  const updateFloating = (i) => {
    if (i === lastFloatIdx) return;   // 无变化不重绘（mousemove 高频调用）
    lastFloatIdx = i;
    if (i < 0 || i >= n || closes[i] == null || closes[n - 1] == null) { floatEl.style.display = 'none'; return; }
    const chg = (closes[n - 1] / closes[i] - 1) * 100;
    const c = chg >= 0 ? C.up : C.down;
    floatEl.innerHTML =
      '<div style="font-size:10px;color:#94A3B8">' + dates[i] + ' → ' + dates[n - 1] + '</div>'
      + '<div style="font-size:13px;font-weight:700;color:' + c + '">累计 ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div>';
    floatEl.style.display = 'block';
  };

  chart.getZr().on('mousemove', (e) => {
    const i = pixelToIdx(e.offsetX, e.offsetY);
    if (i >= 0) {
      updateFloating(i);
      if (keyIdx < 0) mouseIdx = i;   // 键盘尚未开始移动时，跟随鼠标 hover（移动中不打断，防鼠标抖动）
    }
  });
  chart.getZr().on('mouseout', () => updateFloating(-1));   // 鼠标移出图表隐藏浮层
  chart.getZr().on('click', (e) => {
    const i = pixelToIdx(e.offsetX, e.offsetY);
    if (i >= 0) { keyIdx = i; chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i }); updateFloating(i); }   // 点击锚定：光标立即显示在该日期
  });
  const kbdMove = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!el.offsetWidth || !el.offsetHeight) return;   // 隐藏视图中的图表不响应键盘（视图常驻后存在多个图表实例）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;   // 输入框聚焦时不干扰
    e.preventDefault();
    if (!n) return;
    if (keyIdx < 0) keyIdx = mouseIdx >= 0 ? mouseIdx : n - 1;   // 从鼠标所在日期开始，无鼠标位置时从最新日期
    const next = e.key === 'ArrowRight' ? keyIdx + 1 : keyIdx - 1;
    if (next < 0 || next >= n) return;
    keyIdx = next;
    updateFloating(keyIdx);   // 键盘移动同步左上角累计涨幅
    const z = chart.getOption().dataZoom[0] || {};
    const s = Math.round((z.start ?? 0) / 100 * (n - 1));
    const en = Math.round((z.end ?? 100) / 100 * (n - 1));
    const span = Math.max(1, en - s);
    let dz = null;
    if (next > en) dz = { startValue: dates[next - span], endValue: dates[next] };
    else if (next < s) dz = { startValue: dates[next], endValue: dates[Math.min(n - 1, next + span)] };
    if (dz) chart.dispatchAction({ type: 'dataZoom', ...dz });
    chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: keyIdx });
  };
  window.addEventListener('keydown', kbdMove);

  // 兜底：若容器尚未布局（宽高为 0，如隐藏/未挂载），下一帧校准一次，避免空白
  if (!el.clientWidth || !el.clientHeight) {
    requestAnimationFrame(() => { chart.resize(); });
  }

  /* 副图（指标/净值/股息率）：line 与 candlestick 模式均支持。defs 支持 markLines（分位线） */
  function setSubSeries(defs) {
    const series = defs ? defs.map((d, i) => ({
      name: d.name, type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: d.data,
      symbol: 'none', smooth: true, connectNulls: false, sampling: 'lttb', z: 8,
      lineStyle: { width: i === 0 ? 1.8 : 1.3, color: d.color }, itemStyle: { color: d.color },
      ...(d.markLines ? {
        markLine: {
          silent: true, symbol: 'none',
          label: { position: 'end', fontSize: 11, fontWeight: 700, backgroundColor: cssVar('--tooltip-bg'), borderWidth: 1, borderRadius: 4, padding: [2, 5], formatter: (p) => p.name },
          data: d.markLines.map(m => ({
            yAxis: m.value, name: m.label,
            lineStyle: { color: m.color, type: 'dashed', width: 1 },
            label: { color: m.color, borderColor: m.color },
          })),
        },
      } : {}),
    })) : [];
    const volSeries = option.series[1];   // 初始 series[1]：candlestick=成交量；line 模式在下方按名字从 cur 找（初始顺序会随 MA 数量变化）
    if (mode === 'line') {
      const cur = chart.getOption();   // 取当前主系列（含 addAnchorLines 合并的 markLine）
      const maSeries = maCount ? cur.series.filter(s => s.name === 'MA60' || s.name === 'MA250') : [];   // 重建时保留均线系列
      const volLine = cur.series.find(s => s.name === '成交量') || volSeries;   // 按名字定位成交量（初始顺序会变）
      chart.setOption({
        grid: [
          { left: 62, right: 108, top: 30, height: defs ? '48%' : '58%', show: true },
          { left: 62, right: 108, top: defs ? '62%' : '74%', height: '12%', show: true },
          { left: 62, right: 108, top: '76%', height: '12%', show: !!defs },
        ],
        xAxis: [
          { gridIndex: 0, axisLabel: { show: false } },
          { gridIndex: 1, axisLabel: { show: defs ? false : true } },
          {
            gridIndex: 2, type: 'category', data: dates, boundaryGap: true,
            axisLine: { lineStyle: { color: 'rgba(51,65,85,0.6)' } },
            axisTick: { show: false },
            axisLabel: { color: C.text3, fontSize: 10.5, hideOverlap: true, show: !!defs },
            splitLine: { show: false },
          },
        ],
        yAxis: [
          { gridIndex: 0 },
          { gridIndex: 1 },
          {
            gridIndex: 2, scale: true, splitNumber: 2,
            axisLabel: { color: C.text3, fontSize: 10, formatter: (v) => Number(v).toFixed(1) },
            splitLine: { lineStyle: { color: C.split, type: 'dashed' } },
            axisLine: { show: false },
            name: defs && defs[0] ? defs[0].unit || '' : '',
            nameTextStyle: { color: C.text3, fontSize: 10, padding: [0, 0, 0, 20] },
          },
        ],
        dataZoom: option.dataZoom.map((z) => ({ ...z, xAxisIndex: [0, 1, 2] })),
        legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['收盘', ...(maCount ? ['MA60', 'MA250'] : []), '成交量', ...(defs ? defs.map(d => d.name) : [])], ...(cur.legend?.[0]?.selected ? { selected: cur.legend[0].selected } : {}) },
        series: [cur.series[0], ...maSeries, volLine, ...series],
      }, { replaceMerge: ['series', 'legend'] });
      return;
    }
    if (mode !== 'candlestick') return;
    // 主图系列：K线 + MA（若有）+ 成交量；成交量位置随 maCount 偏移
    const cur = chart.getOption();   // 取当前主系列（含 addAnchorLines 合并的 markLine）
    const mainSeries = cur.series[0];
    const maSeries = maCount ? cur.series.slice(1, 1 + maCount) : [];
    const volSeries2 = cur.series[1 + maCount];
    // 主图右轴 overlay 系列（股票指标曲线，yAxisIndex 3）必须保留，否则被 replaceMerge 丢弃
    const overlayPart = cur.series.filter(s => s.yAxisIndex === 3);
    chart.setOption({
      grid: [
        { left: 62, right: 108, top: 30, height: defs ? '48%' : '62%', show: true },
        { left: 62, right: 108, top: defs ? '62%' : '76%', height: '9%', show: true },
        { left: 62, right: 108, top: '76%', height: '12%', show: !!defs },
      ],
      // 日期标签跟随最底部可见 grid：无副图→成交量 grid1 显示；有副图→grid1 隐藏、副图 grid2 显示
      xAxis: [
        { gridIndex: 0, axisLabel: { show: false } },
        { gridIndex: 1, axisLabel: { show: defs ? false : true } },
        { gridIndex: 2, axisLabel: { show: !!defs } },
      ],
      yAxis: [
        { gridIndex: 0 },
        { gridIndex: 1 },
        { gridIndex: 2, name: defs && defs[0] ? defs[0].unit || '' : '' },
      ],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['K线', ...(maCount ? ['MA5', 'MA20', 'MA60', 'MA250'] : []), '成交量', ...overlayPart.map(s => s.name), ...(defs ? defs.map(d => d.name) : [])], ...(cur.legend?.[0]?.selected ? { selected: cur.legend[0].selected } : {}) },
      series: [mainSeries, ...maSeries, volSeries2, ...overlayPart, ...series],
    }, { replaceMerge: ['series', 'legend'] });
  }

  window.addEventListener('resize', () => { chart.resize(); });

  /* S7 锚线（数据可用后异步叠加；重复调用为替换语义）：list = [{value, label, color}]，line/candlestick 通用
     merge 模式按索引更新 series[0].markLine（data 长度恒定=2，逐索引替换无残留，不重建其他系列） */
  function addAnchorLines(list) {
    if (!list || !list.length) return;
    chart.setOption({
      series: [{
        markLine: {
          silent: true, symbol: 'none', z: 7,
          label: { position: 'end', fontSize: 11.5, fontWeight: 700, backgroundColor: cssVar('--tooltip-bg'), borderWidth: 1, borderRadius: 4, padding: [3, 6], formatter: (p) => p.name },
          data: list.map(a => ({
            yAxis: a.value, name: a.label,
            lineStyle: { color: a.color, type: 'dashed', width: 1 },
            label: { color: a.color, borderColor: a.color },
          })),
        },
      }],
    });
  }

  /* 主图窗口最高/最低点标记（markPoint）：merge 到 series[0]，随 dataZoom 窗口由调用方重算
     样式：短线引出 + 右侧文字（不遮挡K线）；data 长度恒定=2，逐索引替换无残留；setSubSeries 重建复用 series[0] 自动保留 */
  function setExtremes(ext) {
    if (!ext || ext.maxVal == null || ext.minVal == null) return;
    chart.setOption({
      series: [{
        markPoint: {
          silent: true, symbol: 'line', symbolSize: [30, 3], z: 8,
          label: { position: 'right', fontSize: 11, fontWeight: 700, formatter: (p) => p.value },
          data: [
            { coord: [ext.maxIdx, ext.maxVal], value: '最高 ' + ext.maxVal.toFixed(2), itemStyle: { color: cssVar('--up') }, label: { color: cssVar('--up') }, symbolOffset: [0, -6] },
            { coord: [ext.minIdx, ext.minVal], value: '最低 ' + ext.minVal.toFixed(2), itemStyle: { color: cssVar('--down') }, label: { color: cssVar('--down') }, symbolOffset: [0, 6] },
          ],
        },
      }],
    });
  }

  return { chart, setRange, setDateRange, onZoom, getZoom, setSubSeries, addAnchorLines, setExtremes,
           dispose: () => { window.removeEventListener('keydown', kbdMove); chart.dispose(); } };
}

/* 环形图（行业分布） */
export function createDonut(el, data, { title = '', selectable = false } = {}) {
  const chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      appendToBody: true,   // 挂到 body 顶层（DOM 层），永不裁剪，左侧扇区 hover 也完整可见
      formatter: (p) => `${p.name}：${p.value} 只（${p.percent.toFixed(1)}%）`,
      backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border-strong'), textStyle: { color: cssVar('--text'), fontSize: 12 },
    },
    legend: { type: 'scroll', orient: 'vertical', right: 2, top: 'middle', itemWidth: 10, itemHeight: 10, textStyle: { color: C.text2, fontSize: 11 }, pageIconColor: C.accent, pageTextStyle: { color: C.text3 } },
    title: { text: title, left: 6, top: 4, textStyle: { color: C.text3, fontSize: 12, fontWeight: 600 } },
    color: [C.accent, C.brand, C.indigo, C.up, cssVar('--mint'), '#F472B6', '#60A5FA', '#F87171', '#A3E635', '#2DD4BF', '#C084FC', '#FB923C', C.text2],
    series: [{
      type: 'pie', radius: ['44%', '62%'], center: ['36%', '50%'],
      selectedMode: selectable ? 'single' : false,   // 点击扇区选中偏移（成分股视图行业筛选用）
      avoidLabelOverlap: true, itemStyle: { borderColor: cssVar('--surface'), borderWidth: 2 },
      label: { show: false },
      emphasis: {
        scaleSize: 6,          // 扇区放大作为 hover 反馈
        label: { show: false },   // 不再用 canvas 内文字（左侧扇区会溢出被裁剪），信息由 tooltip 展示
      },
      data,
    }],
  });
  window.addEventListener('resize', () => { chart.resize(); });
  return chart;
}

/* 横向条形图（股息率 TOP） */
export function createBar(el, data, { title = '', unit = '%' } = {}) {
  const chart = echarts.init(el);
  const max = Math.max(...data.map(d => d.value), 0.1);
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => `${p[0].name}<br>股息率 <b style="color:#FBBF24">${p[0].value.toFixed(2)}%</b>`,
      backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border-strong'), textStyle: { color: cssVar('--text'), fontSize: 12 },
    },
    title: { text: title, left: 6, top: 4, textStyle: { color: C.text3, fontSize: 12, fontWeight: 600 } },
    grid: { left: 62, right: 24, top: 30, bottom: 16 },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: C.split } }, axisLabel: { color: C.text3, fontSize: 10.5, formatter: '{value}%' }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'category', data: data.map(d => d.name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.text2, fontSize: 11 } },
    series: [{
      type: 'bar', data: data.map(d => d.value), barWidth: 11,
      itemStyle: {
        borderRadius: [0, 5, 5, 0],
        color: (p) => {
          const t = p.value / max;
          return `rgba(251,191,36,${0.3 + t * 0.6})`;
        },
      },
      label: { show: true, position: 'right', color: C.text2, fontSize: 10.5, formatter: '{c}%' },
    }],
  });
  window.addEventListener('resize', () => { chart.resize(); });
  return chart;
}
