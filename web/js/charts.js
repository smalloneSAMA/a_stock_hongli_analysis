/* ECharts 工厂：行情图（K线或收盘折线+成交量）、环形图、条形图
   A股习惯：红涨绿跌 */

const C = {
  up: '#F6465D', down: '#22C55E',
  ma5: '#FBBF24', ma20: '#22D3EE', ma60: '#A78BFA',
  volUp: 'rgba(246,70,93,0.42)', volDown: 'rgba(34,197,94,0.42)',
  axis: '#64748B', split: 'rgba(148,163,184,0.09)', text2: '#94A3B8', text3: '#64748B',
  accent: '#22D3EE', brand: '#FBBF24', indigo: '#818CF8',
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
  const { dates, klines, volumes, unit = '', subUnit = '', mode = 'candlestick' } = opts;
  const chg = chgArr(klines);
  const closes = klines.map(k => k[1]);

  const axisBase = {
    axisLine: { lineStyle: { color: 'rgba(51,65,85,0.6)' } },
    axisTick: { show: false },
    axisLabel: { color: C.text3, fontSize: 10.5, hideOverlap: true },
    min: 'dataMin', max: 'dataMax',
  };

  const tooltipBase = {
    trigger: 'axis', axisPointer: { type: 'cross' },
    backgroundColor: 'rgba(10,16,30,0.94)', borderColor: '#334155', borderWidth: 1,
    padding: [8, 12], textStyle: { color: '#E2E8F0', fontSize: 12 },
  };

  const dataZoomBase = [
    // 仅保留 slider 拖拉条：滚轮缩放（inside）已按用户要求移除
    { type: 'slider', bottom: 2, height: 16, borderColor: 'rgba(51,65,85,0.5)', backgroundColor: 'rgba(15,23,42,0.5)', fillerColor: 'rgba(34,211,238,0.12)', handleStyle: { color: '#22D3EE' }, moveHandleStyle: { color: '#22D3EE' }, textStyle: { color: C.text3, fontSize: 9 }, dataBackground: { lineStyle: { color: '#334155' }, areaStyle: { color: 'rgba(51,65,85,0.25)' } }, minValueSpan: 20 },
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

  /* slider 拖动/范围变更回调：cb(startPct, endPct)；返回取消函数 */
  let zoomCbs = [];
  const onZoomHandler = (p) => {
    for (const cb of zoomCbs) cb(p.start, p.end);
  };
  function onZoom(cb) {
    zoomCbs.push(cb);
    return () => { zoomCbs = zoomCbs.filter((x) => x !== cb); };
  }

  /* ── line 模式：收盘折线 + 成交量 ── */
  let option;
  if (mode === 'line') {
    const xAxisIndex = [0, 1];
    option = {
      animationDuration: 420,
      animationEasing: 'cubicOut',
      backgroundColor: 'transparent',
      textStyle: { fontFamily: "'Fira Code','Consolas',monospace", color: C.text2 },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#1E293B' } },
      tooltip: {
        ...tooltipBase,
        formatter(params) {
          const i = params[0].dataIndex;
          const c = chg[i];
          const rows = [
            `<div style="font-weight:700;margin-bottom:4px">${dates[i]}</div>`,
            `收盘 <b style="float:right;margin-left:18px">${closes[i].toFixed(2)} ${unit}</b><br>`,
            `涨跌 <b style="float:right;margin-left:18px;color:${c == null ? C.text2 : (c >= 0 ? C.up : C.down)}">${c == null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%'}</b>`,
          ];
          if (volumes[i] != null) rows.push(`成交量 <b style="float:right;margin-left:18px">${volumes[i].toFixed(0)}</b>`);
          return rows.join('');
        },
      },
      grid: [
        { left: 62, right: 14, top: 30, height: '58%' },
        { left: 62, right: 14, top: '74%', height: '12%' },
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
          lineStyle: { color: C.accent, width: 1.8, shadowBlur: 8, shadowColor: 'rgba(34,211,238,0.4)' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(34,211,238,0.26)' },
              { offset: 1, color: 'rgba(34,211,238,0.01)' },
            ]),
          },
        },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes, barMaxWidth: 5, sampling: 'lttb', itemStyle: { color: 'rgba(34,211,238,0.35)' } },
      ],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['收盘', '成交量'] },
    };
  } else {
    /* ── candlestick 模式：K线 + MA + 成交量 + 副图（默认）；支持主图右轴叠加 overlay 折线（净值） ── */
    const overlay = opts.overlay || [];
    const overlaySeries = overlay.map((d, i) => ({
      name: d.name, type: 'line', xAxisIndex: 0, yAxisIndex: 3, data: d.data,
      symbol: 'none', smooth: true, connectNulls: false, sampling: 'lttb', z: 9,
      lineStyle: { width: i === 0 ? 1.6 : 1.2, color: d.color, type: d.dash ? 'dashed' : 'solid' },
      itemStyle: { color: d.color },
    }));
    option = {
      animationDuration: 420,
      animationEasing: 'cubicOut',
      backgroundColor: 'transparent',
      textStyle: { fontFamily: "'Fira Code','Consolas',monospace", color: C.text2 },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#1E293B' } },
      tooltip: {
        ...tooltipBase,
        formatter(params) {
          const i = params[0].dataIndex;
          const k = klines[i];
          const d = dates[i];
          const c = chg[i];
          const rows = [
            `<div style="font-weight:700;margin-bottom:4px">${d}</div>`,
            `开 <b style="float:right;margin-left:18px">${k[0].toFixed(2)}</b><br>`,
            `收 <b style="float:right;margin-left:18px">${k[1].toFixed(2)}</b>`,
            `高 <b style="float:right;margin-left:18px">${k[3].toFixed(2)}</b><br>`,
            `低 <b style="float:right;margin-left:18px">${k[2].toFixed(2)}</b>`,
            `涨跌 <b style="float:right;margin-left:18px;color:${c == null ? C.text2 : (c >= 0 ? C.up : C.down)}">${c == null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%'}</b>`,
          ];
          if (volumes[i] != null) rows.push(`量 <b style="float:right;margin-left:18px">${(volumes[i]).toFixed(0)}</b>`);
          for (const p of params) {
            if (p.seriesType !== 'candlestick' && p.seriesType !== 'bar') {
              rows.push(`${p.marker}${p.seriesName} <b style="float:right;margin-left:18px">${p.value == null ? '—' : Number(p.value).toFixed(2)}</b>`);
            }
          }
          return rows.join('');
        },
      },
      grid: [
        { left: 62, right: 14, top: 30, height: '62%' },
        { left: 62, right: 14, top: '76%', height: '9%' },
        { left: 62, right: 14, top: '76%', height: '12%', show: false },
      ],
      xAxis: [0, 1, 2].map((g) => ({ type: 'category', data: dates, gridIndex: g, boundaryGap: true, ...axisBase, axisLabel: { ...axisBase.axisLabel, show: g === 2 }, splitLine: { show: false } })),
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
          name: 'K线', type: 'candlestick', data: klines,
          itemStyle: {
            color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down,
            borderWidth: 1,
            shadowBlur: 6, shadowColor: 'rgba(246,70,93,0.25)',
          },
        },
        { name: 'MA5', ...MA_STYLE, data: ma(closes, 5), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma5 } },
        { name: 'MA20', ...MA_STYLE, data: ma(closes, 20), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma20 } },
        { name: 'MA60', ...MA_STYLE, data: ma(closes, 60), lineStyle: { ...MA_STYLE.lineStyle, color: C.ma60 } },
        {
          name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes,
          itemStyle: { color: (p) => (klines[p.dataIndex][1] >= klines[p.dataIndex][0] ? C.volUp : C.volDown) },
          barMaxWidth: 5, sampling: 'lttb',
        },
        ...overlaySeries,
      ],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['K线', 'MA5', 'MA20', 'MA60', ...overlay.map(d => d.name)] },
    };
  }

  const chart = echarts.init(el, null, { renderer: 'canvas' });
  chart.setOption(option);
  chart.on('datazoom', onZoomHandler);

  // 兜底：若容器尚未布局（宽高为 0，如隐藏/未挂载），下一帧校准一次，避免空白
  if (!el.clientWidth || !el.clientHeight) {
    requestAnimationFrame(() => { chart.resize(); });
  }

  /* 副图（指标/净值）：仅 candlestick 模式；line 模式为空操作 */
  function setSubSeries(defs) {
    if (mode !== 'candlestick') return;
    const series = defs ? defs.map((d, i) => ({
      name: d.name, type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: d.data,
      symbol: 'none', smooth: true, connectNulls: false, sampling: 'lttb', z: 8,
      lineStyle: { width: i === 0 ? 1.8 : 1.3, color: d.color }, itemStyle: { color: d.color },
    })) : [];
    chart.setOption({
      grid: [
        { left: 62, right: 14, top: 30, height: defs ? '48%' : '62%' },
        { left: 62, right: 14, top: defs ? '62%' : '76%', height: '9%' },
        { left: 62, right: 14, top: '76%', height: '12%', show: !!defs },
      ],
      yAxis: [{}, {}, { name: defs && defs[0] ? defs[0].unit || '' : '' }],
      legend: { show: true, top: 2, left: 62, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: C.text3, fontSize: 10.5 }, data: ['K线', 'MA5', 'MA20', 'MA60', ...(defs ? defs.map(d => d.name) : [])] },
      series: [...option.series.slice(0, 4), option.series[4], ...series],
    }, { replaceMerge: ['series', 'legend'] });
  }

  window.addEventListener('resize', () => { chart.resize(); });
  return { chart, setRange, setDateRange, onZoom, setSubSeries, dispose: () => { chart.dispose(); } };
}

/* 环形图（行业分布） */
export function createDonut(el, data, { title = '' } = {}) {
  const chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: (p) => `${p.name}：${p.value} 只（${p.percent.toFixed(1)}%）`,
      backgroundColor: 'rgba(10,16,30,0.94)', borderColor: '#334155', textStyle: { color: '#E2E8F0', fontSize: 12 },
    },
    legend: { type: 'scroll', orient: 'vertical', right: 2, top: 'middle', itemWidth: 10, itemHeight: 10, textStyle: { color: C.text2, fontSize: 11 }, pageIconColor: C.accent, pageTextStyle: { color: C.text3 } },
    title: { text: title, left: 6, top: 4, textStyle: { color: C.text3, fontSize: 12, fontWeight: 600 } },
    color: ['#22D3EE', '#FBBF24', '#818CF8', '#F6465D', '#34D399', '#F472B6', '#60A5FA', '#F87171', '#A3E635', '#2DD4BF', '#C084FC', '#FB923C', '#94A3B8'],
    series: [{
      type: 'pie', radius: ['52%', '74%'], center: ['34%', '54%'],
      avoidLabelOverlap: true, itemStyle: { borderColor: '#0F172A', borderWidth: 2 },
      label: { show: false }, emphasis: { label: { show: true, fontSize: 13, fontWeight: 700, color: '#F8FAFC', formatter: '{b}\n{c}只' } },
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
      backgroundColor: 'rgba(10,16,30,0.94)', borderColor: '#334155', textStyle: { color: '#E2E8F0', fontSize: 12 },
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
