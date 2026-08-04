/* 视图：ETF历史（11只，K线+净值叠加+数据表格） */

import { buildHistoryView } from './historyLayout.js';
import { loadJSON, MANIFEST_URL } from '../data.js';
import { el, fmt2, fmtPct, fmt0, dirOf, dailyChg } from './common.js';

const columns = [
  { key: '日期', label: '日期', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: '开盘', label: '开盘(元)', sortable: true, fmt: fmt2 },
  { key: '收盘', label: '收盘(元)', sortable: true, fmt: fmt2 },
  { key: 'chg', label: '涨跌幅(%)', sortable: true, fmt: fmtPct, color: (v) => dirOf(v) },
  { key: '最高', label: '最高(元)', sortable: true, fmt: fmt2 },
  { key: '最低', label: '最低(元)', sortable: true, fmt: fmt2 },
  { key: 'vol', label: '成交量(万手)', sortable: true, fmt: (v) => (v == null ? '—' : fmt0(v)) },
  { key: 'amt', label: '成交额(亿元)', sortable: true, fmt: fmt2 },
  { key: 'nav', label: '单位净值', sortable: true, fmt: fmt2 },
  { key: 'acc_nav', label: '累计净值', sortable: true, fmt: fmt2 },
];

export default {
  async mount(container) {
    const m = await loadJSON(MANIFEST_URL);

    container.append(el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'ETF历史'),
        el('div', { class: 'desc' }, '精选 11 只红利相关 ETF · 场内K线（腾讯）+ 单位/累计净值（新浪）')),
      el('div', { class: 'txt-3', style: 'font-size:12px' }, '数据日期 ' + m.data_date)));

    buildHistoryView(container, {
      kind: 'etf',
      title: '精选ETF',
      items: m.etfs.map(i => ({
        code: i.code, name: i.name,
        price: i.last_nav,          // 主数字：最新单位净值
        chg: i.last_nav_chg,        // 净值涨跌幅（红涨绿跌，与指数面板同构）
      })),
      chartUnit: '元',
      subControl: 'none',
      showMA: false,              // ETF：去掉 MA5/MA20/MA60 均线
      showOHLC: false,            // ETF：浮动面板去掉 开盘/最高/最低 字段
      // 净值 overlay 已按用户要求移除（不叠加单位/累计净值线）
      quoteExtra: (obj, rows) => {
        let nav = null, acc = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (nav === null && rows[i].nav != null) nav = rows[i].nav;
          if (acc === null && rows[i].acc_nav != null) acc = rows[i].acc_nav;
          if (nav !== null && acc !== null) break;
        }
        return nav == null ? '' : `最新净值 ${fmt2(nav)}（单位）/ ${acc == null ? '—' : fmt2(acc)}（累计）`;
      },
      chartNote: () => [
        el('span', {}, '场内价格：腾讯K线；成交额按 量×100×(高+低+收)/3 估算（腾讯无成交额字段）'),
        el('span', {}, '净值：新浪财经单位净值/累计净值'),
        el('span', {}, '单位：万手 / 亿元（与 excel/ETF历史.xlsx 口径一致）'),
      ],
      columns,
      buildTableRows: (rows, k) => rows.map((r, i) => ({
        日期: r.date, 开盘: r.open, 收盘: r.close,
        chg: dailyChg(rows, i),
        最高: r.high, 最低: r.low,
        vol: k.volumes[i], amt: k.amounts[i],
        nav: r.nav ?? null, acc_nav: r.acc_nav ?? null,
      })),
    });
  },
};
