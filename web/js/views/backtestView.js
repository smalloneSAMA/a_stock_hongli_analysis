/* 回测报告视图：股息率分位信号回测结果（web/data/backtest.json）
   三档（p85/90/95）切换 + 汇总卡 + 明细表；数据由 scripts/_backtest_analysis.py 生成 */

import { el, renderTable, skeleton, errorBox, fmt2, getFavs } from './common.js';
import { loadJSON, BACKTEST_URL } from '../data.js';

const COLS = [
  { key: 'code', label: '代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
  { key: 'name', label: '名称', align: 'left', sortable: true },
  { key: 'type', label: '类型', align: 'center', sortable: true },
  { key: 'group', label: '分组', align: 'center', sortable: true },
  { key: 'n_buy', label: '信号数', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v) },
  { key: 'win6', label: '胜率6M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v + '%') },
  { key: 'win12', label: '胜率12M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v + '%') },
  { key: 'base6', label: '基准6M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
  { key: 'base12', label: '基准12M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
  { key: 'ex6', label: '超额6M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
  { key: 'ex12', label: '超额12M', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%') },
];

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton({ style: 'min-height:320px' }));
    try {
      const bt = await loadJSON(BACKTEST_URL);
      root.innerHTML = '';

      const head = el('div', { class: 'bt-head' },
        el('h2', { class: 'chart-title' }, '股息率分位信号回测报告'),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8;margin-top:4px' },
          `生成日期 ${bt.date} · 信号：dy 上穿 p 分位=买、下穿 ${100 - bt.order[0]}~${100 - bt.order[bt.order.length - 1]} 分位=卖（5年滚动窗口），次一交易日收盘执行；ETF 用跟踪指数序列`),
        el('div', { class: 'txt-3', style: 'font-size:11.5px;line-height:1.8' },
          `范围：全量 ${bt.scope ? bt.scope.n_total : ''} 标的（指数/ETF/推荐20/其他成份股/自选股） · 收益为价格口径（不含分红再投）；基准 = 同区间每日买入的平均收益；超额 = 信号组均值 − 基准`),
      );
      /* 阅读说明（默认折叠） */
      const guideBox = el('div', { class: 'bt-guide', style: 'display:none' },
        el('div', { class: 'g-step' },
          el('b', {}, '第 1 步 · 看汇总卡（策略整体灵不灵）'),
          el('br'),
          '· 有效标的 = 历史上至少出现过一次买入信号的标的数；其余标的近5年股息率从未进入历史最高分位（表格中显示 "—"），不代表策略失效',
          el('br'),
          '· 超额 = 信号收益 − 同期任意日买入的基准收益；正超额占比 >50% 说明信号有统计优势',
          el('br'),
          '· 重点分看「指数/ETF 12M超额」与「股票 12M超额」：本策略历来对指数/ETF 择时远强于个股'),
        el('div', { class: 'g-step' },
          el('b', {}, '第 2 步 · 切换 p85 / p90 / p95（阈值严一点会怎样）'),
          el('br'),
          '· p85 信号多而杂；p95 信号少但买点更极端（股息率更接近历史极值），平均超额通常更高',
          el('br'),
          '· 三档结论一致（均正超额）→ 策略较稳健；三档互相矛盾 → 谨慎看待'),
        el('div', { class: 'g-step' },
          el('b', {}, '第 3 步 · 看明细表（具体哪只标的信号灵）'),
          el('br'),
          '· 默认按超额12M降序；务必结合信号数读胜率——信号不足5次的高胜率不足为信',
          el('br'),
          '· 红色为负超额（该标的信号历史上反而跑输基准）；表格可排序、翻页、跳页'),
        el('div', { class: 'g-note' },
          '口径与局限：价格口径不含分红再投（红利标的真实收益更高，信号与基准同口径比较公平）；卖出 = dy 分位跌回历史最低10%，不设时间止损，极端行情持有期可能较长；ETF 用跟踪指数序列（自身K线太短）。本报告为历史统计，非投资建议。'),
      );
      const guideBtn = el('button', { class: 'bt-guide-btn', onclick: () => {
        const show = guideBox.style.display === 'none';
        guideBox.style.display = show ? '' : 'none';
        guideBtn.classList.toggle('open', show);
      } }, '❓ 如何阅读本报告');
      const presetBar = el('div', { class: 'seg-group', style: 'margin-top:10px' },
        bt.order.map(p => el('button', { class: 'seg-btn' + (p === 90 ? ' active' : ''), onclick: () => render(p) }, 'p' + p)));
      const sumCard = el('div', { class: 'bt-summary' });
      const groupTitle = el('div', { class: 'txt-3', style: 'font-size:11px;margin:12px 2px 0' }, '分组统计（有效数 · 基准12M · 12M 平均超额 · 12M 正超额占比）');
      const groupCard = el('div', { class: 'bt-summary' });
      const insightEl = el('div', { class: 'bt-insight' });
      /* 明细表工具行：左侧条数（含收藏过滤后数量），右侧“只看收藏”标签 */
      const tableToolbar = el('div', { class: 'table-toolbar' });
      const favInput = el('input', { type: 'checkbox', 'aria-label': '只看收藏' });
      const favLabel = el('label', { class: 'check-toggle fav-only-toggle', style: 'margin-top:0' },
        favInput, el('span', {}, '只看收藏'));
      const tableBox = el('div', {});
      root.append(head, guideBtn, guideBox, presetBar, sumCard, groupTitle, groupCard, insightEl, tableToolbar, tableBox);

      let tableApi = null;
      let currentP = 90;   // 当前档位（收藏联动刷新用）
      function render(p) {
        currentP = p;
        for (const b of presetBar.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.textContent === 'p' + p);
        const rows = bt.by_p[String(p)] || [];
        const s = bt.summary[String(p)] || {};
        /* 汇总卡 */
        sumCard.innerHTML = '';
        const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');
        const cells = [
          ['有效标的', s.n + ' 个', ''],
          ['6M正超额', pct(s.pos6, s.n), ''],
          ['12M正超额', pct(s.pos12, s.n), ''],
          ['平均超额6M', s.avg6 == null ? '—' : (s.avg6 >= 0 ? '+' : '') + s.avg6 + '%', s.avg6 > 0 ? 'up' : 'down'],
          ['平均超额12M', s.avg12 == null ? '—' : (s.avg12 >= 0 ? '+' : '') + s.avg12 + '%', s.avg12 > 0 ? 'up' : 'down'],
          ['指数12M超额', s.idx12 == null ? '—' : (s.idx12 >= 0 ? '+' : '') + s.idx12 + '%', 'up'],
          ['股票12M超额', s.stk12 == null ? '—' : (s.stk12 >= 0 ? '+' : '') + s.stk12 + '%', s.stk12 > 0 ? 'up' : 'down'],
        ];
        for (const [k, v, cls] of cells) {
          sumCard.append(el('div', { class: 'bt-cell' },
            el('div', { class: 'txt-3', style: 'font-size:11px' }, k),
            el('div', { class: 'bt-val ' + (cls === 'up' ? 'txt-up' : cls === 'down' ? 'txt-down' : '') }, v)));
        }
        /* 分组卡（指数/ETF/推荐20/其他成份股/自选股，与股票历史板块分组呼应） */
        groupCard.innerHTML = '';
        const gs = s.groups || {};
        for (const [g, v] of Object.entries(gs)) {
          const gCls = v.avg12 == null ? '' : (v.avg12 > 0 ? 'txt-up' : (v.avg12 < 0 ? 'txt-down' : ''));
          const bCls = v.base12 == null ? '' : (v.base12 >= 0 ? 'txt-up' : 'txt-down');
          groupCard.append(el('div', { class: 'bt-cell' },
            el('div', { class: 'txt-3', style: 'font-size:11px' }, g),
            el('div', { class: 'bt-val' }, v.n + ' 个'),
            el('div', { class: 'txt-3', style: 'font-size:10.5px;line-height:1.7' },
              '基准12M ', el('span', { class: bCls }, v.base12 == null ? '—' : (v.base12 >= 0 ? '+' : '') + fmt2(v.base12) + '%'),
              ' · 12M ', el('span', { class: gCls }, v.avg12 == null ? '—' : (v.avg12 >= 0 ? '+' : '') + fmt2(v.avg12) + '%'),
              ' · 正超额 ' + (v.n ? Math.round(v.pos12 / v.n * 100) + '%' : '—'))));
        }
        /* 本档解读（中性描述，随档位切换刷新） */
        insightEl.innerHTML = '';
        const num = (v) => el('b', { class: (v || 0) > 0 ? 'txt-up' : (v || 0) < 0 ? 'txt-down' : '' }, (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v) + '%'));
        const l1 = el('div', {}, '有效标的 ', el('b', {}, s.n + ' 个'), `：6M 正超额 ${pct(s.pos6, s.n)}、12M 正超额 ${pct(s.pos12, s.n)}；平均超额 12M `, num(s.avg12), '（基准 = 同区间每日买入平均收益）');
        const l2 = el('div', {}, '指数/ETF：12M 平均超额 ', num(s.idx12));
        const l3 = el('div', {}, '股票：12M 平均超额 ', num(s.stk12));
        const skipped = (bt.by_p[String(p)] || []).filter(r => r.skip).length;
        const l4 = skipped ? el('div', {}, `另有 ${skipped} 只标的无买入信号（近5年股息率未进入历史高分位）`) : null;
        const l5 = el('div', { class: 'g-note' }, '历史统计结果，非投资建议；可结合区间分析当前分位与买卖锚综合判断');
        insightEl.append(l1, l2, l3);
        if (l4) insightEl.append(l4);
        insightEl.append(l5);
        /* 明细表（复用 renderTable；skip 行数字列显示 —；只看收藏过滤收藏标的） */
        tableBox.innerHTML = '';
        const favOnly = favInput.checked;
        const favs = new Set(getFavs());
        const rows2 = favOnly ? rows.filter(r => favs.has(r.code)) : rows;
        tableApi = renderTable(tableBox, { columns: COLS, rows: rows2, pageSize: 20 });
        tableApi.sortBy('ex12', -1);
        tableToolbar.innerHTML = '';
        tableToolbar.append(
          el('span', { class: 'txt-3', style: 'font-size:11.5px' }, `明细表 · 有效 ${rows2.length}${favOnly ? ' / ' + rows.length : ''} 条`),
          el('span', { style: 'flex:1' }), favLabel);
      }
      render(90);
      /* 收藏变化：勾选状态下列表联动刷新（星标自身状态由 favStar 组件同步） */
      favInput.addEventListener('change', () => { favLabel.classList.toggle('on', favInput.checked); render(currentP); });
      window.addEventListener('fav-change', () => { if (favInput.checked) render(currentP); });
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox(`回测报告加载失败：${err.message}（数据由 python scripts/_backtest_analysis.py 生成）`, () => this.mount(root)));
    }
  },
};
