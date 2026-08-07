/* 组合回测视图：推荐20量化选股的历史验证（web/data/portfolio_backtest.json）
   净值曲线（四组对照）+ 指标卡 + 逐期明细表（点击行展开该期持仓）
   数据由 scripts/_backtest_portfolio.py 生成 */

import { el, renderTable, skeleton, errorBox, fmt2 } from './common.js';
import { loadJSON, PORTFOLIO_URL } from '../data.js';
import { cssVar } from '../theme.js';

const NAV = [
  { key: 'top20', label: 'TOP20（量化）', color: cssVar('--up'), dash: false },
  { key: 'idx', label: '000922 中证红利', color: cssVar('--mint'), dash: true },
  { key: 'fallback', label: '旧人工20只', color: cssVar('--brand'), dash: true },
  { key: 'pool', label: '候选池等权', color: '#60A5FA', dash: true },
];

const COLS = [
  { key: 'i', label: '期', align: 'center', sortable: false },
  { key: 't0', label: '调仓日', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: 'r', label: '组合%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)) },
  { key: 'rd', label: '含分红%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)) },
  { key: 'r_idx', label: '000922%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)) },
  { key: 'r_fb', label: '旧人工%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)) },
  { key: 'r_pool', label: '候选池%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)) },
  { key: 'vs', label: 'vs基准', align: 'center', sortable: true, fmt: (v) => v },
];

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton({ style: 'min-height:320px' }));
    try {
      const pb = await loadJSON(PORTFOLIO_URL);
      root.innerHTML = '';
      const periods = pb.periods || [];
      const st = pb.stats || {};

      /* 头部 */
      const head = el('div', { class: 'bt-head' },
        el('h2', { class: 'chart-title' }, '组合回测 · 推荐20量化选股历史验证'),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8;margin-top:4px' },
          `生成日期 ${pb.date} · 区间 ${pb.start} ~ ${pb.end}（${periods.length} 期季度调仓）· TOP20 等权；选股与线上推荐评分同构（硬过滤 + 三组10因子 + 行业≤4/四象限≥3），因子均取调仓日及以前数据（无未来函数）`),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8' },
          '收益为价格口径（主）；含分红 = 期内除权派息计入（不复投）；基准 000922 为价格指数；局限：成分股幸存者偏差、交易成本约 1pp 未计入'),
      );

      /* 指标卡（四组对照） */
      const sumCard = el('div', { class: 'bt-summary', style: 'margin-top:12px' });
      const stKeys = [['top20', 'TOP20（量化）'], ['idx', '000922 中证红利'], ['fallback', '旧人工20只'], ['pool', '候选池等权']];
      for (const [k, label] of stKeys) {
        const s = st[k] || {};
        const cls = s.ann > 0 ? 'txt-up' : s.ann < 0 ? 'txt-down' : '';
        sumCard.append(el('div', { class: 'bt-cell' },
          el('div', { class: 'txt-3', style: 'font-size:11px' }, label),
          el('div', { class: 'bt-val ' + (k === 'top20' ? '' : '') }, s.total == null ? '—' : (s.total >= 0 ? '+' : '') + s.total + '%'),
          el('div', { class: 'txt-3', style: 'font-size:10.5px;line-height:1.7' },
            '年化 ', el('span', { class: cls }, s.ann == null ? '—' : (s.ann >= 0 ? '+' : '') + s.ann + '%'),
            ' · 回撤 ', s.mdd == null ? '—' : s.mdd + '%',
            ' · 夏普 ', s.sharpe == null ? '—' : s.sharpe)));
      }
      /* 胜率条 */
      const winLine = el('div', { class: 'txt-3', style: 'font-size:11.5px;margin:8px 2px 0' },
        '季度胜率（TOP20 vs 000922）：', el('b', { class: 'txt-up' }, `${pb.wins}/${pb.n_periods}`),
        `（${Math.round(pb.wins / pb.n_periods * 100)}%） · 平均每期换手 ${pb.turnover != null ? Math.round(pb.turnover * 100) : '—'}%`);

      /* 净值曲线 */
      const chartBox = el('div', { class: 'chart', style: 'height:400px;margin-top:10px' });
      const navs = { top20: [1], idx: [1], fallback: [1], pool: [1] };
      const xs = [];
      for (const p of periods) {
        xs.push(p.t1);
        for (const n of NAV) {
          const r = n.key === 'top20' ? p.r : p['r_' + n.key];
          navs[n.key].push(navs[n.key][navs[n.key].length - 1] * (1 + (r == null ? 0 : r) / 100));
        }
      }
      const chart = echarts.init(chartBox);
      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border-strong'), textStyle: { color: cssVar('--text'), fontSize: 11 }, valueFormatter: (v) => (v * 100).toFixed(1) + '%' },
        legend: { data: NAV.map(n => n.label), textStyle: { color: cssVar('--text-2'), fontSize: 11 }, top: 0, itemWidth: 14 },
        grid: { left: 58, right: 16, top: 30, bottom: 42 },
        xAxis: { type: 'category', data: xs, axisLine: { lineStyle: { color: cssVar('--border-strong') } }, axisLabel: { color: cssVar('--text-2'), fontSize: 10 } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: cssVar('--text-2'), fontSize: 10, formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: cssVar('--grid-line') } } },
        series: NAV.map(n => ({
          name: n.label, type: 'line', data: navs[n.key].slice(1).map(v => +v.toFixed(4)),
          showSymbol: false, lineStyle: { width: 1.8, type: n.dash ? 'dashed' : 'solid' },
          itemStyle: { color: n.color }, emphasis: { focus: 'series' },
        })),
      });
      chart.getZr().on('click', () => { }); // 占位：保留缩放平移默认行为

      /* 逐期明细表 */
      const tableTitle = el('div', { class: 'txt-3', style: 'font-size:11px;margin:14px 2px 0' },
        '逐期明细（点击行展开该期 TOP20 持仓）');
      const tableBox = el('div', {});
      const rows = periods.map((p, i) => ({
        i: i + 1, t0: p.t0, r: p.r, rd: (p.r == null || p.r_div == null) ? null : p.r + p.r_div,
        r_idx: p.r_idx, r_fb: p.r_fb, r_pool: p.r_pool,
        vs: p.r_idx == null ? '—' : (p.r > p.r_idx ? '▲ 胜' : '▼ 负'),
      }));
      renderTable(tableBox, { columns: COLS, rows, pageSize: 15 });
      const pickBox = el('div', { class: 'pf-picks' });
      tableBox.addEventListener('click', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        const t0 = tr.children[1]?.textContent?.trim();
        const p = periods.find((x) => x.t0 === t0);
        if (!p) return;
        pickBox.innerHTML = '';
        pickBox.append(el('div', { class: 'txt-3', style: 'font-size:11px;margin-bottom:8px' },
          `${p.t0} 持仓（${p.pick.length} 只）· 本期组合 ${p.r >= 0 ? '+' : ''}${fmt2(p.r)}%（含分红 ${p.r + p.r_div >= 0 ? '+' : ''}${fmt2(p.r + p.r_div)}%）`));
        const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
        for (const it of p.pick) wrap.append(el('span', { class: 'pf-chip' }, `${it.code} ${it.name}`));
        pickBox.append(wrap);
      });

      root.append(head, sumCard, winLine, chartBox, tableTitle, tableBox, pickBox);
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox(`组合回测加载失败：${err.message}（数据由 python scripts/_backtest_portfolio.py 生成）`, () => this.mount(root)));
    }
  },
};
