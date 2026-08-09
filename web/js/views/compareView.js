/* 视图：对比分析（同类对比：指数/ETF/股票各自内部多选，归一化净值同图观察趋势关系）
   数据全部来自现有缓存（klineUrl 直读 /cache/），零后端改动 */

import { loadJSON, klineUrl, indiUrl, MANIFEST_URL, ANALYSIS_URL } from '../data.js';
import { el, fmt2, fmtSigned, dirOf, fmtScale, skeleton, errorBox, emptyState, attachSearchHistory, favStar, isFav } from './common.js';
import { cssVar } from '../theme.js';

const MAX = 8;   // 最多同时对比的标的数
const KIND = { index: '指数', etf: 'ETF', stock: '股票' };
const PALETTE = ['#60A5FA', '#818CF8', '#F87171', '#F472B6', '#34D399', '#FBBF24', '#22D3EE', '#A78BFA'];
const RANGES = [['all', '全部'], ['5y', '5年'], ['3y', '3年'], ['1y', '1年']];
const WIN_N = { '5y': 1250, '3y': 750, '1y': 250 };

/* 各图表 tab 的使用说明（ⓘ 按钮展开 + 速记行常驻） */
const TAB_HELP = {
  nav: {
    tip: '各标的归一化到共同起点=100 的累计涨幅，线高=涨幅大；与绝对净值无关',
    what: '所有标的归一化到共同起点=100 后的累计涨幅对比。线高=涨得多，与绝对净值高低无关。',
    how: [
      '线越高=自起点涨幅越大；两线交叉=涨幅反超时点，可回看该时点发生了什么',
      '左上角浮层：无光标=自起点累计；悬停/点击/方向键=该日期→最新的区间涨幅',
      '切换 5年/3年/1年 可看近期强弱',
    ],
    note: [
      '股票请开"含分红"：K线为不复权价，分红除权日会跳空，不开会低估分红多的股票',
      '净值低≠差：分红会把单位净值分瘦，收益看涨幅（含分红）',
    ],
  },
  dy: {
    tip: '各标的 TTM 股息率（%）曲线：横向比分红收益率，纵向看自身历史高低',
    what: '各标的 TTM 股息率（近12个月每股派息÷价格）曲线。横向比分红收益率，纵向看自身历史位置。',
    how: [
      '横向：曲线越高=当前分红收益率越高',
      '纵向：曲线越高=相对自身历史越便宜（价格跌或分红增）',
      '曲线陡升往往是股价下跌所致，可结合回撤 tab 判断是否为“跌出来的高股息”',
    ],
    note: [
      '不同标的的股息率绝对值不可直接比贵贱：分红率政策不同（赚10块分9块 vs 分3块）',
      'ETF 股息率为跟踪指数加权/季报持仓估算，个股为真实 TTM 口径',
    ],
  },
  dd: {
    tip: '水下回撤 = 当前价距历史高点的跌幅，只画水下部分；线越低=坑越深',
    what: '水下回撤 = 当前价距历史高点（峰值）的跌幅，只画“水下”部分，比谁抗跌。',
    how: [
      '线越低=坑越深；同一段行情比谁的坑浅',
      '看爬坑速度：先回到 0 附近=恢复快',
      '曲线末端=当前距前高还有多远（判断是否仍在“水下”）',
    ],
    note: [
      '统一为价格口径（不含分红）：分红股的实际体验比图上好（分红已落袋）',
      '高收益往往伴随深回撤，需与净值 tab 合看判断“值不值”',
    ],
  },
  bars: {
    tip: '分区间（1月/3月/1年/3年/年初至今）涨幅对比，看强弱的时间结构',
    what: '分区间（1月/3月/1年/3年/年初至今）涨幅柱状图，看强弱的时间结构。',
    how: [
      '横向：同一区间内谁强谁弱',
      '纵向：单标的不同区间对比——近强远弱=短期反转/补涨，持续强=趋势延续',
      '“年初至今”=今年以来的累计涨幅',
    ],
    note: [
      '区间为价格口径（与净值 tab 当前口径一致）；共同窗口不足的区间显示“—”',
      '柱高是涨幅不是绝对值',
    ],
  },
  rs: {
    tip: '以第一个选中的标的为基准（=100 虚线），>100 跑赢基准；看斜率不看位置',
    what: '以第一个选中的标的为基准（=100 虚线），其余标的 = 自身÷基准×100，>100 跑赢基准。',
    how: [
      '看斜率不看位置：持续上行=正在走强（即使 <100 也是边际改善）',
      '想换基准：把想比较的标的放第一位（先选它）',
      '结合净值 tab 的交叉点验证强弱反转',
    ],
    note: [
      '这是相对比值不是收益率：100 上下的涨跌不代表标的本身盈亏',
    ],
  },
  corr: {
    tip: '日收益相关系数（-1~1）：>0.7 高相关≈二选一，<0.3 低相关可分散配置',
    what: '日收益相关系数矩阵（-1~1）：1=完全同涨同跌，0=无关，-1=反向。下方配对表含“近1年”列。',
    how: [
      '高相关（>0.7）：同涨同跌，配置上≈二选一，同时持有分散效果差',
      '低相关（<0.3）：可同时持有分散风险',
      '对比“全窗口 vs 近1年”：相关性漂移=两者关系正在变化',
    ],
    note: [
      '相关≠因果；高相关不代表涨跌幅相同（β 不同）',
      '共同样本不足 30 个交易日显示“—”',
    ],
  },
  trk: {
    tip: 'ETF 净值 vs 跟踪指数归一化（虚线=指数基准），年化跟踪误差越小=复制越准',
    what: 'ETF 净值与跟踪指数归一化对比，虚线=指数基准，看跟踪精度。',
    how: [
      '年化跟踪误差越小=复制越准',
      '累计偏离（净值/指数−1）持续为负=长期跑输指数',
    ],
    note: [
      '仅对比 ETF 时出现；净值口径已剔除折溢价',
    ],
  },
};

export default {
  async mount(root) {
    root.innerHTML = '';
    const m = await loadJSON(MANIFEST_URL);
    const toItem = (x, type) => ({ code: x.code, name: x.name, type, price: x.last_close, chg: x.last_chg, scale: x.scale, dy: x.last_dy, ind: x.ind || '' });
    const allItems = {
      index: m.indices.map(x => toItem(x, 'index')),
      etf: m.etfs.map(x => toItem(x, 'etf')),
    };
    const st = m.stocks || [];
    const stockGroups = [
      { label: '推荐20', items: st.filter(s => s.rec).map(x => toItem(x, 'stock')) },
      { label: '自选股', items: st.filter(s => s.watch && !s.rec).map(x => toItem(x, 'stock')) },
      { label: '其他', items: st.filter(s => !s.rec && !s.watch).map(x => toItem(x, 'stock')) },
    ];

    /* ── 状态 ── */
    let curType = 'index';      // index / etf / stock
    let curGroup = 0;           // 股票分组 tab
    let indFilter = '';         // 行业筛选（'' = 全部；全量跨分组）
    let query = '';
    const selected = new Map(); // code -> item（已选）
    const order = [];           // 选择顺序（chips 展示序）

    /* ── DOM ── */
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '对比分析'),
      el('div', { class: 'txt-3', style: 'font-size:12px' },
        '同类对比：指数↔指数 / ETF↔ETF / 股票↔股票，归一化净值同图观察趋势关系（最多 ' + MAX + ' 只）')));

    const typeTabs = el('div', { class: 'seg-group', role: 'group', 'aria-label': '对比类型' });
    const presetBox = el('div', { class: 'cmp-presets' });
    const chipsEl = el('div', { class: 'cmp-chips' });
    const btnClear = el('button', { class: 'seg-btn', disabled: true }, '清空');
    const btnGo = el('button', { class: 'cmp-go', disabled: true }, '开始对比');
    const toolbar = el('div', { class: 'cmp-toolbar' },
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, typeTabs, presetBox),
      el('div', { class: 'cmp-toolbar-right' }, chipsEl, el('div', { class: 'cmp-actions' }, btnClear, btnGo)));

    const searchBox = el('input', { class: 'ticker-search', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索标的' });
    const tabsWrap = el('div', { class: 'cmp-groups' });
    /* 行业筛选下拉（股票 tab：全量股票池 ∩ 行业，跨分组；位于搜索框右侧，与股票历史板块同布局） */
    const inds = [...new Set(st.map(s => s.ind).filter(Boolean))].sort();
    const indSel = el('select', { class: 'ind-filter', 'aria-label': '行业筛选', title: '按一级行业筛选全部股票' },
      el('option', { value: '' }, '全部行业'),
      inds.map(x => el('option', { value: x }, x)));
    const searchRow = el('div', { class: 'cmp-search-row' }, searchBox, indSel);
    const listEl = el('ul', { class: 'ticker-list' });
    const listPanel = el('div', { class: 'card cmp-list-panel' }, searchRow, tabsWrap, listEl);

    const mainEl = el('div', { class: 'card cmp-main' },
      el('div', { class: 'empty-state', style: 'padding:64px 16px' },
        '选择 ≥2 只同类标的，点击「开始对比」查看归一化净值走势'));
    const body = el('div', { class: 'cmp-body' }, listPanel, mainEl);

    root.append(el('div', { class: 'card cmp-panel' }, toolbar, body));

    /* ═══ 对比图表（步骤2：归一化净值同图）═══ */
    let chartApi = null;
    let navMode = true;      // ETF 净值/场内价
    let divMode = false;     // 含分红模式
    let rangeKey = 'all';
    let chartTab = 'nav';    // nav 净值 / dy 股息率 / dd 回撤 / bars 涨跌幅 / rs 相对强弱 / corr 相关矩阵 / trk 跟踪偏离
    let cmp = null;          // 已加载数据 {dates, aligned, tracks}
    const rangeBtns = [];

    /* ── 净值图左上角累计涨跌浮层的键盘支持（window 级仅绑定一次；floatCtx 由 buildMain 刷新）── */
    let floatCtx = null;
    const kbdMove = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (chartTab !== 'nav' || !floatCtx) return;
      const ctx = floatCtx;
      if (!ctx.chartEl.offsetWidth || !ctx.chartEl.offsetHeight) return;   // 视图隐藏/未布局时不响应
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      const n = ctx.dates.length;
      if (!n) return;
      if (ctx.keyIdx < 0) ctx.keyIdx = ctx.mouseIdx >= 0 ? ctx.mouseIdx : n - 1;   // 无锚定时从鼠标位置/最新日期开始
      const next = e.key === 'ArrowRight' ? ctx.keyIdx + 1 : ctx.keyIdx - 1;
      if (next < 0 || next >= n) return;
      ctx.keyIdx = next;
      ctx.updateFloat(next);
      ctx.chartApi.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: next });
      const z = ctx.chartApi.getOption().dataZoom[0] || {};
      const s = Math.round((z.start ?? 0) / 100 * (n - 1));
      const en = Math.round((z.end ?? 100) / 100 * (n - 1));
      const span = Math.max(1, en - s);
      let dz = null;
      if (next > en) dz = { startValue: ctx.dates[next - span], endValue: ctx.dates[next] };
      else if (next < s) dz = { startValue: ctx.dates[next], endValue: ctx.dates[Math.min(n - 1, next + span)] };
      if (dz) ctx.chartApi.dispatchAction({ type: 'dataZoom', ...dz });
    };
    window.addEventListener('keydown', kbdMove);

    /* ⓘ 使用说明：per-tab 展开状态 + 卡片 DOM 引用（buildMain 重建时按状态恢复） */
    const helpOpen = {};
    let helpBtnEl = null, helpCardEl = null;
    const closeHelp = () => {
      helpOpen[chartTab] = false;
      if (helpBtnEl) helpBtnEl.classList.remove('active');
      if (helpCardEl) { helpCardEl.remove(); helpCardEl = null; }
    };
    const buildHelpCard = (h) => el('div', { class: 'cmp-help-card' },
      el('div', { class: 'cmp-help-sec' }, el('div', { class: 'cmp-help-label' }, '这是什么'), el('div', {}, h.what)),
      el('div', { class: 'cmp-help-sec' }, el('div', { class: 'cmp-help-label' }, '怎么看'), el('ul', {}, h.how.map(t => el('li', {}, t)))),
      el('div', { class: 'cmp-help-sec' }, el('div', { class: 'cmp-help-label' }, '注意'), el('ul', {}, h.note.map(t => el('li', {}, t)))));
    /* 点击卡片/ⓘ/视图切换按钮不关闭；其余外部点击关闭（视图切换由 buildMain 按 helpOpen 恢复） */
    document.addEventListener('click', (e) => {
      if (!helpOpen[chartTab]) return;
      const t = e.target;
      if (t && t.closest && t.closest('.seg-btn, .cmp-gtab, .cmp-help-btn, .cmp-help-card')) return;
      closeHelp();
    });

    /* 开始对比：拉数据 → 共同起点对齐 → 归一化 → 图表 */
    async function renderCompare() {
      if (order.length < 2) return;
      mainEl.innerHTML = '';
      mainEl.append(skeleton());      try {
        const items = order.map(code => selected.get(code));
        const series = [];
        /* 股息率序列：指数/ETF 读 analysis_dy.json（series），股票读指标文件 dy 列 */
        const dyAll = items.some(it => it.type !== 'stock') ? await loadJSON('/cache/analysis_dy.json') : null;
        const an = await loadAnalysis();   // 拿 ETF track（同跟踪偏离用）
        const tracks = new Map();          // track -> {rows, name}（ETF 同跟踪指数，参考线用）
        for (const it of items) {
          const obj = await loadJSON(klineUrl(KIND[it.type], it.code));
          const rows = (obj && obj.rows) || [];
          if (!rows.length) throw new Error(`${it.name}（${it.code}）缓存无数据`);
          /* ETF 跟踪指数：同 track 偏离分析的参考基准（不算对比标的，灰色虚线） */
          const ent = an.by_code[it.code];
          const track = it.type === 'etf' && ent ? ent.track : null;
          if (track && !tracks.has(track)) {
            try {
              const tobj = await loadJSON(klineUrl('指数', track));
              const idxx = m.indices.find(x => x.code === track);
              tracks.set(track, { rows: (tobj && tobj.rows) || [], name: (idxx && idxx.name) || track });
            } catch { tracks.set(track, { rows: [], name: track }); }
          }
          /* 股票：含分红重建需要分红缓存（ex_date/bonus10），缺失则退化为价格 */
          let divRows = null;
          if (it.type === 'stock') {
            try {
              const d = await loadJSON('/cache/分红_' + it.code + '.json');
              divRows = (d && d.rows) || null;
            } catch { divRows = null; }
          }
          /* dy 序列（原始 [date, dy] 对，对齐在下方统一处理） */
          let dyPts = null;
          if (it.type === 'stock') {
            try {
              const ind = await loadJSON(indiUrl(it.code));
              dyPts = (ind || []).filter(r => r.dy != null).map(r => [r.d, r.dy]);
            } catch { dyPts = null; }
          } else {
            const e = dyAll ? dyAll[it.code] : null;
            dyPts = (e && e.series) || null;
          }
          series.push({ it, rows, divRows, dyPts, track });
        }
        /* 共同起点 = 各序列起始日期的最大值（保证窗口内全部有数据） */
        const start = series.reduce((mx, s) => (mx < s.rows[0].date ? s.rows[0].date : mx), '');
        const aligned = series.map(s => {
          const plainKey = s.it.type === 'etf' && navMode ? 'nav' : 'close';
          const rows = s.rows.filter(r => r.date >= start);
          /* 股票累计分红（升序事件流，除权日归属） */
          const cum = new Map();
          if (s.it.type === 'stock' && s.divRows && s.divRows.length) {
            const evts = [...s.divRows].sort((a, b) => (a.ex_date < b.ex_date ? -1 : 1));
            let c = 0, ei = 0;
            for (const r of rows) {
              while (ei < evts.length && evts[ei].ex_date <= r.date) { c += (evts[ei].bonus10 || 0) / 10; ei++; }
              cum.set(r.date, c);
            }
          }
          const pts = rows.map(r => {
            const plain = r[plainKey] ?? r.close;
            let div = null;
            /* 含分红口径：ETF 用累计净值（缺失断线，绝不回退 close——与 acc_nav 不可比）；股票用 价格+累计每股分红 */
            if (s.it.type === 'etf') div = r.acc_nav ?? r.nav ?? null;
            else if (s.it.type === 'stock') div = cum.has(r.date) ? plain + cum.get(r.date) : null;
            return { date: r.date, plain, div, nav: s.it.type === 'etf' ? (r.nav ?? null) : null };
          });
          const firstNav = pts.find(p => p.nav != null);
          if (!pts.length || !pts[0].plain) throw new Error(`${s.it.name} 起点无数据`);
          return { it: s.it, pts, basePlain: pts[0].plain, baseDiv: pts[0].div, baseNav: firstNav ? firstNav.nav : null, dyPts: s.dyPts, track: s.track };
        });
        /* 日期轴 = 共同起点后全部交易日并集（缺失填 null 断线） */
        const dateSet = new Set();
        for (const a of aligned) for (const p of a.pts) dateSet.add(p.date);
        const dates = [...dateSet].sort();
        const rows2 = aligned.map(a => {
          const mPlain = new Map(a.pts.map(p => [p.date, p.plain / a.basePlain * 100]));
          const mDiv = a.baseDiv ? new Map(a.pts.filter(p => p.div != null).map(p => [p.date, p.div / a.baseDiv * 100])) : null;
          const mDy = a.dyPts ? new Map(a.dyPts.filter(p => p[0] >= start).map(p => [p[0], p[1]])) : null;
          /* ETF 净值序列（跟踪偏离固定用净值，不随场内价切换） */
          const mNav = a.it.type === 'etf' && a.baseNav ? new Map(a.pts.filter(p => p.nav != null).map(p => [p.date, p.nav / a.baseNav * 100])) : null;
          /* 水下回撤（固定用 plain 价格口径）：v/峰值-1 */
          const vals = dates.map(d => mPlain.get(d) ?? null);
          const dd = [];
          let peak = -Infinity;
          for (const v of vals) {
            if (v == null) { dd.push(null); continue; }
            if (v > peak) peak = v;
            dd.push((v / peak - 1) * 100);
          }
          return { it: a.it, vals, valsDiv: mDiv ? dates.map(d => mDiv.get(d) ?? null) : null,
            dyVals: mDy ? dates.map(d => mDy.get(d) ?? null) : null, ddVals: dd,
            navVals: mNav ? dates.map(d => mNav.get(d) ?? null) : null, track: a.track };
        });
        /* 日收益序列（相关矩阵用；全窗口 + 近1年） */
        for (const r of rows2) {
          const rets = [null];
          for (let i = 1; i < r.vals.length; i++) {
            rets.push(r.vals[i] != null && r.vals[i - 1] != null ? r.vals[i] / r.vals[i - 1] - 1 : null);
          }
          r.rets = rets;
        }
        cmp = { dates, aligned: rows2, tracks };
        buildMain();
      } catch (err) {
        mainEl.innerHTML = '';
        mainEl.append(errorBox(`对比加载失败：${err.message}`, () => renderCompare()));
      }
    }

    /* ═══ 主区构建：图 tab + 工具条 + 各图分发 ═══ */
    const CHART_TABS = [['nav', '净值'], ['dy', '股息率'], ['dd', '回撤'], ['bars', '涨跌幅'], ['rs', '相对强弱'], ['corr', '相关性'], ['trk', '跟踪偏离']];
    const tabTitle = () => ({ nav: divMode && curType !== 'index' ? '归一化含分红净值（起点=100）' : '归一化净值（起点=100）',
      dy: '股息率对比（%）', dd: '水下回撤对比（%）', bars: '区间涨跌幅对比',
      rs: `相对强弱（基准：${order[0] ? selected.get(order[0]).name : ''}，>100=跑赢基准）`,
      corr: '日收益相关性矩阵（全窗口）', trk: '同跟踪 ETF 偏离（vs 跟踪指数）' }[chartTab]);

    /* 净值图 tooltip：显示当日涨跌（红涨绿跌，口径与当前显示序列一致：含分红/净值切换跟随） */
    const navTip = (params) => {
      const p0 = params && params[0];
      if (!p0 || p0.dataIndex == null) return '';
      const i = p0.dataIndex;
      const upC = cssVar('--up'), downC = cssVar('--down');
      const rows = params.map((p, k) => {
        const v = p.value;
        if (v == null) return null;
        const r = cmp.aligned[k];
        const arr = r && (divMode && curType !== 'index' ? (r.valsDiv || r.vals) : r.vals);
        let chg = null;
        if (arr && i > 0) {
          const prev = arr[i - 1];
          if (prev != null && prev > 0) chg = (v / prev - 1) * 100;
        }
        return '<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.75">'
          + `<span>${p.marker}${p.seriesName}</span>`
          + `<span style="font-variant-numeric:tabular-nums">${Number(v).toFixed(2)}`
          + (chg != null ? ` <b style="color:${chg >= 0 ? upC : downC}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b>` : '')
          + '</span></div>';
      }).filter(Boolean).join('');
      return `<div style="font-size:10.5px;color:${cssVar('--text-3')};margin-bottom:3px">${cmp.dates[i]}</div>` + rows;
    };

    function buildMain() {
      if (!cmp) return;
      mainEl.innerHTML = '';
      const n = cmp.dates.length;
      if (n < 250) {
        mainEl.append(el('div', { class: 'cmp-warn' }, `⚠ 共同窗口仅 ${n} 个交易日（不足1年），建议移除上市较晚的标的`));
      }
      const tabs = el('div', { class: 'seg-group', role: 'group', 'aria-label': '图表类型' },
        CHART_TABS.filter(([k]) => k !== 'trk' || (curType === 'etf' && cmp.tracks && cmp.tracks.size)).map(([k, lab]) => el('button', { class: 'seg-btn' + (k === chartTab ? ' active' : ''),
          onclick: () => { chartTab = k; buildMain(); } }, lab)));
      /* 工具条：ETF 净值/场内价切换（仅 ETF 对比）+ 含分红切换 + 时间范围 */
      const segNav = el('div', { class: 'seg-group', role: 'group' },
        ['净值', '场内价'].map((lab, i) => el('button', { class: 'seg-btn' + ((i === 0) === navMode ? ' active' : ''),
          onclick: () => { navMode = i === 0; buildMain(); } }, lab)));
      const divDisabled = curType === 'index';
      const segDiv = el('div', { class: 'seg-group', role: 'group' },
        ['价格', '含分红'].map((lab, i) => el('button', { class: 'seg-btn' + ((i === 1) === divMode ? ' active' : ''),
          disabled: (divDisabled && i === 1) || undefined, title: divDisabled ? '指数无含分红数据源（仅价格）' : null,
          onclick: () => { divMode = i === 1; buildMain(); } }, lab)));
      rangeBtns.length = 0;
      const segRange = el('div', { class: 'seg-group', role: 'group' }, RANGES.map(([key, label]) => {
        const b = el('button', { class: 'seg-btn' + (key === rangeKey ? ' active' : ''), onclick: () => setRange(key) }, label);
        rangeBtns.push([key, b]);
        return b;
      }));
      const bar = el('div', { class: 'cmp-chart-bar' },
        el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
          tabs,
          el('span', { class: 'cmp-chart-title' }, tabTitle()),
          el('button', { class: 'cmp-help-btn' + (helpOpen[chartTab] ? ' active' : ''), title: '使用说明', 'aria-label': '使用说明',
            onclick: () => {
              if (helpOpen[chartTab]) { closeHelp(); return; }
              helpOpen[chartTab] = true;
              helpBtnEl.classList.add('active');
              helpCardEl = buildHelpCard(TAB_HELP[chartTab]);
              chartEl.appendChild(helpCardEl);
            } }, 'ⓘ')),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          curType === 'etf' ? segNav : null,
          segDiv,
          segRange),
        el('div', { class: 'cmp-help-tip' }, (TAB_HELP[chartTab] || {}).tip || ''));
      const chartEl = el('div', { class: 'chart', style: 'height:460px;margin-top:8px' });
      chartEl.style.position = 'relative';
      mainEl.append(bar, chartEl);

      helpBtnEl = bar.querySelector('.cmp-help-btn');
      helpCardEl = null;
      if (helpOpen[chartTab]) {
        helpCardEl = buildHelpCard(TAB_HELP[chartTab]);
        chartEl.appendChild(helpCardEl);   // 切 tab/切口径重建后按记忆恢复展开
      }

      if (zoomOff) { zoomOff(); zoomOff = null; }   // 释放旧图表的 datazoom 订阅
      if (chartApi) { chartApi.dispose(); chartApi = null; }
      chartApi = echarts.init(chartEl);
      /* 统计表随 dataZoom 可见窗口动态更新（预设按钮/拖动滑块/键盘平移统一走此事件；rAF 节流） */
      let raf = 0;
      const onZoom = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const dz = chartApi.getOption().dataZoom[0] || {};
          renderStatTable(...windowIdx(dz.start ?? 0, dz.end ?? 100));
        });
      };
      chartApi.on('datazoom', onZoom);
      zoomOff = () => { chartApi.off('datazoom', onZoom); cancelAnimationFrame(raf); };

      /* ── 净值图左上角：累计涨跌浮层（无光标时=自起点累计；跟随鼠标/点击/方向键）── */
      if (chartTab === 'nav') {
        const floatEl = el('div', { class: 'cmp-float' });
        chartEl.appendChild(floatEl);
        const n = cmp.dates.length;
        const arrOf = (r) => (divMode && curType !== 'index' ? (r.valsDiv || r.vals) : r.vals);   // 与 series 同口径
        const upC = cssVar('--up'), downC = cssVar('--down');
        const ctx = { chartApi, chartEl, dates: cmp.dates, updateFloat: null, keyIdx: -1, mouseIdx: -1 };
        let lastFloatIdx = -2;
        const updateFloat = (i) => {
          if (i === lastFloatIdx) return;   // 无变化不重绘（mousemove 高频调用）
          lastFloatIdx = i;
          const arrs = cmp.aligned.map(r => arrOf(r));
          const lis = arrs.map(a => { let j = a.length - 1; while (j > 0 && a[j] == null) j--; return j; });
          const lastDate = cmp.dates[Math.max(...lis)];
          const rows = cmp.aligned.map((r, k) => {
            const arr = arrs[k];
            const last = arr[lis[k]];
            if (last == null) return null;
            let base = 100;   // 归一化起点=100（自起点口径）
            if (i >= 0 && i < arr.length) base = arr[i];   // 光标口径：该日期 → 最新
            if (base == null || base <= 0) return null;
            const chg = (last / base - 1) * 100;
            return { name: r.it.name, chg, c: chg >= 0 ? upC : downC };
          }).filter(Boolean);
          if (!rows.length) { floatEl.style.display = 'none'; return; }
          const title = (i >= 0 ? cmp.dates[i] : '自起点') + ' → ' + lastDate;
          floatEl.innerHTML = '<div class="cmp-float-head">' + title + ' · 累计</div>'
            + rows.map(x => '<div class="cmp-float-row"><span class="cmp-float-name">' + x.name + '</span>'
              + '<span class="cmp-float-chg" style="color:' + x.c + '">' + (x.chg >= 0 ? '+' : '') + x.chg.toFixed(2) + '%</span></div>').join('');
          floatEl.style.display = 'block';
        };
        ctx.updateFloat = updateFloat;
        const pixelToIdx = (px, py) => {
          const r = chartApi.convertFromPixel({ seriesIndex: 0 }, [px, py]);
          if (r && Array.isArray(r) && typeof r[0] === 'number') return Math.max(0, Math.min(n - 1, Math.round(r[0])));
          return -1;
        };
        chartApi.getZr().on('mousemove', (e) => {
          const i = pixelToIdx(e.offsetX, e.offsetY);
          if (i >= 0) { updateFloat(i); if (ctx.keyIdx < 0) ctx.mouseIdx = i; }   // 键盘未锚定时跟随鼠标
        });
        chartApi.getZr().on('mouseout', () => updateFloat(-1));   // 移出图表恢复“自起点”
        chartApi.getZr().on('click', (e) => {
          const i = pixelToIdx(e.offsetX, e.offsetY);
          if (i >= 0) { ctx.keyIdx = i; chartApi.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i }); updateFloat(i); }
        });
        updateFloat(-1);   // 初始：自起点累计
        floatCtx = ctx;
      } else {
        floatCtx = null;
      }
      const names = cmp.aligned.map(r => r.it.name);
      const axis = cssVar('--text-3');
      const grid = cssVar('--grid-line');
      const base = {
        animation: false,
        legend: { top: 0, data: names, icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
        tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'),
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
        grid: { left: 52, right: 16, top: 36, bottom: 60 },
        xAxis: { type: 'category', data: cmp.dates, boundaryGap: false,
          axisLine: { lineStyle: { color: grid } }, axisLabel: { color: axis, fontSize: 10.5 }, axisTick: { show: false } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: axis, fontSize: 10.5 },
          splitLine: { lineStyle: { color: grid } } },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0 },
          { type: 'slider', xAxisIndex: 0, height: 16, bottom: 6, borderColor: 'transparent',
            backgroundColor: cssVar('--input-bg'), fillerColor: 'rgba(96,165,250,.12)',
            handleStyle: { color: cssVar('--brand') } },
        ],
      };
      const lineSeries = (dataArr) => cmp.aligned.map((r, i) => ({
        name: r.it.name, type: 'line', data: dataArr[i], showSymbol: false, sampling: 'lttb',
        lineStyle: { width: 1.6, color: PALETTE[i % PALETTE.length] },
        itemStyle: { color: PALETTE[i % PALETTE.length] },
      }));
      if (chartTab === 'dy') {
        base.yAxis.axisLabel.formatter = (v) => v.toFixed(2);
        base.tooltip.valueFormatter = (v) => (v == null ? '—' : Number(v).toFixed(2) + '%');
        chartApi.setOption({ ...base, series: lineSeries(cmp.aligned.map(r => r.dyVals)) });
      } else if (chartTab === 'dd') {
        base.yAxis.max = 0;
        base.tooltip.valueFormatter = (v) => (v == null ? '—' : Number(v).toFixed(2) + '%');
        chartApi.setOption({ ...base, series: lineSeries(cmp.aligned.map(r => r.ddVals)) });
      } else if (chartTab === 'bars') {
        buildBarsChart(chartApi, base);
      } else if (chartTab === 'rs') {
        buildRsChart(chartApi, base);
      } else if (chartTab === 'corr') {
        buildCorrChart(chartApi, base);
      } else if (chartTab === 'trk') {
        buildTrkChart(chartApi, base);
      } else {
        chartApi.setOption({ ...base, tooltip: { ...base.tooltip, formatter: navTip }, series: lineSeries(cmp.aligned.map(r => divMode && curType !== 'index' ? r.valsDiv : r.vals)) });
      }
      applyRange();
      renderDetailCards();
    }

    /* 相关性：全窗口 + 近1年 pairwise 日收益相关（两者都有值才参与） */
    function corrPair(retsA, retsB, n) {
      let cnt = 0, ma = 0, mb = 0;
      const a = retsA.slice(-n), b = retsB.slice(-n);
      for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) { ma += a[i]; mb += b[i]; cnt++; }
      if (cnt < 30) return null;
      ma /= cnt; mb /= cnt;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] != null && b[i] != null) {
          const x = a[i] - ma, y = b[i] - mb;
          sxy += x * y; sxx += x * x; syy += y * y;
        }
      }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
    }

    function buildCorrChart(chartApi, base) {
      const names = cmp.aligned.map(r => r.it.name);
      const n = cmp.aligned.length;
      const cells = [];
      const pairs = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const r = i === j ? 1 : corrPair(cmp.aligned[i].rets, cmp.aligned[j].rets, 1e9);
          cells.push([j, i, r == null ? 0 : +r.toFixed(3)]);
        }
        for (let j = i + 1; j < n; j++) {
          const rAll = corrPair(cmp.aligned[i].rets, cmp.aligned[j].rets, 1e9);
          const r1y = corrPair(cmp.aligned[i].rets, cmp.aligned[j].rets, 250);
          pairs.push({ a: names[i], b: names[j], rAll, r1y });
        }
      }
      pairs.sort((x, y) => (y.rAll ?? -2) - (x.rAll ?? -2));
      chartApi.setOption({
        animation: false,
        tooltip: { position: 'top', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'),
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          formatter: (p) => `${names[p.value[1]]} × ${names[p.value[0]]}<br/>相关系数 ${p.value[2].toFixed(3)}` },
        grid: { left: 110, top: 20, bottom: 50, right: 30 },
        xAxis: { type: 'category', data: names, splitArea: { show: true }, axisLabel: { color: cssVar('--text-2'), fontSize: 10.5, rotate: 25 },
          axisLine: { lineStyle: { color: base.xAxis.axisLine.lineStyle.color } } },
        yAxis: { type: 'category', data: names, splitArea: { show: true }, axisLabel: { color: cssVar('--text-2'), fontSize: 10.5 },
          axisLine: { lineStyle: { color: base.xAxis.axisLine.lineStyle.color } } },
        visualMap: { min: -1, max: 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, itemHeight: 90,
          text: ['1', '-1'], textStyle: { color: cssVar('--text-2'), fontSize: 10.5 },
          inRange: { color: [cssVar('--corr-low'), cssVar('--corr-mid'), cssVar('--corr-high')] } },
        series: [{ type: 'heatmap', data: cells, label: { show: true, fontSize: 10, color: cssVar('--text'),   // 主题主文字色：深色底亮字/浅色底深字，保证可读
          formatter: (p) => p.value[2].toFixed(2) },
          emphasis: { itemStyle: { borderColor: cssVar('--brand'), borderWidth: 1.5 } } }],
      });
      /* 配对排序表（全窗口 desc） */
      const tbl = el('table', { class: 'cmp-table' },
        el('thead', {}, el('tr', {}, ['标的对', '全窗口', '近1年'].map(c => el('th', {}, c)))),
        el('tbody', {}, pairs.map((p) => el('tr', {}, [
          el('td', {}, `${p.a} × ${p.b}`),
          el('td', {}, p.rAll == null ? '—' : p.rAll.toFixed(3)),
          el('td', {}, p.r1y == null ? '—' : p.r1y.toFixed(3)),
        ]))));
      const card = el('div', { class: 'card cmp-detail', style: 'margin-top:10px' },
        el('div', { class: 'cmp-detail-title' }, `配对相关性（共 ${pairs.length} 对，按全窗口降序）`),
        el('div', { style: 'overflow-x:auto' }, tbl));
      mainEl.append(card);
    }

    /* 同跟踪 ETF 偏离：净值归一化 vs 跟踪指数归一化（虚线基准）+ 跟踪误差表 */
    function buildTrkChart(chartApi, base) {
      const grpByTrack = new Map();
      for (const r of cmp.aligned) {
        if (r.it.type !== 'etf' || !r.track) continue;
        if (!grpByTrack.has(r.track)) grpByTrack.set(r.track, []);
        grpByTrack.get(r.track).push(r);
      }
      const series = [];
      const errRows = [];
      let si = 0;
      for (const [track, grp] of grpByTrack) {
        const t = cmp.tracks.get(track);
        const trows = (t && t.rows) || [];
        if (!trows.length) continue;
        const idxVals = cmp.dates.map(d => {
          const row = trows.find(x => x.date === d);
          return row && row.close ? row.close : null;
        });
        /* 指数归一化：以首个非 null 为基准 */
        let ibase = null;
        for (const v of idxVals) { if (v != null) { ibase = v; break; } }
        if (!ibase) continue;
        const idxNorm = idxVals.map(v => (v != null ? v / ibase * 100 : null));
        series.push({ name: `${track}（${(t && t.name) || track}）`, type: 'line', data: idxNorm, showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: cssVar('--text-3') }, itemStyle: { color: cssVar('--text-3') }, silent: true });
        for (const r of grp) {
          series.push({ name: r.it.name, type: 'line', data: r.navVals, showSymbol: false, sampling: 'lttb',
            lineStyle: { width: 1.6, color: PALETTE[si % PALETTE.length] }, itemStyle: { color: PALETTE[si % PALETTE.length] } });
          si++;
          /* 年化跟踪误差：净值日收益 vs 指数日收益（pairwise）的 std ×√252 */
          const a = r.navVals, b = idxNorm;
          const diffs = [];
          for (let i = 1; i < a.length; i++) {
            if (a[i] != null && a[i - 1] != null && b[i] != null && b[i - 1] != null) {
              diffs.push((a[i] / a[i - 1] - 1) - (b[i] / b[i - 1] - 1));
            }
          }
          let te = null;
          if (diffs.length > 30) {
            const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length;
            const sd = Math.sqrt(diffs.reduce((x, y) => x + (y - mean) * (y - mean), 0) / diffs.length);
            te = sd * Math.sqrt(252) * 100;
          }
          const lastA = a[a.length - 1], lastB = b[b.length - 1];
          const cumDev = lastA != null && lastB != null ? (lastA / lastB - 1) * 100 : null;
          errRows.push({ name: r.it.name, idx: (t && t.name) || track, te, cumDev });
        }
      }
      chartApi.setOption({ ...base, series });
      const tbl = el('table', { class: 'cmp-table' },
        el('thead', {}, el('tr', {}, ['ETF', '跟踪指数', '年化跟踪误差', '累计偏离（净值/指数-1）'].map(c => el('th', {}, c)))),
        el('tbody', {}, errRows.map(x => el('tr', {}, [
          el('td', {}, x.name), el('td', {}, x.idx),
          el('td', {}, x.te == null ? '—' : x.te.toFixed(2) + '%'),
          el('td', {}, x.cumDev == null ? '—' : (x.cumDev >= 0 ? '+' : '') + x.cumDev.toFixed(2) + '%'),
        ]))));
      mainEl.append(el('div', { class: 'card cmp-detail', style: 'margin-top:10px' },
        el('div', { class: 'cmp-detail-title' }, '跟踪误差（虚线=跟踪指数归一化，净值含折溢价剔除）'),
        el('div', { style: 'overflow-x:auto' }, tbl)));
    }

    /* 区间涨跌幅：x 轴 = 1月/3月/1年/3年/年初至今，每只股票一个 series（图例点击显隐，柱上标数值） */
    function buildBarsChart(chartApi, base) {
      const PERIODS = [['m1', '1月'], ['m3', '3月'], ['y1', '1年'], ['y3', '3年'], ['ytd', '年初至今']];
      const N = { m1: 21, m3: 63, y1: 250, y3: 750 };
      const rets = cmp.aligned.map(r => {
        const vals = r.vals;
        let li = vals.length - 1;
        while (li > 0 && vals[li] == null) li--;
        const last = vals[li];
        const at = (n) => { const v = vals[li - n]; return v ? last / v - 1 : null; };
        const row = {};
        for (const [k, n] of Object.entries(N)) row[k] = at(n);
        const curYear = cmp.dates[li].slice(0, 4);
        let ytd = null;
        for (let i = 0; i <= li; i++) {
          if (cmp.dates[i] >= curYear + '-01-01' && vals[i] != null) { ytd = last / vals[i] - 1; break; }
        }
        row.ytd = ytd;
        return row;
      });
      chartApi.setOption({
        ...base,
        grid: { left: 52, right: 16, top: 36, bottom: 60 },
        xAxis: { type: 'category', data: PERIODS.map(p => p[1]),
          axisLine: { lineStyle: { color: base.xAxis.axisLine.lineStyle.color } },
          axisLabel: { color: base.xAxis.axisLabel.color, fontSize: 11, interval: 0 },
          axisTick: { show: false } },
        dataZoom: [],
        yAxis: { type: 'value', axisLabel: { color: base.xAxis.axisLabel.color, fontSize: 10.5, formatter: (v) => (v * 100).toFixed(0) + '%' },
          splitLine: { lineStyle: { color: base.xAxis.axisLine.lineStyle.color } } },
        tooltip: { ...base.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          valueFormatter: (v) => (v == null ? '—' : (v * 100 >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%') },
        series: cmp.aligned.map((r, i) => ({
          name: r.it.name, type: 'bar', barMaxWidth: 26,
          data: PERIODS.map(([k]) => rets[i][k]),
          itemStyle: { color: PALETTE[i % PALETTE.length] },   // 不同颜色标识不同股票
          label: { show: true, position: 'top', fontSize: 9.5, color: cssVar('--text-2'),
            formatter: (p) => (p.value == null ? '' : (p.value >= 0 ? '+' : '') + (p.value * 100).toFixed(1) + '%') },
        })),
      });
    }

    /* 相对强弱：各标的 ÷ 基准标的（第一个选中）归一化比值，>100=跑赢 */
    function buildRsChart(chartApi, base) {
      const baseCode = order[0];
      const b = cmp.aligned.find(r => r.it.code === baseCode);
      if (!b) return;
      chartApi.setOption({
        ...base,
        yAxis: { ...base.yAxis, scale: false, min: 0 },
        series: [
          { name: b.it.name, type: 'line', data: cmp.dates.map(() => 100), showSymbol: false,
            lineStyle: { width: 1, color: cssVar('--grid-line'), type: 'dashed' },
            itemStyle: { color: cssVar('--grid-line') }, silent: true },
          ...cmp.aligned.filter(r => r.it.code !== baseCode).map((r, i) => ({
            name: r.it.name, type: 'line',
            data: r.vals.map((v, j) => (v != null && b.vals[j] != null ? v / b.vals[j] * 100 : null)),
            showSymbol: false, sampling: 'lttb',
            lineStyle: { width: 1.6, color: PALETTE[(i + 1) % PALETTE.length] },
            itemStyle: { color: PALETTE[(i + 1) % PALETTE.length] },
          })),
        ],
      });
    }

    function setRange(key) {
      rangeKey = key;
      for (const [k, b] of rangeBtns) b.classList.toggle('active', k === key);
      applyRange();
    }

    function applyRange() {
      if (!chartApi || !cmp) return;
      const n = cmp.dates.length;
      const win = WIN_N[rangeKey];
      const start = win && n > win ? (n - win) / n * 100 : 0;
      chartApi.dispatchAction({ type: 'dataZoom', start, end: 100 });
    }

    /* ═══ 步骤3/4：区间信号表 + 统计表（共同窗口）═══ */
    const bandOf = (s) => (s <= 25 ? '买入区间' : s <= 45 ? '逐步建仓' : s <= 65 ? '持有' : s <= 80 ? '逐步卖出' : '卖出区间');
    const bandCls = (b) => ({ '买入区间': 'band-buy', '逐步建仓': 'band-build', '持有': 'band-hold', '逐步卖出': 'band-sell', '卖出区间': 'band-sell2' }[b] || 'band-hold');
    let anCache = null;
    const loadAnalysis = async () => (anCache || (anCache = await loadJSON(ANALYSIS_URL)));

    /* ── 底部双卡：信号表（静态）+ 统计表（动态，随 dataZoom 可见窗口）── */
    let statBox = null;    // 右卡容器（renderDetailCards 创建，renderStatTable 填充）
    let zoomOff = null;    // datazoom 订阅（buildMain 重建时先释放）
    const tbl = (head, rows) => {
      const h = el('tr', {}, head.map(c => el('th', {}, c)));
      const trs = rows.map((cells) => el('tr', {}, cells.map(c => el('td', {}, c))));
      return el('table', { class: 'cmp-table' }, el('thead', {}, h), el('tbody', {}, trs));
    };
    const fmtPct2 = (v, dg) => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(dg == null ? 1 : dg) + '%');
    const windowIdx = (sPct, ePct) => {
      const n = cmp.dates.length;
      return [
        Math.max(0, Math.min(n - 1, Math.round((sPct ?? 0) / 100 * (n - 1)))),
        Math.max(0, Math.min(n - 1, Math.round((ePct ?? 100) / 100 * (n - 1)))),
      ];
    };

    /* 统计表：按可见窗口重算（所见即所得；口径与旧版一致，仅切片范围动态化） */
    function renderStatTable(si, ei) {
      if (!statBox || !cmp) return;
      const dates = cmp.dates;
      const nWin = ei - si + 1;
      const title = nWin < 60
        ? `统计对比（窗口仅 ${nWin} 个交易日，参考性低）`
        : `统计对比（${dates[si]} ~ ${dates[ei]} · ${nWin} 个交易日 · 无风险利率=0）`;
      const statRows = cmp.aligned.map((r) => {
        const vals = r.vals.slice(si, ei + 1).filter(v => v != null);
        if (vals.length < 2) return { it: r.it, ret: null };
        const n = vals.length;
        const ret = vals[n - 1] / vals[0] - 1;
        const ann = Math.pow(1 + ret, 252 / n) - 1;
        let sum = 0, ss = 0;
        for (let i = 1; i < n; i++) { const x = vals[i] / vals[i - 1] - 1; sum += x; ss += x * x; }
        const mean = sum / (n - 1);
        const vol = Math.sqrt(Math.max(0, ss / (n - 1) - mean * mean)) * Math.sqrt(252);
        let peak = vals[0], mdd = 0;
        for (const v of vals) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
        return { it: r.it, ret, ann, vol, mdd, sharpe: vol > 0 ? ann / vol : null, days: n };
      });
      const statTbl = tbl(['标的', '区间收益', '年化', '年化波动', '最大回撤', '夏普'],
        statRows.map(({ it, ret, ann, vol, mdd, sharpe }) => [it.name,
          ret == null ? '—' : fmtPct2(ret * 100, 1), ann == null ? '—' : fmtPct2(ann * 100, 1),
          vol == null ? '—' : (vol * 100).toFixed(1) + '%', mdd == null ? '—' : (mdd * 100).toFixed(1) + '%',
          sharpe == null ? '—' : sharpe.toFixed(2)]));
      statBox.innerHTML = '';
      statBox.append(el('div', { class: 'cmp-detail-title' }, title),
        el('div', { style: 'overflow-x:auto' }, statTbl));
    }

    /* 信号表（静态：analysis.json 固定 5 年口径）+ 双卡骨架；统计表由 renderStatTable 按可见窗口填充 */
    async function renderDetailCards() {
      const an = await loadAnalysis();
      const sigRows = [];
      for (const r of cmp.aligned) {
        const it = r.it;
        const ent = an.by_code[it.code];
        let sig = null;
        if (ent) {
          const sysKey = ent.type === '股票' ? 'B' : 'A';
          const w = an.presets['均衡'][sysKey];
          let s = 0, tot = 0;
          for (const k in w) {
            const f = ent.factors[k];
            if (f && f.pct != null) { s += f.pct * w[k]; tot += w[k]; }
          }
          const score = tot ? s / tot : null;
          const band = bandOf(score);
          const dyF = ent.factors.dy;
          const an2 = ent.anchors;
          let buy = an2 ? an2.buy : null;
          let sell = an2 ? an2.sell : null;
          /* ETF：anchors 为跟踪指数点位，按场内价/指数点位比例换算为 ETF 价格（同主图 analysisScale） */
          if (ent.type === 'ETF' && it.price != null && ent.factors.price && ent.factors.price.v) {
            const scale = it.price / ent.factors.price.v;
            if (buy != null) buy = buy * scale;
            if (sell != null) sell = sell * scale;
          }
          sig = { score, band,
            dy: dyF && dyF.v != null ? dyF.v : null,
            pct: dyF && dyF.pct != null ? dyF.pct : null,
            buy, sell,
            db: an2 ? an2.dist_buy : null, ds: an2 ? an2.dist_sell : null,   // 锚距为比例，ETF 换算后不变
            winStart: ent.win_start };   // 分位/锚窗口起点（近5年，上市不足5年用全部历史）
        }
        sigRows.push({ it, sig });
      }
      const winStarts = sigRows.map(r => r.sig && r.sig.winStart).filter(Boolean);
      const winTxt = winStarts.length && an.date
        ? Math.min(...winStarts) + ' ~ ' + an.date
        : '';
      const sigTbl = tbl(['标的', '区间信号', '均衡分', '股息率', '5年分位', '买入锚', '卖出锚'],
        sigRows.map(({ it, sig }) => sig
          ? [it.name, el('span', { class: 'ana-band ' + bandCls(sig.band) }, sig.band), fmt2(sig.score),
            sig.dy != null ? sig.dy.toFixed(2) + '%' : '—', sig.pct != null ? sig.pct.toFixed(1) : '—',
            sig.buy == null ? '—' : fmt2(sig.buy) + (sig.db != null ? '（' + fmtPct2(sig.db, 1) + '）' : ''),
            sig.sell == null ? '—' : fmt2(sig.sell) + (sig.ds != null ? '（' + fmtPct2(sig.ds, 1) + '）' : '')]
          : [it.name, el('span', { class: 'txt-3' }, '无分析数据'), '—', '—', '—', '—', '—']));
      const grid = el('div', { class: 'cmp-detail-grid' },
        el('div', { class: 'card cmp-detail' },
          el('div', { class: 'cmp-detail-title' }, '区间信号对比（数据 ' + (an.date || '—') + ' · 均衡档'
          + (winTxt ? ' · 近5年 ' + winTxt : '') + '）'),
          el('div', { style: 'overflow-x:auto' }, sigTbl)),
        el('div', { class: 'card cmp-detail' }, (statBox = el('div', {}))));
      mainEl.append(grid);
      /* 初始统计表：按当前 dataZoom 可见窗口（默认全量） */
      const dz = chartApi.getOption().dataZoom[0] || {};
      renderStatTable(...windowIdx(dz.start ?? 0, dz.end ?? 100));
    }


    /* ── 当前类型列表（含搜索/分组/行业筛选）──
       行业筛选生效或搜索时：全量跨分组匹配（附分组标签）；无筛选无搜索时按当前分组显示；
       fav（收藏）类型：全部已收藏标的（指数/ETF/股票，带类型/分组标签） */
    function currentItems() {
      let items;
      if (curType === 'fav') {
        /* 收藏 tab：跨类型合集，分组用短标签（省宽度给名称） */
        const grpOf = (g) => ({ '推荐20': '推荐', '自选股': '自选', '其他': '其他' }[g] || g);
        items = [...allItems.index.map(x => ({ ...x, grp: '指数' })),
          ...allItems.etf.map(x => ({ ...x, grp: 'ETF' })),
          ...stockGroups.flatMap(g => g.items.map(x => ({ ...x, grp: grpOf(g.label) })))]
          .filter(it => isFav(it.code));
      } else if (curType === 'stock' && (indFilter || query)) {
        items = stockGroups.flatMap(g => g.items.map(x => ({ ...x, grp: g.label })));
        if (indFilter) items = items.filter(it => it.ind === indFilter);
      } else if (curType === 'stock') {
        items = stockGroups[curGroup].items;
      } else {
        items = allItems[curType];
      }
      if (query) {
        const q = query.toLowerCase();
        items = items.filter(it => it.name.toLowerCase().includes(q) || it.code.includes(q));
      }
      return items;
    }

    function renderList() {
      listEl.innerHTML = '';
      const items = currentItems();
      if (!items.length) {
        listEl.append(el('li', { class: 'empty-state', style: 'padding:20px 8px' },
          curType === 'fav' && !query ? '暂无收藏（点击列表项 ★ 收藏标的）' : '无匹配标的'));
        return;
      }
      for (const it of items) {
        const sel = selected.has(it.code);
        /* 复用股票历史板块列表样式：名称行（含分组标签）+ 价格 + 代码 + 副信息；
           选中由打钩改为框选高亮（ticker-item.active）；ETF 不显示黄色规模小标签（副信息保留） */
        const nameBox = el('div', { class: 'ticker-name' },
          el('span', { class: 'ticker-name-text' }, it.name),
          it.grp ? el('span', { class: 'cmp-grp' }, it.grp) : null);
        nameBox.append(favStar(it.code));   // 收藏星标（跨板块同步）
        const subTxt = it.type === 'stock'
          ? curType === 'fav'
            ? (it.ind ? it.ind + '·' : '') + (it.dy != null ? it.dy.toFixed(2) + '%' : '—')   // 收藏 tab 精简：银行·4.70%
            : (it.ind ? it.ind + ' · ' : '') + (it.dy != null ? '股息率 ' + it.dy.toFixed(2) + '%' : '—')
          : (it.type === 'etf' && it.scale != null ? '规模 ' + fmtScale(it.scale) : '');
        const li = el('li', { class: 'ticker-item' + (sel ? ' active' : '') + (isFav(it.code) ? ' fav' : ''), role: 'button', tabindex: '0',
            'aria-label': it.name + it.code },
          nameBox,
          el('div', { class: 'ticker-price txt-' + dirOf(it.chg) }, it.price == null ? '—' : fmt2(it.price)),
          el('div', { class: 'ticker-code' }, it.code),
          el('div', { class: 'ticker-sub' }, subTxt ? el('span', { class: 'txt-3', style: 'font-size:' + (curType === 'fav' ? '9px' : '10.5px') }, subTxt) : null));
        const pick = () => toggle(it);
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        listEl.append(li);
      }
    }

    function renderGroupTabs() {
      tabsWrap.innerHTML = '';
      const show = curType === 'stock';
      tabsWrap.style.display = show ? '' : 'none';
      indSel.style.display = show ? '' : 'none';
      if (curType !== 'stock') return;
      stockGroups.forEach((g, i) => {
        tabsWrap.append(el('button', { class: 'cmp-gtab' + (i === curGroup && !indFilter ? ' active' : ''),
            disabled: !!indFilter || undefined,   // 行业筛选生效时分组 tab 禁用（列表为全量筛选结果）
            onclick: () => { curGroup = i; query = ''; searchBox.value = ''; renderGroupTabs(); renderList(); } },
          g.label, el('em', {}, g.items.length)));
      });
    }
    /* 收藏变化：收藏 tab 激活时列表联动刷新（星标自身状态由 favStar 组件同步） */
    window.addEventListener('fav-change', () => { if (curType === 'fav') renderList(); });
    /* 行业下拉联动：全量筛选（跨分组），分组 tab 禁用 */
    indSel.addEventListener('change', () => {
      indFilter = indSel.value;
      renderGroupTabs();
      renderList();
    });

    /* ── 已选 chips ── */
    function renderChips() {
      chipsEl.innerHTML = '';
      if (!order.length) {
        chipsEl.append(el('span', { class: 'txt-3', style: 'font-size:12px' }, '未选择标的'));
      }
      for (const code of order) {
        const it = selected.get(code);
        const chip = el('span', { class: 'cmp-chip' }, it.name,
          it.price != null
            ? el('span', { class: 'cmp-chip-price txt-' + dirOf(it.chg) }, fmt2(it.price))
            : null,
          el('i', { class: 'cmp-chip-x', role: 'button', 'aria-label': '移除' }, '×'));
        chip.querySelector('.cmp-chip-x').addEventListener('click', () => toggle(it));
        chipsEl.append(chip);
      }
      btnClear.disabled = !order.length;
      btnGo.disabled = order.length < 2;
    }

    /* ── 勾选/取消（上限保护）── */
    function toggle(it) {
      if (selected.has(it.code)) {
        selected.delete(it.code);
        order.splice(order.indexOf(it.code), 1);
      } else {
        if (order.length >= MAX) {
          btnGo.textContent = '最多对比 ' + MAX + ' 只';
          setTimeout(() => { btnGo.textContent = '开始对比'; }, 1200);
          return;
        }
        selected.set(it.code, it);
        order.push(it.code);
      }
      renderChips();
      renderList();
    }

    /* ── 类型切换（同类约束：切换即清空已选）── */
    function setType(t) {
      if (t === curType) return;
      curType = t;
      curGroup = 0;
      query = '';
      searchBox.value = '';
      selected.clear();
      order.length = 0;
      for (const b of typeTabs.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.t === t);
      renderPresets();
      renderGroupTabs();
      renderList();
      renderChips();
    }

    /* ── 预设组合（一键填充，同类内）── */
    function renderPresets() {
      presetBox.innerHTML = '';
      let presets = [];
      if (curType === 'index') presets = [['红利4指数', ['000922', '000015', '000825', 'H30269']]];
      else if (curType === 'etf') presets = [['低波双胞胎', ['512890', '563020']], ['中证红利双雄', ['515180', '515080']]];
      else if (curType === 'stock') {
        const bank6 = st.filter(s => s.ind === '银行').slice(0, 6).map(s => s.code);
        if (bank6.length) presets = [['银行6只', bank6]];
      }
      for (const [lab, codes] of presets) {
        presetBox.append(el('button', { class: 'seg-btn', title: '一键填充' + lab,
          onclick: () => applyPreset(codes) }, '⚡ ' + lab));
      }
    }

    function applyPreset(codes) {
      selected.clear();
      order.length = 0;
      for (const c of codes) {
        const pool = curType === 'stock' ? stockGroups.flatMap(g => g.items)
          : curType === 'fav' ? [...allItems.index, ...allItems.etf, ...stockGroups.flatMap(g => g.items)]
          : allItems[curType];
        const it = pool.find(x => x.code === c);
        if (it && order.length < MAX) { selected.set(c, it); order.push(c); }
      }
      renderChips();
      renderList();
    }

    /* 类型 Tab（收藏与指数/ETF/股票并列） */
    for (const [key, label] of [['index', '指数'], ['etf', 'ETF'], ['stock', '股票'], ['fav', '收藏']]) {
      typeTabs.append(el('button', { class: 'seg-btn' + (key === 'index' ? ' active' : ''), 'data-t': key, onclick: () => setType(key) }, label));
    }

    searchBox.addEventListener('input', () => { query = searchBox.value.trim(); renderList(); });
    attachSearchHistory(searchBox, { key: 'compare', onPick: (kw) => { query = kw; renderList(); } });
    btnClear.addEventListener('click', () => { selected.clear(); order.length = 0; renderChips(); renderList(); });
    btnGo.addEventListener('click', () => {
      try { localStorage.setItem('cmp_last', JSON.stringify({ type: curType, codes: order })); } catch { /* 忽略 */ }
      renderCompare();
    });

    renderPresets();
    renderGroupTabs();
    renderList();
    renderChips();

    /* ── 恢复上次对比组合（localStorage）── */
    try {
      const last = JSON.parse(localStorage.getItem('cmp_last') || 'null');
      if (last && last.type && Array.isArray(last.codes) && last.codes.length >= 2) {
        if (last.type !== curType) setType(last.type);
        else {
          for (const c of last.codes) {
            const pool = curType === 'stock' ? stockGroups.flatMap(g => g.items)
              : curType === 'fav' ? [...allItems.index, ...allItems.etf, ...stockGroups.flatMap(g => g.items)]
              : allItems[curType];
            const it = pool.find(x => x.code === c);
            if (it && order.length < MAX) { selected.set(c, it); order.push(c); }
          }
          renderChips();
          renderList();
        }
      }
    } catch { /* 解析失败忽略 */ }
  },
  dispose() {},
};

