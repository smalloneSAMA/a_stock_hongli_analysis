#!/usr/bin/env node
/* 智能推荐 · 连续天数（streak）生成器
   口径见 docs/智能推荐-连续天数-设计方案.md：
     base   = recoScoreOf（不含连续加成）；在榜 = 该档 base ≥75 / 完美 = 三档 base 均 ≥75
     连续   = 在榜 且 今日分 ≥ 期内峰值 − 3.0（上涨不限，"创新高或峰值附近震荡"）
     加成   = 0~+5，只抬升展示分与排序，不改评级（n>0 已蕴含 base≥75，结构上不可能跨档）
   评分公式直接 import web/js/views/reco.js（单一来源，禁止在本文件复制公式）。
   web/js/package.json 的 {"type":"module"} 就是为这里让 Node 按 ESM 解析 web/js/*.js。

   单位约定：存储与产物用"整数十分位"（859 = 85.9，避免浮点噪声）；
            判定状态机 advanceStreak 用原始分数（75 / 3.0），在边界处换算。

   用法：
     node scripts/_reco_streak.mjs            # 追加当日 → 重算连续 → 写 web/data/reco_streak.json
     node scripts/_reco_streak.mjs --check    # 产物关系断言（禁硬编码数值）
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecoPool, recoScoreOf, STREAK_TOL } from '../web/js/views/reco.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.dirname(HERE);
const HIST_PATH = path.join(BASE, 'cache', '_推荐评分历史.json');
const OUT_PATH = path.join(BASE, 'web', 'data', 'reco_streak.json');
const REPLAY_DIR = path.join(BASE, 'cache', '_replay');

export const TOL = STREAK_TOL;   // 峰值回撤容差（分）：与前端同源，前端优先读产物里的 tol
export const ON_LINE = 75;       // 在榜门槛（评级=强烈推荐）
export const KEEP_DAYS = 120;    // 历史保留交易日数
export const PRESETS = ['稳健', '均衡', '进取'];
export const TABS = [...PRESETS, '完美'];

/* ── 纯函数（单测覆盖）────────────────────────────────────────── */

/* 分数→整数十分位（80.25 → 803） */
export const tenth = (s) => Math.round(s * 10);

/* 连续判定状态机：state = {n, since, peak}（分数）→ {state, reason}
   reason: 'new' 新上榜 / 'drop' 回落超容差 / 'off' 跌出榜单 / 'nodata' 缺数据 / null 延续 */
export function advanceStreak(state, score, date, tol = TOL) {
  const empty = { n: 0, since: null, peak: null };
  if (score == null) return { state: empty, reason: 'nodata' };
  if (score < ON_LINE) return { state: empty, reason: 'off' };
  if (!state || state.n === 0) return { state: { n: 1, since: date, peak: score }, reason: 'new' };
  if (score >= state.peak - tol) {
    return { state: { n: state.n + 1, since: state.since, peak: Math.max(state.peak, score) }, reason: null };
  }
  return { state: { n: 1, since: date, peak: score }, reason: 'drop' };
}

/* ── 评分（每日截面）──────────────────────────────────────────── */

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* 一个 analysis.json 截面 → {code: [稳健, 均衡, 进取]}（整数十分位，缺失 null） */
export function scoresOfDay(an, bt, m) {
  const byCode = an.by_code || {};
  const { all } = buildRecoPool(an, bt, m);
  const out = {};
  for (const r of all) {
    const t = PRESETS.map((p) => {
      const v = recoScoreOf(r, p, byCode, an);
      return v.s == null || !Number.isFinite(v.s) ? null : tenth(v.s);
    });
    if (t.every((x) => x === null)) continue;
    out[r.code] = t;
  }
  return out;
}

/* 三档（十分位）→ 完美 = 最小值（十分位）；任一缺失即 null */
const perfectOf = (t) => (t && t.every((x) => x !== null) ? Math.min(...t) : null);

/* 某 tab 在某一日的十分位分数 */
const scoreOf = (t, tab) => (tab === '完美' ? perfectOf(t) : (t ? t[PRESETS.indexOf(tab)] : null));

/* ── 历史读写（append-only，仅"当日"行可覆盖）──────────────────── */

function readHistory() {
  try {
    const h = load(HIST_PATH);
    return { dates: h.dates || [], scores: h.scores || {} };
  } catch {
    return { dates: [], scores: {} };
  }
}

function writeJSON(p, obj) {
  const txt = JSON.stringify(obj);
  let old = null;
  try { old = fs.readFileSync(p, 'utf8'); } catch { /* 首次 */ }
  if (old === txt) return false;                     // 内容一致不写盘（避免噪声提交）
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, txt, 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

/* ── 主流程 ──────────────────────────────────────────────────── */

export function build() {
  const bt = load(path.join(BASE, 'web', 'data', 'backtest.json'));
  const m = load(path.join(BASE, 'web', 'data', 'manifest.json'));
  const todayAn = load(path.join(BASE, 'web', 'data', 'analysis.json'));
  const todayDate = todayAn.date;
  if (!todayDate) throw new Error('analysis.json 缺 date 字段');

  /* 合并历史：历史行只增不改（append-only），仅当日可覆盖 */
  const hist = readHistory();
  const merged = { ...hist.scores };

  /* 每日截面：已有历史的回放文件直接跳过（省去重复解析），当日始终用生产产物 */
  const days = new Map();
  if (fs.existsSync(REPLAY_DIR)) {
    for (const f of fs.readdirSync(REPLAY_DIR).filter((x) => /^an_\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
      const d = f.slice(3, -5);                        // an_YYYY-MM-DD.json → YYYY-MM-DD
      if (d >= todayDate || d in merged) continue;
      days.set(d, scoresOfDay(load(path.join(REPLAY_DIR, f)), bt, m));
    }
  }
  days.set(todayDate, scoresOfDay(todayAn, bt, m));
  for (const [d, sc] of days) merged[d] = sc;

  let dates = Object.keys(merged).sort();
  let truncated = false;
  if (dates.length > KEEP_DAYS) {
    truncated = true;
    for (const d of dates.slice(0, dates.length - KEEP_DAYS)) delete merged[d];
    dates = dates.slice(dates.length - KEEP_DAYS);
  }
  writeJSON(HIST_PATH, { version: 1, truncated, dates, scores: merged });

  /* 逐日递推（4 个 tab 各自独立） */
  const state = {};      // code -> tab -> {n, since, peak}
  const onDays = {};     // code -> tab -> 累计在榜天数
  const maxN = {};       // code -> tab -> 历史最长
  const brk = {};        // code -> tab -> 最近一次断因
  for (const d of dates) {
    const day = merged[d] || {};
    const codes = new Set([...Object.keys(day), ...Object.keys(state)]);
    for (const c of codes) {
      const t = day[c] || null;
      state[c] = state[c] || {};
      onDays[c] = onDays[c] || {};
      maxN[c] = maxN[c] || {};
      brk[c] = brk[c] || {};
      for (const tab of TABS) {
        const sc = scoreOf(t, tab);
        const r = advanceStreak(state[c][tab], sc == null ? null : sc / 10, d);
        state[c][tab] = r.state;
        brk[c][tab] = r.reason;
        if (sc != null && sc >= ON_LINE * 10) onDays[c][tab] = (onDays[c][tab] || 0) + 1;
        maxN[c][tab] = Math.max(maxN[c][tab] || 0, r.state.n);
      }
    }
  }

  /* 产物：只保留"当前在某榜或历史有过在榜"的标的，前端缺省按 0 处理 */
  const todayDay = merged[todayDate] || {};
  const byCode = {};
  for (const c of Object.keys(state)) {
    const d = {}, on = {}, mx = {};
    let keep = false;
    for (const tab of TABS) {
      const s = state[c][tab] || { n: 0, since: null, peak: null };
      d[tab] = {
        n: s.n,
        since: s.since,
        peak: s.peak == null ? null : tenth(s.peak),
        today: scoreOf(todayDay[c] || null, tab),
        brk: s.n > 1 ? null : (brk[c][tab] || null),
      };
      on[tab] = onDays[c][tab] || 0;
      mx[tab] = maxN[c][tab] || 0;
      if (s.n > 0 || on[tab] > 0) keep = true;
    }
    if (keep) byCode[c] = { d, on, max: mx };
  }

  const out = {
    date: todayDate,
    tol: TOL,
    on_line: ON_LINE,
    history_days: dates.length,
    history_from: dates[0] || null,
    truncated,
    by_code: byCode,
  };
  const wrote = writeJSON(OUT_PATH, out);
  return { out, wrote, todayScores: todayDay, dates };
}

/* ── 关系断言（禁硬编码数值）──────────────────────────────────── */

export function check(out, todayScores) {
  const errs = [];
  const ON = out.on_line * 10;                    // 十分位门槛
  if (!(out.history_days >= 1)) errs.push('history_days < 1');
  if (!out.history_from) errs.push('缺 history_from');
  if (!out.by_code || !Object.keys(out.by_code).length) errs.push('by_code 为空');
  for (const [code, e] of Object.entries(out.by_code || {})) {
    const t = todayScores[code] || null;
    for (const tab of TABS) {
      const s = e.d[tab];
      const sc = scoreOf(t, tab);
      if (s.n > 0 && !(sc != null && sc >= ON)) errs.push(`${code}/${tab}: n=${s.n} 但今日不在榜（${sc}）`);
      if (s.n === 0 && sc != null && sc >= ON) errs.push(`${code}/${tab}: 今日在榜但 n=0`);
      if (s.n > 0 && !(e.on[tab] >= s.n)) errs.push(`${code}/${tab}: on(${e.on[tab]}) < n(${s.n})`);
      if (e.max[tab] < s.n) errs.push(`${code}/${tab}: max(${e.max[tab]}) < n(${s.n})`);
      if (s.n > 0 && !s.since) errs.push(`${code}/${tab}: n>0 但缺 since`);
      if (s.today != null && s.peak != null && s.today > s.peak) errs.push(`${code}/${tab}: 今日分高于峰值`);
    }
  }
  return errs;
}

/* ── CLI ────────────────────────────────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isCheck = process.argv.includes('--check');
  const { out, wrote, todayScores } = build();
  const maxOf = (e) => Math.max(...TABS.map((t) => e.d[t].n));
  const top = Object.entries(out.by_code).map(([c, e]) => [c, maxOf(e)])
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`═══ 连续天数（数据日 ${out.date}，历史 ${out.history_days} 日${out.truncated ? '，已截断' : ''}，容差 ${out.tol}）═══`);
  console.log(`产物${wrote ? '已更新' : '无变化'}：web/data/reco_streak.json（${Object.keys(out.by_code).length} 标的）`);
  console.log(`最长连续 TOP：${top.map(([c, n]) => `${c}:${n}天`).join('  ') || '—'}`);
  console.log(`各 tab 在榜：${TABS.map((t) => `${t} ${Object.values(out.by_code).filter((e) => e.d[t].n > 0).length}`).join(' / ')}` +
    `｜连续≥3天：${Object.values(out.by_code).filter((e) => maxOf(e) >= 3).length}`);
  if (isCheck) {
    const errs = check(out, todayScores);
    if (errs.length) {
      console.error(`\n❌ 关系断言失败 ${errs.length} 项：`);
      for (const e of errs.slice(0, 20)) console.error('  - ' + e);
      process.exit(1);
    }
    console.log('✅ 关系断言全部通过');
  }
}
