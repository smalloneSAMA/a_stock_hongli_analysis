/* 轮动回测引擎（纯函数：无 DOM、无 echarts、无网络）
   规则：所选标的之间「卖高买低」来回切换——每交易日收盘后取各只收盘价，
        若 最高价 − 最低价 ≥ Δ（元）或 (最高/最低 − 1) ≥ Δ%（相对差），
        且当前持仓 ≠ 最低价那只 → 产生信号；默认次一交易日收盘成交（t+1，与项目回测执行日口径一致）。
   胜率：每次换仓 = 一次决策。比较「换入标的」与「被卖出标的」在同一持仓区间的收益，
        换入更高 → 该次换仓赢；胜率 = 赢 ÷ 已了结的换仓次数（末段未了结默认剔除，另给含未了结口径）。
   口径：
     · 价格为 cache 中不复权收盘价（前向填充，停牌日不参与判定、换仓顺延至下一可交易日）；
     · 含分红 = 除权日每股分红派现给「上一收盘持有者」（现金留存、换仓时并入再投入，不计息不复投）；
     · 换仓收益扣双边成本（单边 cost 各一次），「不换仓」对照只是持有、无交易故不扣费；
     · 起点建仓同样扣一次单边成本；买入持有对照曲线亦扣一次，口径对称。
*/

/* 固定三只（价格量级接近，元差口径才有意义） */
export const ROTATE_STOCKS = [
  { code: '000933', name: '神火股份' },
  { code: '000807', name: '云铝股份' },
  { code: '002128', name: '电投能源' },
];

export const UNIT_DEFAULTS = {
  '元': [0.5, 1, 1.5, 2, 2.5, 3, 4, 5],
  '%': [2, 3, 5, 8, 10, 12, 15, 20],
};

/* 默认阈值网格（按单位） */
export function defaultGrid(unit) {
  return (UNIT_DEFAULTS[unit] || UNIT_DEFAULTS['元']).slice();
}

/* 日期左移/右移 n 年（跨月越界按 JS Date 归一化） */
export function shiftYears(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y + n, m - 1, d));
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/* 三只标的的共同可用区间：起点取各只最早交易日的最晚者，终点取各只最晚交易日的最早者 */
export function matrixBounds(rawByCode, codes) {
  let minStart = null, maxEnd = null;
  for (const c of codes) {
    const rows = rawByCode[c] || [];
    if (!rows.length) continue;
    const s = rows[0].date, e = rows[rows.length - 1].date;
    if (minStart === null || s > minStart) minStart = s;
    if (maxEnd === null || e < maxEnd) maxEnd = e;
  }
  return { minStart, maxEnd };
}

/* 构建价格矩阵：日期轴 = 区间内各标的交易日的并集（A股日历一致，并集兼容个别缺行） */
export function buildMatrix({ codes, names, raw, divRows, start = '', end = '', signalMode = 'raw' }) {
  const dateSet = new Set();
  for (const c of codes) {
    /* start/end 为空 = 不限（区间由调用方决定） */
    for (const r of raw[c] || []) if ((!start || r.date >= start) && (!end || r.date <= end)) dateSet.add(r.date);
  }
  const dates = [...dateSet].sort();
  const N = dates.length;
  const px = [], has = [], div = [], cumDiv = [], sig = [];

  for (const c of codes) {
    const rows = raw[c] || [];
    const evs = (divRows[c] || []).slice().sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
    const p = new Array(N).fill(null), h = new Array(N).fill(false);
    const d = new Array(N).fill(0), cd = new Array(N).fill(0), s = new Array(N).fill(null);
    let ri = 0, ei = 0, last = null, cum = 0;
    /* 窗口前的旧分红：只推进累计（供区间内求和），不落到窗口首日（否则会误判"除权日刚派现"） */
    while (N > 0 && ei < evs.length && evs[ei].ex_date < dates[0]) { cum += (evs[ei].bonus10 || 0) / 10; ei++; }
    const cumBase = cum;
    for (let i = 0; i < N; i++) {
      const dt = dates[i];
      while (ri < rows.length && rows[ri].date <= dt) { last = rows[ri].close; ri++; }   // 前向填充（含区间前的行）
      h[i] = ri > 0 && rows[ri - 1].date === dt;
      p[i] = last;
      let today = 0;
      while (ei < evs.length && evs[ei].ex_date <= dt) { today += (evs[ei].bonus10 || 0) / 10; ei++; }   // 除权日非交易日 → 归其后首个交易日
      d[i] = today;
      cum += today;
      cd[i] = cum;
      s[i] = last == null ? null : (signalMode === 'div' ? last + (cum - cumBase) : last);
    }
    px.push(p); has.push(h); div.push(d); cumDiv.push(cd); sig.push(s);
  }

  return { codes: codes.slice(), names: (names || codes).slice(), dates, px, has, div, cumDiv, sig, signalMode };
}

/* 单段收益：以 1.0 元在 i0 收盘买入（扣单边成本），i1 收盘（withExit 时扣卖出成本）结算，含期间分红 */
function segRet(m, k, i0, i1, withExit, cost, includeDiv) {
  const p0 = m.px[k][i0], p1 = m.px[k][i1];
  if (p0 == null || p1 == null || !(p0 > 0)) return null;
  const dv = includeDiv ? (m.cumDiv[k][i1] - m.cumDiv[k][i0]) : 0;
  const sh = (1 - cost) / p0;
  return sh * (p1 * (withExit ? (1 - cost) : 1) + dv) - 1;
}

/* 同期「不换仓」对照：一直持有该标的（无交易、不扣费） */
function stayRet(m, k, i0, i1, includeDiv) {
  const p0 = m.px[k][i0], p1 = m.px[k][i1];
  if (p0 == null || p1 == null || !(p0 > 0)) return null;
  const dv = includeDiv ? (m.cumDiv[k][i1] - m.cumDiv[k][i0]) : 0;
  return (p1 + dv) / p0 - 1;
}

/* 当日极值：最高/最低（停牌与无数据标的当日不参与判定） */
function extremeAt(m, i) {
  let maxV = -Infinity, minV = Infinity, maxC = null, minC = null, n = 0;
  for (let k = 0; k < m.codes.length; k++) {
    if (!m.has[k][i] || m.sig[k][i] == null) continue;
    const v = m.sig[k][i];
    if (v > maxV) { maxV = v; maxC = m.codes[k]; }
    if (v < minV) { minV = v; minC = m.codes[k]; }
    n++;
  }
  return n >= 2 ? { maxV, minV, maxC, minC, n } : { maxV: null, minV: null, maxC: null, minC: null, n };
}

/* 当日价差：元 = 最高−最低；% = (最高/最低−1)×100；当日不足 2 只有效标的 → null */
export function gapAt(m, i, unit = '元') {
  const e = extremeAt(m, i);
  if (e.n < 2) return null;
  return unit === '%' ? (e.maxV / e.minV - 1) * 100 : e.maxV - e.minV;
}

/* 价差达标频率：区间内「最高−最低 ≥ Δ」的交易日数 / 区间交易日数 */
export function gapDayShare(m, threshold, unit = '元') {
  let days = 0, total = 0;
  for (let i = 0; i < m.dates.length; i++) {
    const g = gapAt(m, i, unit);
    if (g == null) continue;
    total++;
    if (g >= Number(threshold)) days++;
  }
  return { days, total, share: total ? days / total : null };
}

/* 回测主循环 */
export function simulate(m, opts = {}) {
  const o = {
    unit: '元', threshold: 3, execOffset: 1, cost: 0.0005,
    includeDiv: true, startMode: 'holdFirst', onlyWhenHeldIsMax: false,
    ...opts,
  };
  const { codes, dates, px, has, div, cumDiv, sig } = m;
  const N = dates.length, K = codes.length;
  const cost = Math.max(0, Number(o.cost) || 0);
  const execOffset = Math.max(0, Math.round(Number(o.execOffset) || 0));
  const ki = new Map(codes.map((c, k) => [c, k]));

  const equity = new Array(N).fill(1);
  const holdings = new Array(N).fill(null);
  const trades = [];
  const segments = [];

  let held = null, shares = 0, cash = 1, cur = null, pending = null, sigLockUntil = 0;

  /* 起点持仓：区间首日收盘买入第一只（signalMode 与换仓同口径，扣一次单边成本） */
  if (o.startMode === 'holdFirst' && K > 0 && N > 0 && has[0][0]) {
    pending = { target: codes[0], sigIdx: -1, execIdx: 0, gap: null, exDiv: false };
  }

  const canExec = (j) => {
    if (!pending || j >= N) return false;
    if (!has[ki.get(pending.target)][j]) return false;          // 买入标的当日停牌 → 顺延
    if (held && !has[ki.get(held)][j]) return false;            // 卖出标的当日停牌 → 顺延
    return true;
  };

  /* 信号：最高价与最低价的差距达标、且持仓不是最低价那只 */
  const signalAt = (i) => {
    const e = extremeAt(m, i);
    if (e.n < 2) return null;
    const gap = o.unit === '%' ? (e.maxV / e.minV - 1) * 100 : e.maxV - e.minV;
    if (!(gap >= Number(o.threshold))) return null;
    if (held && e.minC === held) return null;                     // 已持有最便宜的那只
    if (o.onlyWhenHeldIsMax && held && e.maxC !== held) return null;
    return { target: e.minC, maxC: e.maxC, gap };
  };

  /* 在 j 日收盘执行待办换仓：卖出持仓（扣单边成本）→ 全额买入目标（再扣单边成本） */
  const execAt = (j) => {
    const t = pending.target, ti = ki.get(t);
    const from = held, fromPx = from ? px[ki.get(from)][j] : null;
    if (from) cash += shares * fromPx * (1 - cost);
    shares = 0;
    const amount = cash; cash = 0;
    shares = (amount * (1 - cost)) / px[ti][j];

    /* 关闭上一段（该段的了结成本记在其自身，供「换了 vs 没换」比较） */
    if (cur) {
      cur.exitIdx = j; cur.exitDate = dates[j]; cur.exitPx = px[cur.k][j]; cur.open = false;
      cur.ret = segRet(m, cur.k, cur.entryIdx, j, true, cost, o.includeDiv);
      cur.retStay = cur.altK >= 0 ? stayRet(m, cur.altK, cur.entryIdx, j, o.includeDiv) : null;
      cur.exc = (cur.ret != null && cur.retStay != null) ? (cur.ret - cur.retStay) * 100 : null;
      cur.win = cur.exc == null ? null : cur.exc > 0;
      cur.days = j - cur.entryIdx;
    }

    cur = {
      kind: from ? 'switch' : 'open', k: ti, code: t, altK: from ? ki.get(from) : -1, altCode: from,
      entryIdx: j, entryDate: dates[j], entryPx: px[ti][j], open: true,
      sigIdx: pending.sigIdx, sigDate: pending.sigIdx >= 0 ? dates[pending.sigIdx] : null,
      gap: pending.gap, exDiv: !!pending.exDiv,
    };
    segments.push(cur);
    trades.push({
      kind: cur.kind, sigDate: cur.sigDate, date: dates[j], idx: j,
      from, to: t, fromPx, toPx: px[ti][j], gap: pending.gap, exDiv: !!pending.exDiv,
    });
    held = t;
    pending = null;
    sigLockUntil = j + 1;   // 成交当日收盘不再重复判定，次日恢复
  };
  const markToMarket = (i) => {
    const hp = held ? ki.get(held) : -1;
    equity[i] = hp >= 0 ? shares * px[hp][i] + cash : cash;
    holdings[i] = held;
  };

  for (let i = 0; i < N; i++) {
    /* 1) 除权分红：派给「上一收盘持有者」，故在换仓执行之前结算 */
    if (held && o.includeDiv && shares > 0) cash += shares * div[ki.get(held)][i];

    /* 2) 执行到期待办（t+1 口径在此成交；标的当日停牌则继续等待下一交易日） */
    if (pending && i >= pending.execIdx && canExec(i)) execAt(i);

    /* 3) 估值 */
    markToMarket(i);

    /* 4) 收盘后判定信号（t+execOffset 收盘执行） */
    if (!pending && i >= sigLockUntil && i + execOffset < N) {
      const s = signalAt(i);
      if (s && s.target !== held) {
        /* 除权跳空标记：买入标的在信号日前 3 个交易日内刚除权（价格因派现下移，容易被判成“最便宜”） */
        const tk = ki.get(s.target);
        let exDiv = false;
        for (let b = Math.max(0, i - 3); b <= i; b++) if (m.div[tk][b] > 0) { exDiv = true; break; }
        pending = { target: s.target, sigIdx: i, execIdx: i + execOffset, gap: s.gap, exDiv };
        /* 当日收盘成交口径（execOffset=0）：信号在收盘产生即在该收盘价成交，并按成交后重估当日净值 */
        if (pending.execIdx <= i && canExec(i)) { execAt(i); markToMarket(i); }
      }
    }
  }

  /* 末段（未了结）：按区间最后交易日收盘价估值，不扣卖出成本 */
  if (cur && cur.open && N > 0) {
    const last = N - 1;
    cur.exitIdx = last; cur.exitDate = dates[last]; cur.exitPx = px[cur.k][last];
    cur.ret = segRet(m, cur.k, cur.entryIdx, last, false, cost, o.includeDiv);
    cur.retStay = cur.altK >= 0 ? stayRet(m, cur.altK, cur.entryIdx, last, o.includeDiv) : null;
    cur.exc = (cur.ret != null && cur.retStay != null) ? (cur.ret - cur.retStay) * 100 : null;
    cur.win = cur.exc == null ? null : cur.exc > 0;
    cur.days = last - cur.entryIdx;
  }

  return { codes, names: m.names, dates, px, has, div, cumDiv, sig, opts: o, equity, holdings, trades, segments };
}

/* Wilson 95% 置信区间（返回 [lo, hi] 比例；n=0 → null） */
export function wilson(win, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const p = win / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

/* 最大回撤（%，负值） */
function maxDrawdown(eq) {
  let peak = -Infinity, mdd = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd * 100;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/* 统计：胜率（已了结 / 含未了结）、超额、换手、策略净值指标、除权触发分项 */
export function statsOf(res, opts = {}) {
  const o = { includeDiv: true, ...res.opts, ...opts };
  const { dates, equity, holdings, segments, trades } = res;
  const N = dates.length;
  const closed = segments.filter((s) => s.kind === 'switch' && !s.open);
  const openSeg = segments.filter((s) => s.kind === 'switch' && s.open);
  const incl = closed.concat(openSeg.filter((s) => s.win != null));
  const wins = closed.filter((s) => s.win === true).length;
  const nSwitch = trades.filter((t) => t.kind === 'switch').length;
  const days = N > 1 ? Math.round((new Date(dates[N - 1]) - new Date(dates[0])) / 86400000) : 0;
  const years = Math.max(days / 365.25, 1 / 365.25);
  const total = equity.length ? equity[N - 1] - 1 : 0;
  const ann = total > -1 ? Math.pow(1 + total, 1 / years) - 1 : -1;
  const excs = closed.map((s) => s.exc).filter((v) => v != null);
  const exDivClosed = closed.filter((s) => s.exDiv);
  const winExcs = excs.filter((v) => v > 0), lossExcs = excs.filter((v) => v < 0);
  const avgWin = mean(winExcs), avgLoss = mean(lossExcs);
  /* 盈亏平衡胜率：赢的平均赚 avgWin、输的平均亏 |avgLoss| 时，胜率需超过该值才有正期望 */
  const breakEven = (avgWin != null && avgWin > 0 && avgLoss != null && avgLoss < 0) ? -avgLoss / (avgWin - avgLoss) : null;
  const winRate = closed.length ? wins / closed.length : null;
  const ci = wilson(wins, closed.length);
  const recentFrom = N ? shiftYears(dates[N - 1], -1) : '';
  return {
    N, days,
    first: dates[0], last: dates[N - 1],
    nSwitch,
    nRecent: trades.filter((t) => t.kind === 'switch' && t.date >= recentFrom).length,
    recentFrom,
    nClosed: closed.length, wins, winRate, ci,
    lcb: ci ? ci[0] : null,
    avgWin, avgLoss, breakEven,
    /* 真实边际 = 胜率 − 盈亏平衡胜率（pp）：正值 = 扣完成本后每次换仓仍有正期望 */
    margin: (winRate != null && breakEven != null) ? (winRate - breakEven) * 100 : null,
    /* 保守边际 = 95%CI 下界 − 盈亏平衡胜率（pp）：按最不利样本估计仍为正才算"可信" */
    consMargin: (ci && breakEven != null) ? (ci[0] - breakEven) * 100 : null,
    nIncl: incl.length, winsIncl: incl.filter((s) => s.win === true).length,
    winRateIncl: incl.length ? incl.filter((s) => s.win === true).length / incl.length : null,
    avgExc: mean(excs), sumExc: excs.length ? excs.reduce((a, b) => a + b, 0) : null,
    avgHoldDays: mean(closed.map((s) => s.days)),
    tradesPerYear: nSwitch / years,
    total: total * 100, ann: ann * 100, mdd: maxDrawdown(equity),
    cashDays: holdings.filter((h) => h === null).length,
    exDivN: trades.filter((t) => t.kind === 'switch' && t.exDiv).length,
    exDivClosedN: exDivClosed.length, exDivWins: exDivClosed.filter((s) => s.win === true).length,
    openRet: openSeg.length ? (openSeg[openSeg.length - 1].ret != null ? openSeg[openSeg.length - 1].ret * 100 : null) : null,
  };
}

/* 阈值网格扫描：每档 Δ 跑一遍（含换仓次数，样本量随 Δ 上升而下降，务必与胜率并看） */
export function sweep(m, baseOpts, grid) {
  return (grid || defaultGrid(baseOpts && baseOpts.unit)).map((th) => {
    const res = simulate(m, { ...baseOpts, threshold: th });
    return { threshold: th, ...statsOf(res, baseOpts) };
  });
}

/* 阈值选择结论：在「样本充分 + 近期仍在触发」的档里挑保守边际最大者，并给出更激进的高确信档
   选择规则（页面公示同一套）：
     · 每档统计 已了结换仓数 / 胜率(95%CI) / 盈亏平衡胜率 / 真实边际 / 保守边际 / 达标频率 / 近1年触发数
     · 主推荐 = 已了结 ≥ 12 次 且 近1年触发 ≥ 3 次的档中，保守边际最大者（样本不足则退到下一档规则）
     · 保守边际 = 95%CI 下界 − 盈亏平衡胜率（比点估计更保守，避免"看着最漂亮但样本最少"的档胜出）
     · 高确信档 = 已了结 ≥ 8 次且真实边际 > 0 的档中保守边际最大者（通常阈值更高、机会更少）
*/
export const CONCLUSION_MIN_CLOSED = 12;
export const CONCLUSION_MIN_RECENT = 3;
export const CONCLUSION_MIN_STRONG = 8;

export function conclusion(m, baseOpts = {}, grid) {
  const unit = baseOpts.unit === '%' ? '%' : '元';
  const list = (grid || defaultGrid(unit)).slice();
  const rows = list.map((th) => {
    const res = simulate(m, { ...baseOpts, threshold: th });
    const st = statsOf(res, baseOpts);
    const { days, total, share } = gapDayShare(m, th, unit);
    const byYear = {};
    for (const t of res.trades) {
      if (t.kind !== 'switch') continue;
      const y = t.date.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
    }
    return { threshold: th, ...st, gapDays: days, gapTotal: total, gapShare: share, byYear };
  });
  const pickBest = (arr) => arr.filter((r) => r.consMargin != null).reduce((a, b) => (a == null || b.consMargin > a.consMargin ? b : a), null);
  const main = pickBest(rows.filter((r) => r.nClosed >= CONCLUSION_MIN_CLOSED && r.nRecent >= CONCLUSION_MIN_RECENT));
  const best = main || pickBest(rows.filter((r) => r.nClosed >= CONCLUSION_MIN_STRONG));
  const strong = pickBest(rows.filter((r) => r.nClosed >= CONCLUSION_MIN_STRONG && r.margin != null && r.margin > 0 && (!best || r.threshold !== best.threshold)));
  return { rows, best, strong, tier: main ? 'main' : (best ? 'fallback' : 'none'), unit };
}


/* 买入持有对照（含分红、起点扣一次单边成本，与策略起点口径对称） */
export function benchmarks(m, opts = {}) {
  const o = { cost: 0.0005, includeDiv: true, ...opts };
  const { codes, dates, px, div } = m;
  const N = dates.length, cost = Math.max(0, Number(o.cost) || 0);
  const series = new Map();
  for (let k = 0; k < codes.length; k++) {
    const eq = new Array(N).fill(1);
    const p0 = px[k][0];
    if (p0 == null || !(p0 > 0)) { series.set(codes[k], eq); continue; }
    const sh = (1 - cost) / p0;
    let dv = 0;
    for (let i = 0; i < N; i++) {
      if (i > 0 && o.includeDiv) dv += sh * div[k][i];   // 起点当日买入不享受当日分红
      eq[i] = sh * px[k][i] + dv;
    }
    series.set(codes[k], eq);
  }
  const equal = new Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (const c of codes) s += series.get(c)[i];
    equal[i] = s / codes.length;
  }
  const totals = {};
  for (const c of codes) totals[c] = (series.get(c)[N - 1] - 1) * 100;
  totals.equal = (equal[N - 1] - 1) * 100;
  return { series, equal, totals };
}
