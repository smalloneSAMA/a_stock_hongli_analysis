/* 视图：信号扫描（近5年股息率分位触发，与回测同口径）
   指数/ETF：dy 分位 ≥90 买入区 / ≤10 卖出区（回测验证有效：12M 超额 +24%）
   股票：触发模式可选——仅dy（≥90/≤10）/ 仅区间分数（均衡分 ≤25 买 / ≥80 卖）/ dy+分数 双条件（AND）
   观察区：dy 分位 85~90（买入侧）/ 10~15（卖出侧），方案A：仅按 dy，不受个股模式影响
   数据：cache/analysis_dy.json（dy_pct=股息率分位，高=便宜）+ analysis.json（均衡分）+ manifest（分组） */

import { loadJSON, MANIFEST_URL, ANALYSIS_URL } from '../data.js';
import { el, fmt2, dirOf, skeleton, errorBox, renderTable, favStar } from './common.js';
import { scoreOf } from './analysis.js';   // 贵贱度加权分（P4.3 三合一）

const DY_URL = '/cache/analysis_dy.json';

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton());
    try {
      const [dy, an, m] = await Promise.all([loadJSON(DY_URL), loadJSON(ANALYSIS_URL), loadJSON(MANIFEST_URL)]);
      root.innerHTML = '';
      const byCode = an.by_code || {};
      const meta = {};
      for (const s of (m.stocks || [])) meta[s.code] = s;

      /* 分组判定（推荐优先于自选，与回测一致） */
      const groupOf = (code, type) => {
        if (type === '指数') return '指数';
        if (type === 'ETF') return 'ETF';
        const s = meta[code] || {};
        if (s.rec) return '推荐20';
        if (s.watch) return '自选股';
        return '其他成份股';
      };

      /* 构建全池行（跳过无股息率标的） */
      const all = [];
      let maxDate = '';
      for (const code in dy) {
        const d = dy[code];
        if (d.dy0 == null || d.dy_pct == null) continue;
        if (d.series && d.series.length) {
          const last = d.series[d.series.length - 1][0];
          if (last > maxDate) maxDate = last;
        }
        const type = d.type;
        all.push({ code, name: d.name || code, type, group: groupOf(code, type),
          dy: d.dy_now, pct: d.dy_pct, score: scoreOf(byCode[code], '均衡', type, an.presets) });
      }

      /* ── 状态 ── */
      let zone = 'buy';      // buy / sell / watch
      let typeF = '全部';    // 类型/分组筛选
      let mode = 'dy';       // 个股触发：dy / score / both

      /* 触发判定 */
      const buyOf = (r) => {
        if (r.type === '股票' && mode === 'score') return r.score != null && r.score <= 25;
        if (r.type === '股票' && mode === 'both') return r.pct >= 90 && r.score != null && r.score <= 25;
        return r.pct >= 90;
      };
      const sellOf = (r) => {
        if (r.type === '股票' && mode === 'score') return r.score != null && r.score >= 80;
        if (r.type === '股票' && mode === 'both') return r.pct <= 10 && r.score != null && r.score >= 80;
        return r.pct <= 10;
      };
      const watchSide = (r) => {   // 方案A：观察区仅按 dy，不受个股模式影响
        if (r.pct >= 85 && r.pct < 90) return '买入侧';
        if (r.pct > 10 && r.pct <= 15) return '卖出侧';
        return null;
      };
      const inZone = (r, z) => (z === 'buy' ? buyOf(r) : z === 'sell' ? sellOf(r) : watchSide(r) != null);
      /* 类型筛选：全部 / 指数 / ETF / 个股（池内全部股票） */
      const typeMatch = (r) => {
        if (typeF === '全部') return true;
        if (typeF === '个股') return r.type === '股票';
        return r.type === typeF;
      };
      const zoneList = (z) => all.filter(r => typeMatch(r) && inZone(r, z));

      /* ── DOM ── */
      root.append(el('div', { class: 'view-head' },
        el('h1', {}, '信号扫描'),
        el('div', { class: 'desc' }, '近5年股息率分位触发（与回测同口径）：指数/ETF 按 dy 分位 ≥90 买入 / ≤10 卖出（回测 12M 超额 +24% 有效）；个股触发模式可选')));

      const zoneTabs = el('div', { class: 'seg-group', role: 'group', 'aria-label': '区间' });
      const typeSel = el('select', { class: 'ind-filter', 'aria-label': '类型筛选', title: '按类型筛选（个股=池内全部股票）' },
        ['全部', '指数', 'ETF', '个股'].map(t => el('option', { value: t }, t)));
      const modeSel = el('select', { class: 'ind-filter', 'aria-label': '个股触发模式', title: '个股触发条件：仅dy分位 / 仅区间分数 / 两者都满足' },
        el('option', { value: 'dy' }, '个股:仅dy'),
        el('option', { value: 'score' }, '个股:仅区间分数'),
        el('option', { value: 'both' }, '个股:dy+分数'));
      const sumEl = el('div', { class: 'bt-summary' });
      const tableBox = el('div', { class: 'card table-card' }, el('div', { class: 'table-wrap' }, ''));
      root.append(sumEl,
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 2px' }, zoneTabs, typeSel, modeSel),
        tableBox,
        el('div', { class: 'txt-3', style: 'font-size:11.5px;margin:8px 2px;line-height:1.7' },
          '口径：dy分位=股息率近5年滚动分位（高=便宜，与回测同源）。买入区：指数/ETF dy≥90；个股按所选模式（仅dy≥90 / 仅均衡分≤25 / 双条件都满足）。',
          '卖出区：dy≤10（个股分数模式≥80）。观察区：dy 85~90 买入侧 / 10~15 卖出侧（仅按dy）。',
          '⚠ 回测结论：dy 分位对指数/ETF 显著有效，个股单独使用弱有效（高股息陷阱）——个股建议用 dy+分数 双条件。',
          '本页为状态扫描（当前处于哪个区），非即时触发信号，不构成投资建议。'));

      /* 表格列（距阈值/观察侧随区间变化） */
      const paint = () => {
        zoneTabs.innerHTML = '';
        for (const [k, lab] of [['buy', '买入区'], ['sell', '卖出区'], ['watch', '观察区']]) {
          zoneTabs.append(el('button', { class: 'seg-btn' + (k === zone ? ' active' : ''), onclick: () => { zone = k; paint(); } }, lab));
        }
        /* 汇总卡 */
        sumEl.innerHTML = '';
        sumEl.append(
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '数据日期'), el('b', {}, maxDate || m.data_date || '—')),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '买入区'), el('b', { class: 'txt-up' }, zoneList('buy').length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '卖出区'), el('b', { class: 'txt-down' }, zoneList('sell').length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '观察区'), el('b', {}, zoneList('watch').length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '筛选池'), el('b', {}, all.filter(typeMatch).length)));
        /* 行构建（距阈值） */
        const rows = zoneList(zone).map(r => {
          let gap = null, side = '';
          if (zone === 'buy') gap = (r.type === '股票' && mode === 'score') ? (r.score == null ? null : 25 - r.score) : r.pct - 90;
          else if (zone === 'sell') gap = (r.type === '股票' && mode === 'score') ? (r.score == null ? null : r.score - 80) : 10 - r.pct;
          else { side = watchSide(r) || ''; gap = side === '买入侧' ? 90 - r.pct : r.pct - 10; }
          return { ...r, gap, side };
        });
        const cols = [
          { key: 'fav', label: '★', align: 'center', sortable: false, filter: false, fmt: (_v, row) => favStar(row.code) },
          { key: 'code', label: '代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
          { key: 'name', label: '名称', align: 'left', sortable: true },
          { key: 'type', label: '类型', sortable: true, filter: false },
          { key: 'group', label: '分组', sortable: true, filter: false },
          { key: 'dy', label: '当前dy(%)', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)) },
          { key: 'pct', label: 'dy分位', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)), color: (v) => (v >= 90 ? 'up' : v <= 10 ? 'down' : '') },
          { key: 'score', label: '均衡分', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)), color: (v) => (v != null && v <= 25 ? 'up' : v != null && v >= 80 ? 'down' : '') },
          { key: 'gap', label: '距阈值', sortable: true,
            fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1)), color: (v) => dirOf(v), filter: false },
          { key: 'side', label: '观察侧', sortable: true, fmt: (v) => (v || '—'), filter: false },
        ];
        renderTable(tableBox.querySelector('.table-wrap'), { columns: cols, rows, pageSize: 50 });
      };

      typeSel.addEventListener('change', () => { typeF = typeSel.value; paint(); });
      modeSel.addEventListener('change', () => { mode = modeSel.value; paint(); });
      paint();
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox(`信号扫描加载失败：${err.message}`, () => { root.innerHTML = ''; this.mount(root); }));
    }
  },
  dispose() {},
};
