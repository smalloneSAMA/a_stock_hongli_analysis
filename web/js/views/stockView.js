/* 视图：股票历史（20只推荐，不复权K线 + 指标副图 + 全指标表格） */

import { buildHistoryView } from './historyLayout.js';
import { loadJSON, MANIFEST_URL } from '../data.js';
import { el, fmt2, fmtPct, fmt0, dirOf, dailyChg } from './common.js';

/* 指标副图选项（key 对应 web/data/stocks/{code}.json 字段，与 Excel 口径一致） */
const INDICATORS = [
  { key: 'dy', label: '股息率', color: '#FBBF24', unit: '%' },
  { key: 'pe_ttm', label: 'PE-TTM', color: '#22D3EE', unit: '倍' },
  { key: 'pe_dyn', label: 'PE(动)', color: '#60A5FA', unit: '倍' },
  { key: 'pb', label: 'PB', color: '#818CF8', unit: '倍' },
  { key: 'peg', label: 'PEG', color: '#F472B6', unit: '' },
  { key: 'roe', label: 'ROE', color: '#34D399', unit: '%' },
  { key: 'roa', label: 'ROA', color: '#F87171', unit: '%' },
];

const columns = [
  { key: '日期', label: '日期', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: '开盘', label: '开盘(元)', sortable: true, fmt: fmt2 },
  { key: '收盘', label: '收盘(元)', sortable: true, fmt: fmt2 },
  { key: 'chg', label: '涨跌幅(%)', sortable: true, fmt: fmtPct, color: (v) => dirOf(v) },
  { key: '最高', label: '最高(元)', sortable: true, fmt: fmt2 },
  { key: '最低', label: '最低(元)', sortable: true, fmt: fmt2 },
  { key: 'vol', label: '成交量(万手)', sortable: true, fmt: (v) => (v == null ? '—' : fmt0(v)) },
  { key: 'amt', label: '成交额(亿元)', sortable: true, fmt: fmt2 },
  { key: 'dy', label: '股息率(%)', sortable: true, fmt: fmt2, color: (v) => (v > 0 ? 'brand' : 'flat') },
  { key: 'pe_ttm', label: 'PE(TTM)(倍)', sortable: true, fmt: fmt2 },
  { key: 'pe_dyn', label: 'PE动(倍)', sortable: true, fmt: fmt2 },
  { key: 'pb', label: 'PB(倍)', sortable: true, fmt: fmt2 },
  { key: 'peg', label: 'PEG', sortable: true, fmt: fmt2 },
  { key: 'roe', label: 'ROE(%)', sortable: true, fmt: fmt2 },
  { key: 'roa', label: 'ROA(%)', sortable: true, fmt: fmt2 },
];

export default {
  async mount(container) {
    const m = await loadJSON(MANIFEST_URL);

    container.append(el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, '股票历史'),
        el('div', { class: 'desc' }, '《红利股票推荐20只》· 不复权日线 2004-01-01 起 · 逐日指标与 excel/股票历史.xlsx 同口径')),
      el('div', { class: 'txt-3', style: 'font-size:12px' }, '数据日期 ' + m.data_date)));

    /* 列表信息全部来自 manifest（含最新价/涨跌/股息率），K线与指标选中后按需加载 */
    const items = m.stocks.map((s) => ({
      code: s.code, name: s.name, price: s.last_close, chg: s.last_chg,
      subHtml: s.last_dy == null
        ? el('span', { class: 'txt-3', style: 'font-size:10.5px' }, '无指标数据')
        : el('span', { class: 'txt-brand', style: 'font-size:10.5px;font-weight:600' }, `股息率 ${fmt2(s.last_dy)}%`),
    }));

    buildHistoryView(container, {
      kind: 'stock',
      title: '推荐20只',
      items,
      chartUnit: '元',
      subControl: 'none',
      showMA: false,              // 股票：去掉 MA5/MA20/MA60 均线
      showOHLC: false,            // 股票：浮动面板去掉 开盘/最高/最低 字段
      withIndicator: true,   // 加载指标数据供主图叠加曲线使用
      // 主图右轴叠加 6 条指标曲线（默认关闭，点击图例展开查看；与 K 线同图）
      overlay: (rows, ind) => ind ? INDICATORS.filter(d => d.key !== 'dy').map(d => ({
        name: d.label, data: ind.map(x => x[d.key] ?? null), color: d.color, unit: d.unit, visible: false,
      })) : null,
      chartNote: () => [
        el('span', {}, '不复权真实价格（前复权早期价格会因分红为负，故不用）'),
        el('span', {}, '股息率：除权日在(当日-365天,当日]内每股派息÷收盘×100（同东财口径）'),
        el('span', {}, 'PE = 总市值(收盘×当日总股本) ÷ 归母净利（TTM/年化）；PEG = PE-TTM ÷ TTM净利同比增速'),
        el('span', {}, '成交额按 量×100×(高+低+收)/3 估算；单位：万手 / 亿元'),
      ],
      columns,
      buildTableRows: (rows, k, ind) => rows.map((r, i) => ({
        日期: r.date, 开盘: r.open, 收盘: r.close,
        chg: dailyChg(rows, i),
        最高: r.high, 最低: r.low,
        vol: k.volumes[i], amt: k.amounts[i],
        dy: ind ? ind[i].dy ?? null : null,
        pe_ttm: ind ? ind[i].pe_ttm ?? null : null,
        pe_dyn: ind ? ind[i].pe_dyn ?? null : null,
        pb: ind ? ind[i].pb ?? null : null,
        peg: ind ? ind[i].peg ?? null : null,
        roe: ind ? ind[i].roe ?? null : null,
        roa: ind ? ind[i].roa ?? null : null,
      })),
    });
  },
};
