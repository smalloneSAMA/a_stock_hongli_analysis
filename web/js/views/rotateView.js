/* 视图：轮动回测（固定三只：神火股份 / 云铝股份 / 电投能源）
   规则：三只之间「卖高买低」来回切换——最高价与最低价的差距达到 Δ 时，卖出持仓买入最便宜的那只。
   交付：Δ 网格扫描（各档换仓次数 / 胜率 / 平均超额 / 策略收益），回答"价差多大时换仓胜率最高"。
   数据：/cache/股票_*.json（不复权日线）+ /cache/分红_*.json，浏览器现算，零后端改动；
   计算全部在 rotation.js（纯函数，单测 tests/frontend/rotation.test.mjs）。 */

import { el, renderTable, skeleton, errorBox, fmt2, dirOf } from './common.js';
import { loadJSON, decodeRows, klineUrl } from '../data.js';
import { cssVar, onThemeChange } from '../theme.js';
import { recolorOption } from '../charts.js';
import { ROTATE_STOCKS, buildMatrix, matrixBounds, simulate, statsOf, conclusion, benchmarks, defaultGrid, shiftYears } from './rotation.js';

const PALETTE = ['#60A5FA', '#FBBF24', '#34D399'];   // 神火/云铝/电投
const EQ_COLOR = '#22D3EE';
const PRESETS = [['5y', '近5年', 5], ['3y', '近3年', 3], ['1y', '近1年', 1]];

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '轮动回测'),
      el('div', { class: 'desc' }, '神火股份 / 云铝股份 / 电投能源 · 三只之间「卖高买低」来回切换 · 扫描价差阈值 Δ，看哪个价差换仓胜率最高')));
    const body = el('div', {});
    root.append(body);
    body.append(skeleton());

    /* ── 数据：三只日线 + 分红（缓存直读） ── */
    const raw = {}, divRows = {}, names = {};
    try {
      await Promise.all(ROTATE_STOCKS.map(async (s) => {
        const k = await loadJSON(klineUrl('股票', s.code));
        const rows = decodeRows(k);
        if (!rows.length) throw new Error(`${s.code} 缓存无数据`);
        raw[s.code] = rows;
        names[s.code] = k.name || s.name;
        try {
          const d = await loadJSON('/cache/分红_' + s.code + '.json');
          divRows[s.code] = d ? decodeRows(d) : [];
        } catch { divRows[s.code] = []; }
      }));
    } catch (err) {
      body.innerHTML = '';
      body.append(errorBox('轮动回测数据加载失败：' + err.message, () => { root.innerHTML = ''; this.mount(root); }));
      return;
    }
    const codes = ROTATE_STOCKS.map((s) => s.code);
    const bounds = matrixBounds(raw, codes);
    if (!bounds.minStart) {
      body.innerHTML = '';
      body.append(errorBox('三只标的没有共同可回测区间', () => { root.innerHTML = ''; this.mount(root); }));
      return;
    }
    body.innerHTML = '';

    /* ── 状态 ── */
    const params = {
      unit: '元', threshold: 3, execOffset: 1, cost: 0.0005,
      includeDiv: true, signalMode: 'raw', startMode: 'holdFirst', onlyWhenHeldIsMax: false,
      start: shiftYears(bounds.maxEnd, -5) < bounds.minStart ? bounds.minStart : shiftYears(bounds.maxEnd, -5),
      end: bounds.maxEnd,
    };
    let presetKey = '5y';
    let mx = null, mxKey = '';

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
    const concTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '选择结论 · 本区间最合适的换仓差价');
    const concCard = el('div', { class: 'card rt-conc' });
    const gridTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '阈值网格扫描（换仓次数越少，胜率越不足信）');
    const gridNote = el('div', { class: 'rt-note' }, '点击任意一行 → 用该 Δ 重算下方曲线与明细；★ = 本区间推荐档');
    const gridBox = el('div', { class: 'rt-grid-tbl' });
    const pxTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '三只价格与换仓点');
    const pxBox = el('div', { class: 'chart', style: 'height:380px' });
    const eqTitle = el('div', { class: 'chart-title', style: 'font-size:15px;margin:14px 2px 2px' }, '策略净值 vs 买入持有');
    const eqBox = el('div', { class: 'chart', style: 'height:380px' });
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
        '每交易日收盘后取三只收盘价：若「最高价 − 最低价 ≥ Δ」（% 口径为「最高/最低 − 1 ≥ Δ%”）且持仓不是最低价那只 → 卖出持仓、买入最低价那只；默认次一交易日收盘成交（t+1）。'),
      el('div', { class: 'g-step' }, el('b', {}, '胜率与"真实边际"'), el('br'),
        '每次换仓算一次决策：比较「换入那只」与「被卖出那只」在同一持仓区间的收益，换入更高 → 该次换仓赢；胜率 = 赢 ÷ 已了结的换仓次数。',
        el('br'),
        '但胜率高不等于赚得多（赢的幅度通常小于输的幅度），所以同时给：盈亏平衡胜率 = 输均幅度 ÷（赢均幅度 + 输均幅度），**真实边际 = 胜率 − 盈亏平衡胜率**（>0 才算扣完成本后有正期望）；保守边际 = 95%CI 下界 − 盈亏平衡胜率。'),
      el('div', { class: 'g-step' }, el('b', {}, '推荐阈值怎么选出来的'), el('br'),
        '对每档 Δ 统计：换仓次数 / 已了结次数 / 胜率(95%CI) / 盈亏平衡胜率 / 真实边际 / 平均每次超额 / 价差达标交易日占比 / 近1年触发次数。',
        el('br'),
        '主推荐 = 「已了结 ≥ 12 次 且 近1年触发 ≥ 3 次」的档里保守边际最大者（样本够、且当下行情仍会触发）；没有满足者才退到「已了结 ≥ 8 次」，并在卡上标注"样本偏少"。高确信档 = 「已了结 ≥ 8 次且真实边际 > 0」的档里保守边际最大者（阈值更高、机会更少）。'),
      el('div', { class: 'g-step' }, el('b', {}, '口径'), el('br'),
        '价格为不复权收盘价（真实盘面价，实盘可执行）；含分红 = 除权日派现给上一收盘持有者、现金留存、换仓时并入再投入；换仓扣双边成本（单边 cost 各一次），"不换仓"对照只是持有、不扣费；买入持有对照曲线同样扣一次建仓成本。'),
      el('div', { class: 'g-step' }, el('b', {}, '必须知道的三件事'), el('br'),
        '① 样本极小：区间内换仓十几次到几十次，胜率的 95% 置信区间很宽，换仓不足 5 次的档位不要采信；',
        el('br'),
        '② "元差"受股价水平影响：三只 5 年内价格量级漂移很大（神火 8.32~36.58、云铝 9.20~35.77、电投 11.20~33.50），同一个 3 元在低位是 30%+、在高位只有 8%；',
        el('br'),
        '③ 除权跳空：刚除权的股票价格瞬间下移，容易被判成"最便宜"而买入；明细表里带"除权"标记的行就是这种情况（对照收益已含分红，故不会被系统性高估）。'),
      el('div', { class: 'g-note' },
        '局限：单一路径单一样本、只有三只标的（幸存者偏差）、阈值事后挑选即过拟合、按收盘价成交未计冲击成本。本页为历史统计，不构成投资建议。'));

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
    const startGroup = segGroup([['holdFirst', '起点持有神火'], ['flat', '空仓等首个信号']], () => params.startMode, (k) => { params.startMode = k; });
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

    body.append(stockRow, paramsCard, statRow, extraLine, concTitle, concCard, gridTitle, gridNote, gridBox, pxTitle, pxBox, eqTitle, eqBox, detailTitle, detailBox, helpBtn, helpBox);

    /* ── 图表 ── */
    let pxChart = null, eqChart = null;
    onThemeChange((colorMap) => {
      if (pxChart) pxChart.setOption(recolorOption(pxChart.getOption(), colorMap), { notMerge: true });
      if (eqChart) eqChart.setOption(recolorOption(eqChart.getOption(), colorMap), { notMerge: true });
    });
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
          el('div', { class: 'stat-label' }, `${m.names[k]} · ${c}`),
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

    /* 结论卡：本区间最合适的换仓差价（自动选择 + 可信度指标全摆出来） */
    const paintConclusion = (m, conc) => {
      concCard.innerHTML = '';
      const u = params.unit === '%' ? '%' : '元';
      const lastPx = Math.min(...m.px.map((p) => p[p.length - 1]).filter((v) => v != null));
      const equiv = (th) => (u === '元' ? `≈相对差 ${(th / lastPx * 100).toFixed(1)}%` : `≈${(th / 100 * lastPx).toFixed(2)} 元 @现价`);
      const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
      const pp1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp');
      if (!conc.best) {
        concCard.append(el('div', { class: 'rt-note' }, '本区间换仓样本不足（没有「已了结 ≥ 8 次」的档位）→ 不给推荐阈值，请拉长区间、放开阈值或放宽口径。'));
        return;
      }
      const b = conc.best;
      const cells = [
        ['推荐换仓差价 Δ', `${b.threshold}${u}`, `${equiv(b.threshold)} · ${conc.tier === 'main' ? '样本充分且近1年仍在触发' : '样本偏少，仅作参考'}`],
        ['出现次数', `换仓 ${b.nSwitch} 次`, `≈${b.tradesPerYear.toFixed(1)} 次/年 · 近1年 ${b.nRecent} 次 · 平均持有 ${b.avgHoldDays == null ? '—' : b.avgHoldDays.toFixed(0)} 交易日`],
        [`价差 ≥${b.threshold}${u} 的交易日`, `${b.gapDays} / ${b.gapTotal} 天`, `占 ${(b.gapShare * 100).toFixed(0)}%（真正触发换仓需持仓不是最便宜的那只）`],
        ['换仓胜率', pct1(b.winRate), `赢 ${b.wins}/${b.nClosed} 次 · 95%CI ${b.ci ? `${(b.ci[0] * 100).toFixed(0)}~${(b.ci[1] * 100).toFixed(0)}%` : '—'}`],
        ['盈亏平衡胜率', pct1(b.breakEven), `赢均 ${b.avgWin == null ? '—' : '+' + b.avgWin.toFixed(1) + 'pp'} / 输均 ${b.avgLoss == null ? '—' : b.avgLoss.toFixed(1) + 'pp'}`],
        ['真实边际', pp1(b.margin), '胜率 − 盈亏平衡胜率（>0 才有正期望）'],
        ['平均每次超额', pp1(b.avgExc), `保守边际 ${pp1(b.consMargin)}（CI下界 − 平衡胜率${b.consMargin != null && b.consMargin < 0 ? '；为负 = 样本量不足以在 95% 置信下排除"零优势"' : ''}）`],
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
          el('b', {}, '高确信档（机会更少但优势最大）'),
          `Δ = ${s.threshold}${u}（${equiv(s.threshold)}）：换仓 ${s.nSwitch} 次 · 胜率 ${pct1(s.winRate)}（赢 ${s.wins}/${s.nClosed}）· 平衡胜率 ${pct1(s.breakEven)} · 真实边际 ${pp1(s.margin)} · 平均超额 ${pp1(s.avgExc)} —— 出现即执行，但一年可能只有一两次机会`));
      }
      concCard.append(el('div', { class: 'rt-note' },
        '选择规则（与计算同源）：主推荐 = 在「已了结 ≥ 12 次且近1年触发 ≥ 3 次」的档里取保守边际（95%CI 下界 − 平衡胜率）最大者，没有满足者才退到「已了结 ≥ 8 次」；高确信档 = 已了结 ≥ 8 次且真实边际 > 0 的档里保守边际最大者。',
        el('br'),
        '局限：单一路径单一样本；阈值事后挑选必然高估（本卡用 CI 下界与保守边际抵消一部分）；胜率高不等于赚得多 —— 赢的幅度通常小于输的幅度，务必看「真实边际」是否为正值。'));
    };

    const paintGrid = (grid, bestTh, strongTh) => {
      const sgn = (v, d = 1) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
      const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
      const pp1 = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'pp');
      const rows = grid.map((g) => ({
        th: `${g.threshold}${params.unit === '%' ? '%' : '元'}`,
        n: g.nSwitch, nc: g.nClosed, rate: g.winRate, lcb: g.lcb,
        ci: g.ci ? `${(g.ci[0] * 100).toFixed(0)}~${(g.ci[1] * 100).toFixed(0)}%` : '—',
        be: g.breakEven, mg: g.margin, cm: g.consMargin, exc: g.avgExc,
        gd: g.gapDays, gs: g.gapShare, rn: g.nRecent,
        total: g.total, ann: g.ann, mdd: g.mdd,
        tag: g.threshold === bestTh ? '★推荐' : (g.threshold === strongTh ? '高确信' : ''),
      }));
      renderTable(gridBox, {
        pageSize: 20,
        columns: [
          { key: 'th', label: '阈值 Δ', align: 'center', sortable: true,
            cmp: (a, b) => parseFloat(a) - parseFloat(b),
            fmt: (v, row) => el('span', { class: row.tag ? 'rt-rec-tag' : (row.nc < 8 ? 'txt-3' : '') }, row.tag ? `${v} ${row.tag}` : v) },
          { key: 'n', label: '换仓次数', align: 'center', sortable: true },
          { key: 'nc', label: '已了结', align: 'center', sortable: true,
            fmt: (v) => (v < 8 ? el('span', { class: 'txt-down', title: '已了结换仓不足 8 次，胜率不作依据' }, `${v} ⚠`) : String(v)) },
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
      if (pxChart) { pxChart.dispose(); pxChart = null; }
      if (eqChart) { eqChart.dispose(); eqChart = null; }
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
      pxChart = echarts.init(pxBox);
      pxChart.setOption({
        ...axisBase(m),
        tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 }, formatter: priceTip },
        series: [
          ...m.codes.map((c, k) => ({
            name: m.names[k], type: 'line', data: m.px[k], showSymbol: false, sampling: 'lttb',
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
      eqChart = echarts.init(eqBox);
      eqChart.setOption({
        ...axisBase(m, (v) => v.toFixed(0) + '%'),
        tooltip: { trigger: 'axis', backgroundColor: cssVar('--tooltip-bg'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 }, valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2) + '%') },
        series: [
          pctSeries('策略', res.equity, EQ_COLOR, false),
          pctSeries('等权买入持有', bm.equal, cssVar('--text-3'), true),
          ...m.codes.map((c, k) => pctSeries(m.names[k], bm.series.get(c), PALETTE[k % PALETTE.length], true)),
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

    const render = () => {
      const m = getMatrix();
      if (!m.dates.length || m.dates.length < 2) {
        statRow.innerHTML = '';
        concCard.innerHTML = '';
        gridBox.innerHTML = '';
        detailBox.innerHTML = '';
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
  },
};
