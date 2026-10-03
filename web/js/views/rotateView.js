/* 视图：轮动回测（自选两只标的 · A/B 槽位配对）
   规则：两只之间「卖高买低」来回切换——最高价与最低价的差距达到 Δ 时，卖出持仓买入最便宜的那只。
   交付：Δ 网格扫描（各档换仓次数 / 胜率 / 平均超额 / 策略收益），回答"价差多大时换仓胜率最高"。
   数据：/cache/股票_*.json（不复权日线）+ /cache/分红_*.json，浏览器现算，零后端改动；
   候选清单与 #/compare 同源（manifest.stocks）；计算全部在 rotation.js（纯函数，单测 tests/frontend/rotation.test.mjs）。 */

import { el, renderTable, skeleton, errorBox, fmt2, dirOf, attachSearchHistory } from './common.js';
import { loadJSON, decodeRows, klineUrl, MANIFEST_URL } from '../data.js';
import { cssVar, onThemeChange } from '../theme.js';
import { recolorOption } from '../charts.js';
import { ROTATE_STOCKS, pairError, buildMatrix, matrixBounds, simulate, statsOf, conclusion, benchmarks, defaultGrid, shiftYears, spreadStat, oosValidate, EVID_MIN_CLOSED, EVID_FAIR, EVID_GOOD, EXCESS_TIE_PP } from './rotation.js';

const PALETTE = ['#60A5FA', '#FBBF24'];   // 槽位 A / B
const EQ_COLOR = '#22D3EE';
const PRESETS = [['5y', '近5年', 5], ['3y', '近3年', 3], ['1y', '近1年', 1]];
const PAIR_KEY = 'pi_rotate_pair';
const SLOT_TAGS = ['A', 'B'];

/* 已选配对：localStorage 恢复（两只不同代码）→ 否则默认常量的前两只 */
function readPair() {
  const fallback = ROTATE_STOCKS.slice(0, 2).map((s) => s.code);
  try {
    const arr = JSON.parse(localStorage.getItem(PAIR_KEY) || 'null');
    if (Array.isArray(arr) && arr.length === 2 && arr[0] && arr[1] && arr[0] !== arr[1]) return arr.slice();
  } catch { /* 解析失败忽略 */ }
  return fallback;
}

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '轮动回测'),
      el('div', { class: 'desc' }, '自选两只标的 · 两两之间「卖高买低」来回切换 · 扫描价差阈值 Δ，看哪个价差换仓胜率最高')));

    const body = el('div', {});
    const pickCard = el('div', { class: 'card', style: 'padding:10px 14px;margin-bottom:12px' });
    root.append(pickCard, body);
    body.append(skeleton());

    /* ── 候选股票池：与 #/compare 同一份本地清单（manifest.stocks）── */
    let cands = [];
    try {
      const mf = await loadJSON(MANIFEST_URL);
      cands = (mf.stocks || []).map((s) => ({ code: s.code, name: s.name }));
    } catch { /* 清单不可用 → 退化到常量的前两只 */ }
    if (!cands.length) cands = ROTATE_STOCKS.map((s) => ({ code: s.code, name: s.name }));
    const nameOf = (code) => (cands.find((s) => s.code === code) || {}).name || code;

    /* ── 两个固定槽位 A / B ── */
    const pair = readPair();
    const slotState = [0, 1].map((i) => {
      const input = el('input', { class: 'rt-slot-search', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '搜索代码 / 名称…', 'aria-label': `槽位 ${SLOT_TAGS[i]} 搜索` });
      const menu = el('div', { class: 'rt-slot-menu' });
      menu.style.display = 'none';
      const val = el('div', { class: 'rt-slot-val' });
      const slot = el('div', { class: 'rt-slot' }, el('span', { class: 'rt-slot-tag' }, SLOT_TAGS[i]), input, val, menu);
      return { i, input, menu, val, slot };
    });
    const pickerRow = el('div', { class: 'rt-pair' }, slotState[0].slot, el('span', { class: 'rt-pair-vs' }, '⇄'), slotState[1].slot);
    pickCard.append(el('div', { class: 'rt-params' },
      el('span', { class: 'rt-lbl' }, '标的配对'),
      pickerRow,
      el('span', { class: 'rt-note', style: 'margin:0' }, '两只须不同代码 · 改动即刻重算（不发网络请求）')));

    let builtKey = '';
    const charts = { px: null, eq: null, hist: null };
    const disposeCharts = () => {
      for (const k of ['px', 'eq', 'hist']) if (charts[k]) { try { charts[k].dispose(); } catch { /* 已销毁 */ } charts[k] = null; }
    };
    onThemeChange((colorMap) => {
      for (const k of ['px', 'eq', 'hist']) if (charts[k]) charts[k].setOption(recolorOption(charts[k].getOption(), colorMap), { notMerge: true });
    });

    const persist = () => { try { localStorage.setItem(PAIR_KEY, JSON.stringify(pair)); } catch { /* 忽略 */ } };

    const hideMenu = (i) => { const s = slotState[i]; s.menu.style.display = 'none'; s.menu.innerHTML = ''; };
    const showMenu = (i, q) => {
      const s = slotState[i], kw = String(q || '').trim().toLowerCase();
      if (!kw) return hideMenu(i);
      const other = pair[1 - i];
      const hits = cands.filter((c) => c.code.includes(kw) || c.name.toLowerCase().includes(kw)).slice(0, 12);
      s.menu.innerHTML = '';
      if (!hits.length) s.menu.append(el('div', { class: 'rt-slot-item none' }, '无匹配标的'));
      for (const c of hits) {
        const dis = c.code === other;
        s.menu.append(el('div', { class: 'rt-slot-item' + (dis ? ' dis' : ''), title: dis ? '与另一槽位相同' : '',
          onclick: () => { if (!dis) choose(i, c.code); } },
          el('span', {}, c.name), el('span', { class: 'rt-slot-code' }, c.code)));
      }
      s.menu.style.display = '';
    };
    const paintSlot = (i) => {
      const s = slotState[i], code = pair[i];
      s.slot.classList.remove('err');
      s.input.value = '';
      hideMenu(i);
      s.val.innerHTML = '';
      if (code) {
        s.val.append(
          el('span', { class: 'rt-slot-name' }, nameOf(code)),
          el('span', { class: 'rt-slot-code' }, code),
          el('i', { class: 'rt-slot-x', role: 'button', 'aria-label': '清空该槽位', title: '清空',
            onclick: () => { pair[i] = ''; persist(); paintSlot(i); rebuild(); } }, '×'));
      } else {
        s.val.append(el('span', { class: 'rt-slot-empty' }, '未选择'));
      }
    };
    /* 已选标的存在但无本地日线 → 槽位标红提示 */
    const markSlotError = (code) => {
      const i = pair.indexOf(code);
      if (i < 0) return;
      const s = slotState[i];
      s.slot.classList.add('err');
      s.val.innerHTML = '';
      s.val.append(el('span', { class: 'rt-slot-flash' }, '无本地日线数据'));
    };
    const flashSlot = (i, msg) => {
      const s = slotState[i];
      s.slot.classList.add('err');
      s.val.innerHTML = '';
      s.val.append(el('span', { class: 'rt-slot-flash' }, msg));
      setTimeout(() => paintSlot(i), 1400);
    };
    const choose = (i, code) => {
      if (pair[1 - i] === code) { flashSlot(i, '不能与另一槽位相同'); return; }
      pair[i] = code;
      persist();
      slotState.forEach((_, k) => paintSlot(k));
      rebuild();
    };

    const rebuild = async () => {
      const err = pairError(pair);
      if (err) {
        builtKey = '';
        disposeCharts();
        body.innerHTML = '';
        body.append(el('div', { class: 'rt-note', style: 'padding:24px 4px' }, err + '，选好后自动开始回测。'));
        return;
      }
      const codes = pair.slice();
      const key = codes.join(',');
      if (key === builtKey) return;
      builtKey = key;
      disposeCharts();
      body.innerHTML = '';
      body.append(skeleton());
      await renderBody(codes);
    };

    for (const s of slotState) {
      s.input.addEventListener('input', () => showMenu(s.i, s.input.value));
      s.input.addEventListener('focus', () => { if (s.input.value.trim()) showMenu(s.i, s.input.value); });
      s.input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideMenu(s.i);
        if (e.key === 'Enter') { const first = s.menu.querySelector('.rt-slot-item:not(.dis):not(.none)'); if (first) first.click(); }
      });
      attachSearchHistory(s.input, { key: 'rotate', onPick: (kw) => { s.input.value = kw; showMenu(s.i, kw); } });
    }
    document.addEventListener('click', (e) => { for (const s of slotState) if (!s.slot.contains(e.target)) hideMenu(s.i); });

    /* ── 选定两只后构建整个回测主体（槽位变更时整体重建）── */
    async function renderBody(codes) {

      /* ── 数据：两只日线 + 分红（缓存直读） ── */
      const raw = {}, divRows = {}, names = {};
      try {
        await Promise.all(codes.map(async (code) => {
          const k = await loadJSON(klineUrl('股票', code));
          const rows = decodeRows(k);
          if (!rows.length) throw new Error(`${code} 缓存无数据`);
          raw[code] = rows;
          names[code] = k.name || nameOf(code);
          try {
            const d = await loadJSON('/cache/分红_' + code + '.json');
            divRows[code] = d ? decodeRows(d) : [];
          } catch { divRows[code] = []; }
        }));
      } catch (err) {
        const bad = codes.find((c) => !raw[c]);
        if (bad) markSlotError(bad);
        builtKey = '';
        body.innerHTML = '';
        body.append(errorBox('轮动回测数据加载失败：' + err.message, () => { builtKey = ''; rebuild(); }));
        return;
      }
      const bounds = matrixBounds(raw, codes);
      if (!bounds.minStart) {
        builtKey = '';
        body.innerHTML = '';
        body.append(errorBox('两只标的没有共同可回测区间', () => { builtKey = ''; rebuild(); }));
        return;
      }
      body.innerHTML = '';

      /* ── 状态 ── */
      const params = {
        unit: '元', threshold: 3, execOffset: 1, cost: 0.0005,
        includeDiv: true, signalMode: 'raw', startMode: 'holdFirst', onlyWhenHeldIsMax: false, splitRatio: 0.7,
        start: shiftYears(bounds.maxEnd, -5) < bounds.minStart ? bounds.minStart : shiftYears(bounds.maxEnd, -5),
        end: bounds.maxEnd,
      };
      let presetKey = '5y';
      let mx = null, mxKey = '', oosCache = null;

      const getMatrix = () => {
        const key = [params.start, params.end, params.signalMode].join('|');
        if (!mx || mxKey !== key) {
          mx = buildMatrix({ codes, names: codes.map((c) => names[c]), raw, divRows, start: params.start, end: params.end, signalMode: params.signalMode });
          mxKey = key;
        }
        return mx;
      };

      /* ── DOM 骨架 ── */
      const stockRow = el('div', { class: 'stat-row' });
      const paramsCard = el('div', { class: 'card', style: 'padding:10px 14px' });
      const statRow = el('div', { class: 'stat-row', style: 'margin-top:12px' });
      const extraLine = el('div', { class: 'rt-note' });
      const spreadTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '差价分布（本区间）');
      const spreadCard = el('div', { class: 'card rt-spread' });
      const concTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '选择结论 · 本区间最合适的换仓差价');
      const concCard = el('div', { class: 'card rt-conc' });
      const gridTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '阈值网格扫描（换仓次数越少，胜率越不足信）');
      const gridNote = el('div', { class: 'rt-note' }, '点击任意一行 → 用该 Δ 重算下方曲线与明细；★ = 本区间推荐档');
      const gridBox = el('div', { class: 'rt-grid-tbl' });
      const oosTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '样本外验证（前段选 Δ → 后段验证）');
      const oosCard = el('div', { class: 'card rt-oos' });
      const histBox = el('div', { class: 'chart', 'data-chart': 'hist', style: 'height:240px' });
      const pxTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '两只价格与换仓点');
      const pxBox = el('div', { class: 'chart', 'data-chart': 'px', style: 'height:380px' });
      const eqTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '策略净值 vs 买入持有');
      const eqBox = el('div', { class: 'chart', 'data-chart': 'eq', style: 'height:380px' });
      const detailTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:16px 2px 2px' }, '换仓明细（每行的"换仓收益"= 该次换仓之后持有到下次换仓的收益）');
      const detailBox = el('div', {});
      const helpBox = el('div', { class: 'bt-guide', style: 'display:none' });
      const helpBtn = el('button', { class: 'bt-guide-btn', onclick: () => {
        const show = helpBox.style.display === 'none';
        helpBox.style.display = show ? '' : 'none';
        helpBtn.classList.toggle('open', show);
      } }, '❓ 口径与局限');
      helpBox.append(
        el('div', { class: 'g-step' }, el('b', {}, '规则'), el('br'),
          '每交易日收盘后取 A/B 两只收盘价：若「最高价 − 最低价 ≥ Δ」（% 口径为「最高/最低 − 1 ≥ Δ%”）且持仓不是最低价那只 → 卖出持仓、买入最低价那只；默认次一交易日收盘成交（t+1）。'),
        el('div', { class: 'g-step' }, el('b', {}, '胜率与"真实边际"'), el('br'),
          '每次换仓算一次决策：比较「换入那只」与「被卖出那只」在同一持仓区间的收益，换入更高 → 该次换仓赢；胜率 = 赢 ÷ 已了结的换仓次数。',
          el('br'),
          '但胜率高不等于赚得多（赢的幅度通常小于输的幅度），所以同时给：盈亏平衡胜率 = 输均幅度 ÷（赢均幅度 + 输均幅度），**真实边际 = 胜率 − 盈亏平衡胜率**（>0 才算扣完成本后有正期望）；保守边际 = 95%CI 下界 − 盈亏平衡胜率。'),
        el('div', { class: 'g-step' }, el('b', {}, '推荐阈值怎么选出来的'), el('br'),
          '对每档 Δ 统计：换仓次数 / 已了结次数 / 胜率(95%CI) / 盈亏平衡胜率 / 真实边际 / 平均每次超额 / 净超额 / 价差达标交易日占比 / 近1年触发次数。',
          el('br'),
          '入选门槛 = 已了结 ≥ 5 次 且 平均每次超额 > 0（统一、低门槛，避免“只有最低档样本够”）；主推荐 = 入选集合里「净超额 = 策略收益 − 等权买入持有」最大者（±1pp 内视为平局 → 平均每次超额高者 → 换手少者）；高确信档 = 入选集合里平均每次超额最大者（通常阈值更高、机会更少）。'),
        el('div', { class: 'g-step' }, el('b', {}, '口径'), el('br'),
          '价格为不复权收盘价（真实盘面价，实盘可执行）；含分红 = 除权日派现给上一收盘持有者、现金留存、换仓时并入再投入；换仓扣双边成本（单边 cost 各一次），"不换仓"对照只是持有、不扣费；买入持有对照曲线同样扣一次建仓成本。'),
        el('div', { class: 'g-step' }, el('b', {}, '必须知道的三件事'), el('br'),
          '① 样本极小：区间内换仓十几次到几十次，胜率的 95% 置信区间很宽，换仓不足 5 次的档位不要采信；',
          el('br'),
          '② "元差"受股价水平影响：两只标的价格量级与波动幅度不同时，同一个金额在不同的价格水平含义完全不同（低价时占比大、高价时占比小），跨标的比较优先用 Δ% 口径；',
          el('br'),
          '③ 除权跳空：刚除权的股票价格瞬间下移，容易被判成"最便宜"而买入；明细表里带"除权"标记的行就是这种情况（对照收益已含分红，故不会被系统性高估）。'),
        el('div', { class: 'g-note' },
          '局限：单一路径单一样本、标的少（幸存者偏差）、阈值事后挑选即过拟合、按收盘价成交未计冲击成本。本页为历史统计，不构成投资建议。'));

      /* 分段按钮组：切换后立即重算（set 只改状态，重算统一走 render） */
      const segGroup = (items, get, set) => {
        const btns = items.map(([k, label]) => el('button', {
          class: 'seg-btn' + (get() === k ? ' active' : ''),
          onclick: () => {
            set(k);
            btns.forEach((b, i) => b.classList.toggle('active', items[i][0] === get()));
            render();
          },
        }, label));
        return el('div', { class: 'seg-group', role: 'group' }, btns);
      };
      const field = (label, ...nodes) => el('div', { class: 'rt-field' }, el('span', { class: 'rt-lbl' }, label), ...nodes);

      /* 阈值单位 */
      const unitGroup = segGroup([['元', '元差 Δ'], ['%', '相对差 Δ%']], () => params.unit, (k) => {
        params.unit = k;
        params.threshold = k === '元' ? 3 : 10;
        thInput.value = String(params.threshold);
      });
      const thInput = el('input', { class: 'rt-num', type: 'number', min: '0.1', step: '0.1', value: String(params.threshold), 'aria-label': '价差阈值' });
      thInput.addEventListener('change', () => {
        const v = Number(thInput.value);
        if (Number.isFinite(v) && v > 0) params.threshold = v;
        thInput.value = String(params.threshold);
        render();
      });
      /* 区间 */
      const fromInput = el('input', { type: 'text', class: 'dr-from', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': '起始日期', placeholder: 'YYYY-MM-DD', value: params.start });
      const toInput = el('input', { type: 'text', class: 'dr-to', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': '结束日期', placeholder: 'YYYY-MM-DD', value: params.end });
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const applyRange = () => {
        let f = fromInput.value.trim(), t = toInput.value.trim();
        const okF = !f || DATE_RE.test(f), okT = !t || DATE_RE.test(t);
        fromInput.classList.toggle('invalid', !okF);
        toInput.classList.toggle('invalid', !okT);
        if (!okF || !okT) return;
        if (f && f < bounds.minStart) { f = bounds.minStart; fromInput.value = f; }
        if (t && t > bounds.maxEnd) { t = bounds.maxEnd; toInput.value = t; }
        if (f && f > bounds.maxEnd) { f = bounds.maxEnd; fromInput.value = f; }
        if (t && t < bounds.minStart) { t = bounds.minStart; toInput.value = t; }
        if (f && t && f > t) { [f, t] = [t, f]; fromInput.value = f; toInput.value = t; }
        params.start = f || bounds.minStart;
        params.end = t || bounds.maxEnd;
        presetKey = '';
        presetBtns.forEach((b) => b.classList.remove('active'));
        render();
      };
      fromInput.addEventListener('change', applyRange);
      toInput.addEventListener('change', applyRange);
      for (const inp of [fromInput, toInput]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      const presetBtns = PRESETS.map(([key, label, years]) => el('button', {
        class: 'seg-btn' + (key === presetKey ? ' active' : ''),
        onclick: () => {
          presetKey = key;
          params.end = bounds.maxEnd;
          const s = shiftYears(bounds.maxEnd, -years);
          params.start = s < bounds.minStart ? bounds.minStart : s;
          fromInput.value = params.start; toInput.value = params.end;
          presetBtns.forEach((b, i) => b.classList.toggle('active', PRESETS[i][0] === key));
          render();
        },
      }, label));

      /* 其余开关 */
      const execGroup = segGroup([[1, 't+1 收盘'], [0, '当日收盘']], () => params.execOffset, (k) => { params.execOffset = k; });
      const divGroup = segGroup([[true, '含分红'], [false, '纯价格']], () => params.includeDiv, (k) => { params.includeDiv = k; });
      const sigGroup = segGroup([['raw', '真实价'], ['div', '含分红累计价']], () => params.signalMode, (k) => {
        params.signalMode = k;
        if (k === 'div') {   // 含分红累计价量纲随分红累加，元差阈值失去意义 → 强制 % 口径
          params.unit = '%';
          params.threshold = 10;
          thInput.value = '10';
          unitGroup.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', ['元', '%'][i] === '%'));
        }
      });
      const startGroup = segGroup([['holdFirst', '起点持有A'], ['flat', '空仓等首个信号']], () => params.startMode, (k) => { params.startMode = k; });
      const costInput = el('input', { class: 'rt-num', type: 'number', min: '0', step: '0.01', value: '0.05', 'aria-label': '单边成本（%）' });
      costInput.addEventListener('change', () => {
        const v = Number(costInput.value);
        params.cost = Number.isFinite(v) && v >= 0 ? v / 100 : 0.0005;
        costInput.value = (params.cost * 100).toFixed(2);
        render();
      });
      const guardChk = el('input', { type: 'checkbox', 'aria-label': '仅在持仓为最高价时换仓' });
      guardChk.addEventListener('change', () => { params.onlyWhenHeldIsMax = guardChk.checked; render(); });

      paramsCard.append(
        el('div', { class: 'rt-params' },
          field('阈值', unitGroup, thInput),
          field('区间', el('div', { class: 'date-range' },
            el('span', { class: 'dr-label' }, '从'), fromInput,
            el('span', { class: 'dr-label' }, '至'), toInput)),
          el('div', { class: 'seg-group', role: 'group' }, presetBtns),
          field('执行', execGroup),
          field('单边成本', costInput, el('span', { class: 'rt-lbl' }, '%')),
        ),
        el('div', { class: 'rt-params' },
          field('收益', divGroup),
          field('信号', sigGroup),
          field('起点', startGroup),
          el('label', { class: 'rt-check' }, guardChk, el('span', {}, '仅在持仓为最高价时换仓')),
          el('button', { class: 'seg-btn', onclick: () => render() }, '重算'),
        ));

      body.append(stockRow, paramsCard, statRow, extraLine,
        spreadTitle, spreadCard,
        concTitle, concCard, gridTitle, gridNote, gridBox,
        oosTitle, oosCard,
        pxTitle, pxBox, eqTitle, eqBox, detailTitle, detailBox, helpBtn, helpBox);

      /* ── 图表 ── */
      const axisBase = (m, formatter) => ({
        animation: false,
        backgroundColor: 'transparent',
        legend: { top: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
        grid: { left: 58, right: 16, top: 34, bottom: 56 },
        xAxis: { type: 'category', data: m.dates, boundaryGap: false, axisLine: { lineStyle: { color: cssVar('--grid-line') } }, axisLabel: { color: cssVar('--text-3'), fontSize: 10.5 }, axisTick: { show: false } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: cssVar('--text-3'), fontSize: 10.5, formatter }, splitLine: { lineStyle: { color: cssVar('--grid-line') } } },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0 },
          { type: 'slider', xAxisIndex: 0, height: 16, bottom: 6, borderColor: 'transparent', backgroundColor: cssVar('--input-bg'), fillerColor: 'rgba(96,165,250,.12)', handleStyle: { color: cssVar('--brand') } },
        ],
      });

      /* ── 各区块绘制 ── */
      const paintStocks = (m) => {
        const N = m.dates.length;
        stockRow.innerHTML = '';
        m.codes.forEach((c, k) => {
          const p0 = m.px[k][0], p1 = m.px[k][N - 1];
          let hi = null, lo = null;
          for (let i = 0; i < N; i++) {
            const v = m.px[k][i];
            if (v == null) continue;
            if (hi === null || v > hi) hi = v;
            if (lo === null || v < lo) lo = v;
          }
          const chg = (p0 > 0 && p1 != null) ? (p1 / p0 - 1) * 100 : null;
          stockRow.append(el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, `${SLOT_TAGS[k] || ''} ${m.names[k]} · ${c}`),
            el('div', { class: 'stat-value sm' }, fmt2(p1)),
            el('div', { class: 'stat-sub' },
              el('span', { class: 'txt-' + dirOf(chg) }, (chg == null ? '—' : (chg >= 0 ? '+' : '') + fmt2(chg) + '%')),
              ` · 区间 ${fmt2(lo)} ~ ${fmt2(hi)}`)));
        });
        stockRow.append(el('div', { class: 'card stat-card' },
          el('div', { class: 'stat-label' }, '区间'),
          el('div', { class: 'stat-value sm' }, `${m.dates[0]}`),
          el('div', { class: 'stat-sub' }, `至 ${m.dates[N - 1]} · ${N} 个交易日`)));
      };

      const paintStats = (m, st, bm) => {
        statRow.innerHTML = '';
        const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
        const pp = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + ' pp');
        const sgn = (v, d = 1) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
        const ci = st.ci ? `${(st.ci[0] * 100).toFixed(0)}~${(st.ci[1] * 100).toFixed(0)}%` : '—';
        statRow.append(
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '换仓胜率（已了结）'),
            el('div', { class: 'stat-value', style: 'color:' + (st.winRate == null ? '' : st.winRate >= 0.5 ? cssVar('--up') : cssVar('--down')) }, pct(st.winRate)),
            el('div', { class: 'stat-sub' }, `赢 ${st.wins} / ${st.nClosed} 次 · 95%CI ${ci}`)),
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '含未了结末段'),
            el('div', { class: 'stat-value sm' }, pct(st.winRateIncl)),
            el('div', { class: 'stat-sub' }, `赢 ${st.winsIncl} / ${st.nIncl} 次 · 末段当前 ${sgn(st.openRet)}`)),
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '换仓次数'),
            el('div', { class: 'stat-value sm' }, String(st.nSwitch)),
            el('div', { class: 'stat-sub' }, `≈${st.tradesPerYear.toFixed(1)} 次/年 · 平均持有 ${st.avgHoldDays == null ? '—' : st.avgHoldDays.toFixed(0)} 交易日`)),
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '策略收益'),
            el('div', { class: 'stat-value ' + (st.total >= 0 ? 'txt-up' : 'txt-down') }, sgn(st.total)),
            el('div', { class: 'stat-sub' }, `年化 ${sgn(st.ann)} · 最大回撤 ${st.mdd.toFixed(1)}%`)),
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '平均每次换仓超额'),
            el('div', { class: 'stat-value ' + (st.avgExc == null ? '' : st.avgExc >= 0 ? 'txt-up' : 'txt-down') }, pp(st.avgExc)),
            el('div', { class: 'stat-sub' }, `合计 ${st.sumExc == null ? '—' : (st.sumExc >= 0 ? '+' : '') + st.sumExc.toFixed(0)} pp`)),
          el('div', { class: 'card stat-card' },
            el('div', { class: 'stat-label' }, '买入持有对照（等权）'),
            el('div', { class: 'stat-value sm ' + (bm.totals.equal >= 0 ? 'txt-up' : 'txt-down') }, sgn(bm.totals.equal)),
            el('div', { class: 'stat-sub' }, m.codes.map((c, k) => `${m.names[k]} ${sgn(bm.totals[c])}`).join(' · '))),
        );
        extraLine.textContent = `除权日附近触发的换仓 ${st.exDivN} 次（其中已了结 ${st.exDivClosedN} 次 · 赢 ${st.exDivWins}）· 空仓 ${st.cashDays} 个交易日 · 单边成本 ${(params.cost * 100).toFixed(2)}% · ${params.includeDiv ? '含分红' : '纯价格'} · ${params.execOffset ? 't+1 收盘执行' : '当日收盘执行'}${params.onlyWhenHeldIsMax ? ' · 仅在持仓为最高价时换仓' : ''}`;
      };

      /* 结论卡：本区间净超额最大的换仓差价 + 证据强度 + 门槛敏感性 + 未入选说明 */
      const paintConclusion = (m, conc) => {
        concCard.innerHTML = '';
        const u = params.unit === '%' ? '%' : '元';
        const lastPx = Math.min(...m.px.map((p) => p[p.length - 1]).filter((v) => v != null));
        const equiv = (th) => (u === '元' ? `≈相对差 ${(th / lastPx * 100).toFixed(1)}%` : `≈${(th / 100 * lastPx).toFixed(2)} 元 @现价`);
        const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
        const pp1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp');
        const sgn1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
        const evid = (n) => (n >= EVID_GOOD ? '证据充分' : n >= EVID_FAIR ? '证据偏少' : '证据薄弱');
        if (!conc.best) {
          concCard.append(el('div', { class: 'rt-note' },
            `本区间没有任何档位满足「已了结 ≥ ${EVID_MIN_CLOSED} 次 且 平均每次超额 > 0」→ 不给推荐阈值，请拉长区间、放开阈值或放宽口径。`));
          return;
        }
        const b = conc.best;
        const cells = [
          ['推荐换仓差价 Δ', `${b.threshold}${u}`, `${equiv(b.threshold)} · 按「净超额最大」选出`],
          ['证据强度', evid(b.nClosed), `${b.nClosed < EVID_FAIR ? '⚠ ' : ''}已了结 ${b.nClosed} / 换仓 ${b.nSwitch} 次 · ≈${b.tradesPerYear.toFixed(1)} 次/年 · 近1年 ${b.nRecent} 次`],
          ['净超额（策略 − 等权持有）', pp1(b.excess), `策略 ${sgn1(b.total)} vs 等权 ${sgn1(conc.eqTotal)}`],
          ['换仓胜率', pct1(b.winRate), `赢 ${b.wins}/${b.nClosed} 次 · 95%CI ${b.ci ? `${(b.ci[0] * 100).toFixed(0)}~${(b.ci[1] * 100).toFixed(0)}%` : '—'}`],
          ['平均每次超额', pp1(b.avgExc), `Δ≥${b.threshold}${u} 交易日占 ${(b.gapShare * 100).toFixed(0)}% · 平均持有 ${b.avgHoldDays == null ? '—' : b.avgHoldDays.toFixed(0)} 交易日`],
          ['平衡胜率 / 真实边际', `${pct1(b.breakEven)} / ${pp1(b.margin)}`, b.breakEven == null ? '本档未观察到亏损换仓 → 平衡胜率与边际无法估计（不代表差）' : `赢均 ${b.avgWin == null ? '—' : '+' + b.avgWin.toFixed(1) + 'pp'} / 输均 ${b.avgLoss == null ? '—' : b.avgLoss.toFixed(1) + 'pp'}`],
        ];
        concCard.append(el('div', { class: 'rt-conc-grid' }, cells.map(([label, val, sub]) => el('div', { class: 'rt-conc-cell' },
          el('div', { class: 'rt-lbl' }, label),
          el('div', { class: 'rt-conc-val' + (String(val).startsWith('+') ? ' txt-up' : String(val).startsWith('-') ? ' txt-down' : '') }, val),
          el('div', { class: 'rt-conc-sub' }, sub)))));
        const years = Object.keys(b.byYear).sort();
        concCard.append(el('div', { class: 'rt-note' },
          `该档触发年份分布：${years.map((y) => `${y}×${b.byYear[y]}`).join('　')}（年份集中 = 结论依赖特定行情，别外推）`));
        if (conc.strong) {
          const s = conc.strong;
          concCard.append(el('div', { class: 'rt-note' },
            el('b', {}, '高确信档（机会更少、单次质量最高）'),
            `Δ = ${s.threshold}${u}（${equiv(s.threshold)}）：换仓 ${s.nSwitch} 次 · 已了结 ${s.nClosed} · 胜率 ${pct1(s.winRate)} · 平均每次超额 ${pp1(s.avgExc)} · 净超额 ${pp1(s.excess)} —— 出现即执行，但机会更少`));
        }
        concCard.append(el('div', { class: 'rt-note' },
          el('b', {}, '门槛敏感性'), `（入选门槛取 3 / ${EVID_MIN_CLOSED} / ${EVID_FAIR} 时分别推荐）：`,
          conc.sensitivity.map((s) => (s.threshold == null ? `≥${s.min}：无` : `≥${s.min}：Δ=${s.threshold}${u}（净超额 ${pp1(s.excess)}，${s.nClosed} 次）`)).join('　'),
          el('br'),
          '门槛一改结论就变 = 这份数据证据本就不厚，别把推荐值当精确答案。'));
        if (conc.excluded.length) {
          concCard.append(el('div', { class: 'rt-note' },
            el('b', {}, '未入选但净超额高的档'), '：',
            conc.excluded.map((r) => `Δ=${r.threshold}${u}（净超额 ${pp1(r.excess)}，${r.reason}）`).join('　')));
        }
        concCard.append(el('div', { class: 'rt-note' },
          `选择规则（与计算同源）：入选 = 已了结 ≥ ${EVID_MIN_CLOSED} 次且平均每次超额 > 0；主推荐 = 入选集合里净超额最大者（±${EXCESS_TIE_PP}pp 内视为平局 → 平均每次超额高者 → 换手少者）；高确信档 = 入选集合里平均每次超额最大者。`,
          el('br'),
          `净超额以「等权买入持有」为基准（两只各买一半、之后不动），而策略起点固定持有 A，故含一份"起点标的强弱"的常数偏移；档位之间比较不受影响，绝对值不等于"轮动贡献"。`,
          el('br'),
          '局限：单一路径单一样本；阈值事后挑选必然高估；证据薄弱时应以样本外验证为准。'));
      };

      const paintGrid = (grid, bestTh, strongTh) => {
        const sgn = (v, d = 1) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
        const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
        const pp1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'pp');
        const rows = grid.map((g) => ({
          th: `${g.threshold}${params.unit === '%' ? '%' : '元'}`,
          n: g.nSwitch, nc: g.nClosed, rate: g.winRate, lcb: g.lcb,
          ci: g.ci ? `${(g.ci[0] * 100).toFixed(0)}~${(g.ci[1] * 100).toFixed(0)}%` : '—',
          be: g.breakEven, mg: g.margin, cm: g.consMargin, exc: g.avgExc, netEx: g.excess,
          gd: g.gapDays, gs: g.gapShare, rn: g.nRecent,
          total: g.total, ann: g.ann, mdd: g.mdd,
          tag: g.threshold === bestTh ? '★推荐' : (g.threshold === strongTh ? '高确信' : ''),
        }));
        renderTable(gridBox, {
          pageSize: 20,
          columns: [
            { key: 'th', label: '阈值 Δ', align: 'center', sortable: true,
              cmp: (a, b) => parseFloat(a) - parseFloat(b),
              fmt: (v, row) => el('span', { class: row.tag ? 'rt-rec-tag' : (row.nc < EVID_MIN_CLOSED ? 'txt-3' : '') }, row.tag ? `${v} ${row.tag}` : v) },
            { key: 'netEx', label: '净超额', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: pp1 },
            { key: 'n', label: '换仓次数', align: 'center', sortable: true },
            { key: 'nc', label: '已了结', align: 'center', sortable: true,
              fmt: (v) => (v < EVID_FAIR ? el('span', { class: 'txt-down', title: `已了结换仓不足 ${EVID_FAIR} 次，胜率不作依据` }, `${v} ⚠`) : String(v)) },
            { key: 'rate', label: '胜率', align: 'center', sortable: true, fmt: pct1 },
            { key: 'ci', label: '95%CI', align: 'center', sortable: false },
            { key: 'be', label: '平衡胜率', align: 'center', sortable: true, fmt: pct1 },
            { key: 'mg', label: '真实边际', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: pp1 },
            { key: 'cm', label: '保守边际', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: pp1 },
            { key: 'exc', label: '平均超额', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: pp1 },
            { key: 'gd', label: `达标交易日`, align: 'center', sortable: true, fmt: (v, row) => `${v}（${(row.gs * 100).toFixed(0)}%）` },
            { key: 'rn', label: '近1年次数', align: 'center', sortable: true },
            { key: 'total', label: '策略收益', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: (v) => sgn(v) },
            { key: 'ann', label: '年化', align: 'center', sortable: true, color: (v) => dirOf(v), fmt: (v) => sgn(v) },
            { key: 'mdd', label: '最大回撤', align: 'center', sortable: true, fmt: (v) => v.toFixed(1) + '%' },
          ],
          rows,
        });
      };

      const paintCharts = (m, res, bm) => {
        disposeCharts();
        const upC = cssVar('--up'), downC = cssVar('--down');
        const priceTip = (items) => {
          if (!items || !items.length) return '';
          let h = `<div style="font-weight:600;margin-bottom:4px">${items[0].axisValue}</div>`;
          for (const it of items) {
            const v = Array.isArray(it.value) ? it.value[1] : it.value;
            if (v == null) continue;
            h += `<div style="display:flex;gap:12px;justify-content:space-between"><span>${it.marker}${it.seriesName}</span><span style="font-variant-numeric:tabular-nums">${Number(v).toFixed(2)} 元</span></div>`;
          }
          return h;
        };
        charts.px = echarts.init(pxBox);
        charts.px.setOption({
          ...axisBase(m),
          tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 }, formatter: priceTip },
          series: [
            ...m.codes.map((c, k) => ({
              name: (SLOT_TAGS[k] ? SLOT_TAGS[k] + ' ' : '') + m.names[k], type: 'line', data: m.px[k], showSymbol: false, sampling: 'lttb',
              lineStyle: { width: 1.5, color: PALETTE[k % PALETTE.length] }, itemStyle: { color: PALETTE[k % PALETTE.length] },
            })),
            { name: '卖出', type: 'scatter', symbol: 'triangle', symbolRotate: 180, symbolSize: 9, itemStyle: { color: upC },
              data: res.trades.filter((t) => t.fromPx != null).map((t) => [t.idx, t.fromPx]) },
            { name: '买入', type: 'scatter', symbol: 'triangle', symbolSize: 9, itemStyle: { color: downC },
              data: res.trades.map((t) => [t.idx, t.toPx]) },
          ],
        });

        const pctSeries = (name, arr, color, dash) => ({
          name, type: 'line', data: arr.map((v) => +((v - 1) * 100).toFixed(2)), showSymbol: false, sampling: 'lttb',
          lineStyle: { width: name === '策略' ? 2 : 1.4, color, type: dash ? 'dashed' : 'solid' }, itemStyle: { color },
        });
        charts.eq = echarts.init(eqBox);
        charts.eq.setOption({
          ...axisBase(m, (v) => v.toFixed(0) + '%'),
          tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 }, valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2) + '%') },
          series: [
            pctSeries('策略', res.equity, EQ_COLOR, false),
            pctSeries('等权买入持有', bm.equal, cssVar('--text-3'), true),
            ...m.codes.map((c, k) => pctSeries((SLOT_TAGS[k] ? SLOT_TAGS[k] + ' ' : '') + m.names[k], bm.series.get(c), PALETTE[k % PALETTE.length], true)),
          ],
        });
      };

      const paintTrades = (m, res) => {
        const sgn = (v, d = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
        const rows = res.trades.map((t, i) => {
          const s = res.segments[i];
          const mi = (c) => (c ? m.names[m.codes.indexOf(c)] : '—');
          return {
            kind: t.kind === 'open' ? '建仓' : '换仓',
            sig: t.sigDate || '—',
            date: t.date,
            sell: t.from ? `${mi(t.from)} ${fmt2(t.fromPx)}` : '—',
            buy: `${mi(t.to)} ${fmt2(t.toPx)}`,
            gap: t.gap == null ? '—' : fmt2(t.gap) + (params.unit === '%' ? '%' : '元'),
            held: s ? (s.open ? `${s.days}（未了结）` : s.days) : '—',
            ret: s && s.ret != null ? s.ret * 100 : null,
            stay: s && s.retStay != null ? s.retStay * 100 : null,
            exc: s ? s.exc : null,
            win: s && s.win != null ? (s.win ? '赢' : '负') : '—',
            ex: t.exDiv ? '除权' : '—',
          };
        });
        renderTable(detailBox, {
          pageSize: 20,
          columns: [
            { key: 'kind', label: '类型', align: 'center', sortable: false },
            { key: 'sig', label: '信号日', align: 'left', sortable: false, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
            { key: 'date', label: '成交日', align: 'left', sortable: false, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
            { key: 'sell', label: '卖出', align: 'center', sortable: false },
            { key: 'buy', label: '买入', align: 'center', sortable: false },
            { key: 'gap', label: '触发价差', align: 'center', sortable: false },
            { key: 'held', label: '持有交易日', align: 'center', sortable: false },
            { key: 'ret', label: '换仓收益', align: 'center', sortable: false, color: (v) => dirOf(v), fmt: (v) => sgn(v) },
            { key: 'stay', label: '不换仓收益', align: 'center', sortable: false, color: (v) => dirOf(v), fmt: (v) => sgn(v) },
            { key: 'exc', label: '超额', align: 'center', sortable: false, color: (v) => dirOf(v), fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'pp') },
            { key: 'win', label: '结果', align: 'center', sortable: false,
              fmt: (v) => el('span', { class: v === '赢' ? 'txt-up' : v === '负' ? 'txt-down' : 'txt-3' }, v) },
            { key: 'ex', label: '除权触发', align: 'center', sortable: false, filter: false,
              fmt: (v) => (v === '除权' ? el('span', { class: 'txt-flat', title: '买入标的在信号日前 3 个交易日内刚除权，价格因派现下移' }, '除权') : '—') },
          ],
          rows,
        });
      };

      /* 差价分布：描述统计 + 直方图（follow 顶部单位/信号口径；绝对值 gap 即 Δ 比较对象） */
      const paintSpread = (m, bestTh) => {
        const ss = spreadStat(m, params.unit);
        spreadCard.innerHTML = '';
        const fv = (v) => (v == null ? '—' : params.unit === '%' ? v.toFixed(1) + '%' : v.toFixed(2));
        if (!ss.n) {
          spreadCard.append(el('div', { class: 'rt-note' }, '本区间没有两只同时有行情的交易日，无法统计差价分布。'));
          return;
        }
        const cells = [
          ['有效交易日', `${ss.n} / ${ss.total} 天`, ss.n < ss.total ? `有 ${ss.total - ss.n} 天某只停牌/缺数据` : '两只全程都有行情'],
          ['差价均值 / 中位数', `${fv(ss.mean)} / ${fv(ss.q.p50)}`, `标准差 ${fv(ss.sd)}`],
          ['分位 p10 / p25 / p75 / p90', `${fv(ss.q.p10)} / ${fv(ss.q.p25)} / ${fv(ss.q.p75)} / ${fv(ss.q.p90)}`, `区间 ${fv(ss.min)} ~ ${fv(ss.max)}`],
          ['当前差价', `${ss.cur.diff >= 0 ? '+' : ''}${fv(ss.cur.diff)}`, `${SLOT_TAGS[ss.cur.diff >= 0 ? 0 : 1]} 贵 · 历史分位 ${(ss.cur.pct * 100).toFixed(0)}%`],
          ['贵的一侧切换', `${ss.flips} 次`, `A 贵占 ${(ss.signShare * 100).toFixed(0)}% · 切换越多换仓机会越多`],
        ];
        spreadCard.append(el('div', { class: 'rt-conc-grid' }, cells.map(([label, val, sub]) => el('div', { class: 'rt-conc-cell' },
          el('div', { class: 'rt-lbl' }, label),
          el('div', { class: 'rt-conc-val', style: 'font-size:15px' }, val),
          el('div', { class: 'rt-conc-sub' }, sub)))));
        spreadCard.append(histBox);
        if (charts.hist) { try { charts.hist.dispose(); } catch { /* 已销毁 */ } charts.hist = null; }
        charts.hist = echarts.init(histBox);
        const u = params.unit === '%' ? '%' : '元';
        const labels = ss.bins.map((b) => ((b.lo + b.hi) / 2).toFixed(params.unit === '%' ? 1 : 2));
        const nearLabel = (v) => labels.reduce((a, l) => (Math.abs(parseFloat(l) - v) < Math.abs(parseFloat(a) - v) ? l : a), labels[0]);
        const marks = [['均值', ss.mean], ['当前', ss.cur.gap]];
        if (bestTh != null) marks.push(['推荐Δ', bestTh]);
        charts.hist.setOption({
          animation: false,
          backgroundColor: 'transparent',
          grid: { left: 54, right: 16, top: 26, bottom: 34 },
          tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 },
            formatter: (its) => { const it = (its || []).find((x) => x.seriesType === 'bar'); return it ? `${its[0].axisValue}${u}<br/>${it.marker}${it.value} 天` : ''; } },
          xAxis: { type: 'category', data: labels, axisLabel: { color: cssVar('--text-3'), fontSize: 10 }, axisTick: { show: false } },
          yAxis: { type: 'value', name: '天数', nameTextStyle: { color: cssVar('--text-3'), fontSize: 10 }, axisLabel: { color: cssVar('--text-3'), fontSize: 10.5 }, splitLine: { lineStyle: { color: cssVar('--grid-line') } } },
          series: [{
            type: 'bar', data: ss.bins.map((b) => b.n), itemStyle: { color: cssVar('--brand'), opacity: 0.75 },
            markLine: { symbol: 'none', lineStyle: { type: 'dashed' }, label: { color: cssVar('--text-3'), fontSize: 10 },
              data: marks.map(([n, v]) => ({ xAxis: nearLabel(v), name: n })) },
          }],
        });
        spreadCard.append(el('div', { class: 'rt-note' },
          `差价 = ${SLOT_TAGS[0]}(${m.names[0]}) − ${SLOT_TAGS[1]}(${m.names[1]})（正 = A 贵）；绝对值即阈值 Δ 比较的价差。分布跟随顶部「信号口径 / 单位」。`));
      };

      const OOS_VERDICT = { pass: '样本外仍成立', weak: '仅部分成立', fail: '样本外不成立', insufficient: '验证段样本不足，不下结论' };
      const TIER_TEXT = { main: '样本充分', sparse: '训练段样本很少', nodata: '训练段无换仓决策' };

      /* 样本外验证：训练段选 Δ* → 验证段固定用 Δ* 打分（复用 conclusion/simulate/statsOf/benchmarks） */
      const paintOos = (m) => {
        oosCard.innerHTML = '';
        oosCard.append(el('div', { class: 'rt-params', style: 'padding:0' },
          el('span', { class: 'rt-lbl' }, '切分比例'),
          el('div', { class: 'seg-group', role: 'group' }, [0.7, 0.6, 0.8].map((r) => el('button', {
            class: 'seg-btn' + (params.splitRatio === r ? ' active' : ''),
            onclick: () => { params.splitRatio = r; render(); },
          }, `${Math.round(r * 100)}/${Math.round((1 - r) * 100)}`)))));
        const key = [params.start, params.end, params.signalMode, params.unit, params.includeDiv, params.execOffset, params.cost, params.startMode, params.onlyWhenHeldIsMax, params.splitRatio, params.threshold].join('|');
        if (!oosCache || oosCache.key !== key) {
          oosCache = { key, val: oosValidate({ codes, names: codes.map((c) => names[c]), raw, divRows, signalMode: params.signalMode, baseOpts: params, start: params.start, end: params.end, ratio: params.splitRatio, extraThreshold: params.threshold }) };
        }
        const o = oosCache.val;
        if (!o.ok) {
          oosCard.append(el('div', { class: 'rt-note' }, '未执行：' + o.reason + '（拉长区间或调小切分比例后重试）。'));
          return;
        }
        oosCard.append(el('div', { class: 'rt-note', style: 'margin-top:8px' },
          `切分日 ${o.splitDate} · 训练 ${o.train.from} ~ ${o.train.to}（${o.train.nDays} 天 · ${TIER_TEXT[o.train.tier] || o.train.tier}）· 验证 ${o.test.from} ~ ${o.test.to}（${o.test.nDays} 天）`));
        if (o.train.tier === 'nodata') oosCard.append(el('div', { class: 'rt-note' }, '训练段内该配对没有任何换仓决策（一直持有较便宜的那只）→ 无法从训练段“选”出 Δ；下表用最小阈值作为默认规则验证，仅供参考。'));
        else if (o.train.tier === 'sparse') oosCard.append(el('div', { class: 'rt-note' }, `训练段已了结换仓仅 ${o.train.stats.nClosed} 次（不足 ${EVID_FAIR} 次）→ 选出的 Δ 证据很弱。`));
        const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
        const pp1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp');
        const sgn = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
        const u = params.unit === '%' ? '%' : '元';
        const mkRow = (label, th, st, base, excE, hl) => ({ label, th: `${th}${u}`, n: st.nSwitch, nc: st.nClosed, rate: st.winRate, ci: st.ci, be: st.breakEven, mg: st.margin, exc: st.avgExc, total: st.total, base, excE, hl });
        const trainLabel = o.train.tier === 'nodata' ? '训练（无决策→Δmin）' : o.train.tier === 'sparse' ? '训练（样本少，选 Δ）' : '训练（选 Δ*）';
        const testLabel = o.train.tier === 'main' ? '验证（用 Δ*）' : '验证（用训练 Δ）';
        const rows = [
          mkRow(trainLabel, o.chosen, o.train.stats, null, null, false),
          mkRow(testLabel, o.test.threshold, o.test.stats, o.test.base, o.test.excessVsEqual, true),
        ];
        if (o.extra) rows.push(mkRow('验证（当前 Δ）', o.extra.threshold, o.extra.stats, o.extra.base, o.extra.excessVsEqual, false));
        const cols = [
          ['区间', 'label', (v) => v], ['Δ', 'th', (v) => v], ['换仓', 'n', (v) => String(v)], ['已了结', 'nc', (v) => String(v)],
          ['胜率', 'rate', pct1], ['95%CI', 'ci', (v) => (v ? `${(v[0] * 100).toFixed(0)}~${(v[1] * 100).toFixed(0)}%` : '—')],
          ['平衡胜率', 'be', pct1], ['真实边际', 'mg', pp1], ['平均超额', 'exc', pp1],
          ['策略收益', 'total', sgn], ['等权基准', 'base', sgn], ['超额(pp)', 'excE', pp1],
        ];
        oosCard.append(el('div', { class: 'table-wrap' },
          el('table', { class: 'data-table rt-oos-tbl' },
            el('thead', {}, el('tr', {}, cols.map(([l]) => el('th', {}, l)))),
            el('tbody', {}, rows.map((r) => el('tr', { class: r.hl ? 'hl' : '' },
              cols.map(([, k, fmt]) => el('td', {}, fmt(r[k])))))))));
        oosCard.append(el('div', { class: 'rt-note' },
          el('b', {}, `结论：${OOS_VERDICT[o.verdict]}`),
          o.verdict === 'insufficient' ? '（验证段已了结换仓 < 3 次）' : '',
          el('br'),
          '口径：训练段用同一套「净超额最大」规则选出 Δ*，再固定用 Δ* 在验证段打分（不再挑档）。单次切分只是一次过拟合体检，不等于未来有效；建议用 ≥3 年区间做验证。'));
      };

      const render = () => {
        const m = getMatrix();
        if (!m.dates.length || m.dates.length < 2) {
          statRow.innerHTML = '';
          concCard.innerHTML = '';
          gridBox.innerHTML = '';
          detailBox.innerHTML = '';
          spreadCard.innerHTML = '';
          oosCard.innerHTML = '';
          extraLine.textContent = '当前区间内没有可回测的交易日，请调整起止日期。';
          return;
        }
        const res = simulate(m, params);
        const st = statsOf(res);
        const conc = conclusion(m, params, defaultGrid(params.unit));
        const bm = benchmarks(m, { cost: params.cost, includeDiv: params.includeDiv });
        paintStocks(m);
        paintStats(m, st, bm);
        paintConclusion(m, conc);
        paintGrid(conc.rows, conc.best ? conc.best.threshold : null, conc.strong ? conc.strong.threshold : null);
        paintCharts(m, res, bm);
        paintSpread(m, conc.best ? conc.best.threshold : null);
        paintOos(m);
        paintTrades(m, res);
      };

      /* 点网格行 → 用该 Δ 重算 */
      gridBox.addEventListener('click', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr || tr.classList.contains('row-empty')) return;
        const v = parseFloat(tr.children[0] ? tr.children[0].textContent : '');
        if (!Number.isFinite(v)) return;
        params.threshold = v;
        thInput.value = String(v);
        render();
      });

      render();
    }

    slotState.forEach((_, i) => paintSlot(i));
    await rebuild();
  },
};
