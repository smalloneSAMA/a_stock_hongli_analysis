/* 视图：股票历史（20只推荐，不复权K线 + 指标副图 + 全指标表格） */

import { buildHistoryView } from './historyLayout.js';
import { loadJSON, MANIFEST_URL } from '../data.js';
import { cssVar } from '../theme.js';
import { el, fmt2, fmtPct, fmt0, dirOf, dailyChg } from './common.js';

/* 指标副图选项（key 对应 web/data/stocks/{code}.json 字段，与 Excel 口径一致） */
const INDICATORS = [
  { key: 'dy', label: '股息率', color: cssVar('--brand'), unit: '%' },
  { key: 'pe_ttm', label: 'PE-TTM', color: cssVar('--accent'), unit: '倍' },
  { key: 'pe_dyn', label: 'PE(动)', color: '#60A5FA', unit: '倍' },
  { key: 'pb', label: 'PB', color: cssVar('--indigo'), unit: '倍' },
  { key: 'peg', label: 'PEG', color: '#F472B6', unit: '' },
  { key: 'pr', label: '市赚率PR', color: '#F59E0B', unit: '' },
  { key: 'roe', label: 'ROE', color: cssVar('--mint'), unit: '%' },
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
  { key: 'pr', label: 'PR市赚率', sortable: true, fmt: fmt2, color: (v) => (v != null && v < 0.7 ? 'up' : v != null && v > 1.5 ? 'down' : '') },
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

    /* 列表信息全部来自 manifest（含最新价/涨跌/股息率/一二级行业），K线与指标选中后按需加载 */
    const toItem = (s) => ({
      code: s.code, name: s.name, price: s.last_close, chg: s.last_chg,
      ind: s.ind || '',   // 一级行业（行业筛选用）
      subHtml: el('span', { class: 'txt-3', style: 'font-size:10.5px' },
        (s.ready === false ? '⚠ 待拉取 · ' : '') + (s.ind || '—') + ' · 股息率 ' + (s.last_dy == null ? '—' : fmt2(s.last_dy) + '%')),
    });
    const recItems = m.stocks.filter(s => s.rec).map(toItem);
    /* 自选股清单（manifest watch 标记）：推荐/其他 tab 不受清单影响（重叠股票两侧同时出现）；
       自选股 tab 只显示清单中展示字段==1 的股票，按 xlsx 序号排序 */
    const watchItems = m.stocks.filter(s => s.watch)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(toItem);
    const otherItems = m.stocks.filter(s => !s.rec).map(toItem);

    buildHistoryView(container, {
      kind: 'stock',
      title: '股票历史',
      groups: [
        { label: '推荐 ' + recItems.length, items: recItems },
        { label: '其他成份股 ' + otherItems.length, items: otherItems },
        { label: '自选股 ' + watchItems.length, items: watchItems },
      ],
      chartUnit: '元',
      subControl: 'none',
      compView: false,            // 股票：去掉 图表/成分股 切换
      showMA: true,               // 股票：MA5/20/60/250 均线可用（工具栏 checkbox 控制显隐，默认关）
      showOHLC: false,            // 股票：浮动面板去掉 开盘/最高/最低 字段
      withIndicator: true,   // 加载指标数据供主图叠加曲线使用
      // 主图右轴叠加 7 条指标曲线（默认全关；不占图例——与 ETF 图例样式统一，由工具栏「指标」多选控件开关）
      overlay: (rows, ind) => ind ? INDICATORS.filter(d => d.key !== 'dy').map(d => ({
        name: d.label, data: ind.map(x => x[d.key] ?? null), color: d.color, unit: d.unit, visible: false,
      })) : null,
      chartNote: () => [
        el('span', {}, '不复权真实价格（前复权早期价格会因分红为负，故不用）'),
        el('span', {}, '股息率：除权日在(当日-365天,当日]内每股派息÷收盘×100（同东财口径）'),
        el('span', {}, 'PE = 总市值(收盘×当日总股本) ÷ 归母净利（TTM/年化）；PEG = PE-TTM ÷ TTM净利同比增速'),
        el('span', {}, '市赚率PR = PE-TTM ÷ 近5年年化ROE（近5年各报告期 TTM 年化 ROE 均值，随财报披露滚动更新）；≈1 合理、<1 低估、>1 高估；周期股盈利波动大时参考价值下降'),
        el('span', {}, '成交额按 量×100×(高+低+收)/3 估算；单位：万手 / 亿元'),
        el('span', {}, '买入信号：股息率上穿近5年90%分位（dy 进入历史高位区=便宜），次一交易日收盘执行——与「智能推荐」信号数、回测 p90 同口径；默认隐藏，点击图例圆点开启'),
      ],
      quoteExtra: (obj, rows, item) => {
        const s = m.stocks.find(x => x.code === obj.code) || {};
        return (s.ind || '—') + ' · ' + (s.ind3 || '—');
      },
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
        pr: ind ? ind[i].pr ?? null : null,
        roe: ind ? ind[i].roe ?? null : null,
        roa: ind ? ind[i].roa ?? null : null,
      })),
    });
  },
};
