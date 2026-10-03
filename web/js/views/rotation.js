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

/* 默认标的（价格量级接近，元差口径才有意义）；视图默认取前两只配对，可自选替换 */
export const ROTATE_STOCKS = [
  { code: '000933', name: '神火股份' },
  { code: '000807', name: '云铝股份' },
  { code: '002128', name: '电投能源' },
];

/* 两两配对入参校验（槽位 A/B）：返回提示文案，合法返回 null */
export function pairError(codes) {
  const list = (codes || []).filter(Boolean);
  if (list.length < 2) return '请在两个槽位各选一只标的（A / B）';
  if (new Set(list).size < list.length) return '两个槽位不能是同一只标的';
  return null;
}

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

/* 各标的的共同可用区间：起点取各只最早交易日的最晚者，终点取各只最晚交易日的最早者 */
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

/* 逐日差价序列（固定前两只配对：diff = A − B，正 = A 贵；gap = |diff|）
   只返回两只当日都有行情的交易日；口径跟随 signalMode（raw = 不复权真实价）与 unit */
export function gapArray(m, unit = '元') {
  const out = [];
  if (!m || m.codes.length < 2) return out;
  for (let i = 0; i < m.dates.length; i++) {
    if (!m.has[0][i] || !m.has[1][i]) continue;
    const a = m.sig[0][i], b = m.sig[1][i];
    if (a == null || b == null) continue;
    const diff = unit === '%' ? (a / b - 1) * 100 : a - b;
    out.push({ i, date: m.dates[i], diff, gap: Math.abs(diff) });
  }
  return out;
}

/* 差价描述统计 + 直方图分桶 + 当前分位（分位用最近邻秩，确定性可测） */
export function spreadStat(m, unit = '元', bins = 20) {
  const arr = gapArray(m, unit);
  const n = arr.length, total = m && Array.isArray(m.dates) ? m.dates.length : 0;
  if (!n) return { n: 0, total, mean: null, sd: null, min: null, max: null, q: null, cur: null, signShare: null, flips: 0, bins: [], arr };
  const gaps = arr.map((x) => x.gap);
  const sum = gaps.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = gaps.slice().sort((x, y) => x - y);
  const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
  const q = { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
  const last = arr[n - 1];
  const cur = { ...last, pct: gaps.filter((g) => g <= last.gap).length / n };
  /* 符号翻转 = 贵的一侧切换次数（忽略 0 价差天） */
  let flips = 0, prev = 0;
  for (const x of arr) {
    const s = x.diff > 0 ? 1 : x.diff < 0 ? -1 : 0;
    if (s === 0) continue;
    if (prev !== 0 && s !== prev) flips++;
    prev = s;
  }
  const signShare = arr.filter((x) => x.diff > 0).length / n;
  const lo = sorted[0], hi = sorted[n - 1];
  const B = Math.max(1, Math.floor(Number(bins)) || 1);
  const width = hi > lo ? (hi - lo) / B : 0;
  const bk = width > 0
    ? Array.from({ length: B }, (_, k) => ({ lo: lo + k * width, hi: lo + (k + 1) * width, n: 0 }))
    : [{ lo, hi, n: 0 }];
  for (const g of gaps) {
    const k = width > 0 ? Math.min(B - 1, Math.floor((g - lo) / width)) : 0;
    bk[k].n++;
  }
  return { n, total, mean, sd, min: lo, max: hi, q, cur, signShare, flips, bins: bk, arr };
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

/* 阈值选择结论：在「证据够 + 平均每次超额为正」的档里挑净超额最大者，并给出更少但质量更高的高确信档
   选择规则（页面公示同一套）：
     · 每档统计 换仓次数/已了结/胜率(95%CI)/平衡胜率/真实边际/平均每次超额/净超额/达标频率/近1年触发数
     · 净超额 = 策略总收益 − 等权买入持有总收益（pp，已扣成本）
     · 入选门槛 = 已了结 ≥ EVID_MIN_CLOSED 且 平均每次超额 > 0（统一、低门槛，防止只有最低档样本够）
     · 主推荐 = 净超额最大者（±EXCESS_TIE_PP 内视为平局 → 平均每次超额高者 → 换手少者）
     · 高确信档 = 入选集合里 平均每次超额最大者（通常阈值更高、机会更少；与主推荐同档则为空）
   注：净超额以等权为基准，而策略起点固定持有 codes[0]，故含一份“起点标的强弱”的常数偏移；
       档位之间对比不受影响，但绝对值不等于“轮动贡献”
*/
export const EVID_MIN_CLOSED = 5;   // 入选门槛（统一、低）
export const EVID_FAIR = 8;         // 证据“偏少 / 充分”分界
export const EVID_GOOD = 12;        // 证据“充分”推荐阀值
export const EXCESS_TIE_PP = 1;     // 净超额平局容差（pp）

/* 推荐排序（纯函数，便于确定性单测）：返回 { eligible, best, strong } */
export function rankRows(rows, minClosed = EVID_MIN_CLOSED) {
  const eligible = (rows || []).filter((r) => r.nClosed >= minClosed && r.avgExc != null && r.avgExc > 0);
  if (!eligible.length) return { eligible, best: null, strong: null };
  const maxEx = Math.max(...eligible.map((r) => (r.excess == null ? -Infinity : r.excess)));
  const near = eligible.filter((r) => (r.excess == null ? -Infinity : r.excess) >= maxEx - EXCESS_TIE_PP);
  const best = near.reduce((a, b) => {
    if (!a) return b;
    if (b.avgExc !== a.avgExc) return b.avgExc > a.avgExc ? b : a;
    return b.nSwitch < a.nSwitch ? b : a;
  }, null);
  const maxAvg = eligible.reduce((a, b) => (!a || b.avgExc > a.avgExc ? b : a), null);
  return { eligible, best, strong: maxAvg && maxAvg !== best ? maxAvg : null };
}

export function conclusion(m, baseOpts = {}, grid) {
  const unit = baseOpts.unit === '%' ? '%' : '元';
  const list = (grid || defaultGrid(unit)).slice();
  const eqTotal = benchmarks(m, { cost: baseOpts.cost, includeDiv: baseOpts.includeDiv }).totals.equal;
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
    return { threshold: th, ...st, gapDays: days, gapTotal: total, gapShare: share, byYear, excess: st.total - eqTotal };
  });
  const { eligible, best, strong } = rankRows(rows);
  /* 门槛敏感性：3 / 5 / 8 三档下分别推荐什么（只需对已算好的 rows 重排，无额外计算） */
  const sensitivity = [3, EVID_MIN_CLOSED, EVID_FAIR].map((min) => {
    const b = rankRows(rows, min).best;
    return { min, threshold: b ? b.threshold : null, excess: b ? b.excess : null, nClosed: b ? b.nClosed : null };
  });
  /* 未入选但净超额最高的几档 —— 透明展示“为什么它没被推荐”，不静默丢弃 */
  const excluded = rows.filter((r) => !eligible.includes(r))
    .slice().sort((a, b) => (b.excess == null ? -Infinity : b.excess) - (a.excess == null ? -Infinity : a.excess)).slice(0, 3)
    .map((r) => ({ threshold: r.threshold, nClosed: r.nClosed, avgExc: r.avgExc, excess: r.excess,
      reason: r.nClosed < EVID_MIN_CLOSED ? `已了结 ${r.nClosed} 次（<${EVID_MIN_CLOSED}）` : '平均每次超额 ≤ 0' }));
  return { rows, best, strong, eligible, excluded, sensitivity, tier: best ? 'main' : 'none', unit, eqTotal };
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

/* 按交易日轴比例切分：idx = floor(N × ratio)，两侧各保证 ≥2 交易日（区间过短返回 null） */
export function splitIndex(dates, ratio = 0.7) {
  const N = Array.isArray(dates) ? dates.length : 0;
  if (N < 4) return null;
  const r = Math.min(0.9, Math.max(0.1, Number(ratio) || 0.7));
  const idx = Math.min(N - 2, Math.max(2, Math.floor(N * r)));
  return { idx, date: dates[idx], trainEnd: dates[idx - 1] };
}

/* 样本外专用的训练段选档：
   ① 优先沿用 conclusion 的正规规则（保守边际 + 已了结阈值）；
   ② 训练段无合格档时（低频策略常见，甚至整段零换仓）→ 退用「已了结最多者，并列取更小 Δ」
      （更易触发 = 验证段信息更多）；tier 标记 weak/nodata，页面对应提示
   返回 { row, tier } | null */
function pickTrainThreshold(conc) {
  if (conc.best) return { row: conc.best, tier: conc.best.nClosed >= EVID_FAIR ? 'main' : 'sparse' };
  const rows = conc.rows || [];
  if (!rows.length) return null;
  const pick = rows.slice().sort((a, b) => b.nClosed - a.nClosed || a.threshold - b.threshold)[0];
  return { row: pick, tier: pick.nSwitch > 0 ? 'sparse' : 'nodata' };
}

/* 样本外验证：训练段（前 ratio）选 Δ → 验证段（后 1−ratio）固定用该 Δ 打分
   口径全部复用 conclusion / simulate / statsOf / benchmarks；
   两侧必须重建矩阵（cumDiv 基准与停牌前向填充依赖窗口起点，不能切片） */
export function oosValidate({ codes, names, raw, divRows, signalMode = 'raw', baseOpts = {}, start = '', end = '', ratio = 0.7, grid, extraThreshold = null }) {
  const unit = baseOpts.unit === '%' ? '%' : '元';
  const list = (grid || defaultGrid(unit)).slice();
  const full = buildMatrix({ codes, names, raw, divRows, start, end, signalMode });
  const sp = splitIndex(full.dates, ratio);
  if (!sp) return { ok: false, reason: '区间过短，无法切分训练/验证' };
  const train = buildMatrix({ codes, names, raw, divRows, start, end: sp.trainEnd, signalMode });
  const test = buildMatrix({ codes, names, raw, divRows, start: sp.date, end, signalMode });
  if (train.dates.length < 2 || test.dates.length < 2) return { ok: false, reason: '切分后某一侧交易日不足' };
  const conc = conclusion(train, baseOpts, list);
  const picked = pickTrainThreshold(conc);
  if (!picked) return { ok: false, reason: '训练段没有可评估的档位' };
  const chosen = picked.row.threshold;
  const score = (matrix, threshold) => {
    const stats = statsOf(simulate(matrix, { ...baseOpts, threshold }), baseOpts);
    const base = benchmarks(matrix, { cost: baseOpts.cost, includeDiv: baseOpts.includeDiv }).totals.equal;
    return { threshold, stats, base, excessVsEqual: stats.total - base };
  };
  const testScore = score(test, chosen);
  const extra = (extraThreshold != null && Number(extraThreshold) !== Number(chosen)) ? score(test, extraThreshold) : null;
  const st = testScore.stats;
  let verdict = 'insufficient';
  if (st.nClosed >= 3) {
    const marginOk = st.margin != null && st.margin > 0;
    const excessOk = testScore.excessVsEqual > 0;
    verdict = marginOk && excessOk ? 'pass' : marginOk || excessOk ? 'weak' : 'fail';
  }
  return {
    ok: true,
    splitDate: sp.date,
    ratio: sp.idx / full.dates.length,
    train: { from: train.dates[0], to: train.dates[train.dates.length - 1], nDays: train.dates.length, tier: picked.tier, stats: picked.row },
    test: { from: test.dates[0], to: test.dates[test.dates.length - 1], nDays: test.dates.length, ...testScore },
    extra,
    chosen,
    strong: conc.strong ? conc.strong.threshold : null,
    verdict,
  };
}
