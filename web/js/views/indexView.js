/* 视图：指数历史（11只，K线+MA+成交量+数据表格） */

import { buildHistoryView } from './historyLayout.js';
import { loadJSON, MANIFEST_URL } from '../data.js';
import { el, fmt2, fmtPct, fmt0, dirOf, dailyChg } from './common.js';

const SOURCE_CN = { tencent: '腾讯K线', csindex: '中证官网', cnindex: '国证官网' };

const columns = [
  { key: '日期', label: '日期', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: '开盘', label: '开盘(点)', sortable: true, fmt: fmt2 },
  { key: '收盘', label: '收盘(点)', sortable: true, fmt: fmt2 },
  { key: 'chg', label: '涨跌幅(%)', sortable: true, fmt: fmtPct, color: (v) => dirOf(v) },
  { key: '最高', label: '最高(点)', sortable: true, fmt: fmt2 },
  { key: '最低', label: '最低(点)', sortable: true, fmt: fmt2 },
  { key: 'vol', label: '成交量(万手)', sortable: true, fmt: (v) => (v == null ? '—' : fmt0(v)) },
  { key: 'amt', label: '成交额(亿元)', sortable: true, fmt: fmt2 },
];

export default {
  async mount(container) {
    const m = await loadJSON(MANIFEST_URL);
    const idxMap = new Map(m.indices.map(i => [i.code, i]));

    container.append(el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, '指数历史'),
        el('div', { class: 'desc' }, '精选 11 只红利相关指数 · 日线 · 数据源：腾讯 / 中证官网 / 国证官网')),
      el('div', { class: 'txt-3', style: 'font-size:12px' }, '数据日期 ' + m.data_date)));

    buildHistoryView(container, {
      kind: 'index',
      title: '精选指数',
      manifestMap: idxMap,
      chartType: 'line',   // 指数：收盘折线 + 成交量（简洁展示）
      items: m.indices.map(i => ({ code: i.code, name: i.name, price: i.last_close, chg: i.last_chg })),
      chartUnit: '点',
      subControl: 'none',
      itemSub: (obj, rows) => el('span', { class: 'txt-3', style: 'font-size:10.5px' }, SOURCE_CN[idxMap.get(obj.code)?.source] || ''),
      chartNote: (obj, rows) => {
        const src = idxMap.get(obj.code)?.source;
        const notes = [
          src === 'tencent' ? '数据源：腾讯K线（无成交额字段，成交量=手，前端已换算为万手）' : '',
          src === 'csindex' ? '数据源：中证官网 index-perf（成交量=股→万手，成交额=亿元）' : '',
          src === 'cnindex' ? '数据源：国证官网（成交量=万手，成交额=亿元）' : '',
          '成交量单位：万手 · 成交额单位：亿元（与 excel/指数历史.xlsx 口径一致）',
        ].filter(Boolean);
        return notes.map((n) => el('span', {}, n));
      },
      columns,
      buildTableRows: (rows, k) => rows.map((r, i) => ({
        日期: r.date, 开盘: r.open, 收盘: r.close,
        chg: dailyChg(rows, i),
        最高: r.high, 最低: r.low,
        vol: k.volumes[i], amt: k.amounts[i],
      })),
    });
  },
};
