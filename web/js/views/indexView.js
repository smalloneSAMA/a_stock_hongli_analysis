/* 视图：指数历史（11只，K线+MA+成交量+数据表格） */

import { buildHistoryView } from './historyLayout.js';
import { loadJSON, MANIFEST_URL } from '../data.js';
import { el, fmt2, fmtPct, fmt0, dirOf, dailyChg } from './common.js';

const SOURCE_CN = { tencent: '腾讯K线', csindex: '中证官网', cnindex: '国证官网' };

/* 每只指数的简要介绍 + 注意（源自《红利介绍.md》/《红利指数与ETF成分股.md》） */
const INTROS = {
  '000922': { intro: '从沪深A股中选取三年连续分红、平均股息率最高的100只股票，全市场红利基准，跟踪资金规模最大。', note: '单一红利策略，银行/煤炭/交运等传统高股息行业权重高；股息率约5.5%，当其处于历史低位时说明估值偏高，性价比下降。' },
  '000015': { intro: '从上证180成分股中选取50只股息率最高的股票，沪市视角的红利基准（股息率约5.9%）。', note: '样本空间仅限上证180，银行权重较高，风格偏沪市大盘，与全市场红利有差异；由红利ETF华泰柏瑞（510880，约213亿）跟踪。' },
  '000821': { intro: '从沪深300成分股中选取50只股息率最高的股票，大盘红利视角，与中证红利做样本空间对比。', note: '样本空间为大盘蓝筹（沪深300），权重集中在金融/能源，风格更偏大盘价值。' },
  '000825': { intro: '从中央企业中选取股息率高、分红较稳定的50只证券，央企主题红利，近3年+20.1%。', note: '央企兼具政策属性与红利属性；行业集中于银行/建筑/能源，受央企考核与改革政策影响。' },
  'H30269': { intro: '红利+低波动双因子，每年12月调仓一次，银行权重约50%，跟踪规模全市场红利第一（约482亿）。', note: '银行权重高，金融行业景气直接决定指数表现；年度调仓换手成本低，但对风格变化响应慢。' },
  '930955': { intro: '红利+低波动双因子，季度调仓，行业均衡（银行约20%），与H30269构成低波系两条参照线。', note: '与H30269核心差异在行业结构与调仓频率：更均衡、响应更快，但调仓换手成本更高。' },
  '932315': { intro: '选取50只连续分红、股息率较高且盈利持续性较好的证券，去金融化的红利质量代表，近1年+15.5%。', note: '前五大行业为食品饮料/有色/传媒/计算机/医药，不含银行股；成长风格占优时表现更好，质量因子可能阶段性跑输传统红利。' },
  '931468': { intro: '红利质量另一编制口径（与932315不同），近3年+23.6%，可与932315对照参考。', note: '与932315编制逻辑不同、业绩走势有差异；跟踪产品（159758）规模偏小。' },
  'H30270': { intro: '在高股息基础上挑选低PE/低PB的股票，深度价值风格，策略维度与其余指数不重叠。', note: '深度价值因子独一份；价值风格长期跑输成长风格的阶段会明显落后。' },
  '980092': { intro: '国证自由现金流指数（国证指数公司编制）：剔除成交额后20%、金融/房地产行业及近12季度ROE稳定性后10%的证券，选取近一年自由现金流率最高的100只构成；季度调样、单只权重上限10%（调整后自由流通市值加权）。', note: '华夏自由现金流ETF（159201，规模约173亿）跟踪本指数；官网仅披露前十大权重（约54%），其余90只权重未公开；行业口径为国证分类（工业/可选消费/能源为主），与申万口径不同；历史行情数据源为国证官网（2012年起）。' },
  '000151': { intro: '从沪市国有企业中选取股息率高、分红较稳定的50只证券，为红利国企ETF国泰（510720）跟踪标的，非精选池补充参考。', note: '官网样本文件未公开，成分数据源受限（东财口径仅30只，官方为50只）；仅作主题对照。' },
};

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
      intros: INTROS,
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
