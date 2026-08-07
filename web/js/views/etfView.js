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

/* 每只 ETF 的简要介绍 + 注意（源自《红利介绍.md》，规模/业绩为 2026-08-02 快照） */
const INTROS = {
  '512890': { intro: '跟踪中证红利低波动（H30269），全市场规模最大的红利ETF（约348亿），日成交约11亿，流动性碾压同类。', note: '跟踪指数银行权重约50%；规模最大、流动性最好，但费率非最低档（易方达系 0.15%/年 更低）。' },
  '515180': { intro: '跟踪中证红利（000922），中证红利系规模第一（约193亿），管理费率 0.15%/年（全场最低档）。', note: '跟踪全市场红利基准，银行/煤炭权重高；费率优势明显，适合长期持有定投。' },
  '563020': { intro: '跟踪中证红利低波动（H30269），同指数第二大产品（约134亿），费率 0.15%/年。', note: '与512890同指数，费率更低但规模小约六成；银行权重约50%的结构与H30269一致。' },
  '515080': { intro: '跟踪中证红利（000922），老牌代表（约122亿），规模与成交均衡，近3年+28.5%。', note: '与515180同指数，选择时对比费率与流动性即可（招商费率非最低档）。' },
  '159549': { intro: '跟踪红利低波动100（930955），该指数唯一主流产品（约63亿），行业均衡、季度调仓。', note: '930955 行业均衡（银行约20%）风格响应快；但日成交仅约0.12亿，流动性偏弱，大资金注意冲击成本。' },
  '561580': { intro: '跟踪中证央企红利（000825），央企主题，近3年+46.6%全场最佳（约28亿），近1年+7.8%。', note: '央企主题兼具政策属性；行业集中于银行/建筑/能源，波动与政策相关性高。' },
  '510720': { intro: '跟踪上证国有企业红利（000151），月月分红特色（约24亿），近1年+7.5%。', note: '月度分红机制依赖基金管理人分红政策，实际分红节奏以公告为准；跟踪指数成分数据源受限。' },
  '159209': { intro: '跟踪中证全指红利质量（932315），质量策略代表（约24亿），近1年+15.5%近期最强。', note: '不含银行股、成长属性强，成长风格占优时表现好，风格切换时回撤可能大于传统红利。' },
  '159758': { intro: '跟踪中证红利质量（931468），该口径唯一产品（约16亿），近3年+23.6%。', note: '规模偏小、流动性一般；与932315口径差异需理解，勿与159209简单对比。' },
  '563700': { intro: '跟踪中证红利价值（H30270），深度价值维度独一份（约4.3亿），近1年+2.3%。', note: '规模仅约4.3亿、日成交约0.04亿，流动性差，大资金慎入；价值风格长期跑输阶段会落后。' },
  '159201': { intro: '跟踪国证自由现金流（980092），自由现金流赛道规模第一的ETF（约173亿），日成交约5亿流动性优秀，近1年+8.6%。', note: '成分剔除金融/房地产，按近一年自由现金流率选100只，行业偏工业/可选消费/能源，与红利策略重叠度低；策略历史较短（2025年上市），周期特性待验证。' },
};

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
        scale: i.scale,             // 规模（亿元，腾讯实时，缺失则不显示）
      })),
      chartUnit: '元',
      subControl: 'none',
      intros: INTROS,
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
