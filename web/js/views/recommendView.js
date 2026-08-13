/* 视图：智能推荐（信号扫描 × 回测报告 × 区间分析 三维融合推荐）
   推荐分 = w_dy×dy分位(高=便宜) + w_ana×(100−贵贱度分) + w_bt×回测分（0~100，越高越推荐）
   回测分 = 0.4×win12 + 0.4×max(0,ex12) + 20×min(1,n_buy/20)（胜率40% + 超额40%[负计0] + 样本可信20%[≥20次满额]）
   dy 分位 ≥90（信号触发中，与回测 p90 同口径）→ 推荐分 +5 并标记
   过滤：无回测覆盖（21只）或近5年从未触发买入信号（66只）的标的直接过滤 → 候选池 303
   数据：cache/analysis_dy.json + web/data/analysis.json + web/data/backtest.json(by_p.90) */

import { loadJSON, MANIFEST_URL, ANALYSIS_URL, BACKTEST_URL } from '../data.js';
import { el, fmt2, dirOf, skeleton, errorBox, renderTable, favStar } from './common.js';

const DY_URL = '/cache/analysis_dy.json';

/* 三档权重（用户确认：稳健 50/25/25、均衡 35/30/35、进取 25/25/50） */
const W = {
  稳健: { dy: 50, ana: 25, bt: 25 },
  均衡: { dy: 35, ana: 30, bt: 35 },
  进取: { dy: 25, ana: 25, bt: 50 },
};
const bandOf = (s) => (s >= 75 ? '强烈推荐' : s >= 60 ? '推荐' : s >= 45 ? '关注' : '回避');
const bandCls = (b) => ({ 强烈推荐: 'band-buy', 推荐: 'band-build', 关注: 'band-hold', 回避: 'band-sell2' }[b] || 'band-hold');
/* 三档打分说明（悬停提示 + 动态标签 + 底部对照表） */
const PRESET_DESC = {
  稳健: { w: 'dy 50% · 贵贱度 25% · 回测 25%', tip: '股息为王：股息率分位占一半，最看重“便宜”与分红确定性' },
  均衡: { w: 'dy 35% · 贵贱度 30% · 回测 35%', tip: '三分均衡：当前状态与历史胜率并重，默认档' },
  进取: { w: 'dy 25% · 贵贱度 25% · 回测 50%', tip: '回测弹性：历史超额表现占半，追求进攻性' },
};

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton());
    try {
      const [dy, an, bt, m] = await Promise.all([loadJSON(DY_URL), loadJSON(ANALYSIS_URL), loadJSON(BACKTEST_URL), loadJSON(MANIFEST_URL)]);
      root.innerHTML = '';
      const byCode = an.by_code || {};
      const btMap = new Map((bt.by_p['90'] || []).map((x) => [x.code, x]));
      const meta = {};
      for (const s of (m.stocks || [])) meta[s.code] = s;

      /* 分组判定（推荐优先于自选，与信号扫描/回测一致） */
      const groupOf = (code, type) => {
        if (type === '指数') return '指数';
        if (type === 'ETF') return 'ETF';
        const s = meta[code] || {};
        if (s.rec) return '推荐20';
        if (s.watch) return '自选股';
        return '其他成份股';
      };

      /* 贵贱度综合分（同区间分析公式：presets[档][A/B] × 因子分位 ÷ 权重和，0=便宜→100=贵） */
      const anaScoreOf = (code, type, preset) => {
        const ent = byCode[code];
        if (!ent) return null;
        const w = an.presets[preset][type === '股票' ? 'B' : 'A'];
        let s = 0, tot = 0;
        for (const k in w) {
          const f = ent.factors[k];
          if (f && f.pct != null) { s += f.pct * w[k]; tot += w[k]; }
        }
        return tot ? s / tot : null;
      };

      /* 候选池：有回测记录且至少触发过一次买入信号（无回测/无信号直接过滤） */
      const all = [];
      let maxDate = '';
      for (const code in dy) {
        const d = dy[code];
        if (d.dy0 == null || d.dy_pct == null) continue;
        const b = btMap.get(code);
        if (!b || b.win12 == null) continue;   // 无回测 或 近5年无买入信号 → 过滤
        if (d.series && d.series.length) {
          const last = d.series[d.series.length - 1][0];
          if (last > maxDate) maxDate = last;
        }
        const type = d.type;
        const ent = byCode[code] || {};
        all.push({ code, name: d.name || code, type, group: groupOf(code, type),
          dy: d.dy_now, pct: d.dy_pct, close: d.close_now,
          anchor: (ent.anchors && ent.anchors.buy) ?? null,
          pr: (type === '股票' ? (meta[code]?.last_pr ?? null) : null),   // 市赚率PR（仅股票，指数/ETF 无财报）
          ...b });
      }

      /* 横截面绝对股息率分位（候选池内，高=股息率高）：高股息股不吃亏，且不受全市场估值水平影响 */
      const dyVals = all.map((r) => r.dy).filter((v) => v != null).sort((a, b) => a - b);
      for (const r of all) {
        if (r.dy == null || !dyVals.length) { r.crossPct = 0; continue; }
        const lo = dyVals.indexOf(r.dy), hi = dyVals.lastIndexOf(r.dy);
        r.crossPct = dyVals.length > 1 ? (lo + hi) / 2 / (dyVals.length - 1) * 100 : 100;
      }

      let preset = '均衡';
      let perfect = false;   // 完美模式：三档（稳健/均衡/进取）推荐分均 ≥75 的共识标的
      let typeF = '全部';

      /* 回测分（v3·信号能力评估）：胜率12M 40% + 胜率6M 15%（时效） + 超额12M 25%（负计0）
         + 绝对收益 max(0,超额+基准) 10%（回答"信号买入后绝对赚不赚"，大秦铁路类得 0 分）
         + 样本可信 10（≥20次满额，置信度配角不主导排序） + 时效修正±5 */
      const btScore = (r) => {
        const w6 = r.win6 == null ? r.win12 : r.win6;   // win6 缺失时按 win12（时效修正归零）
        const trend = Math.max(-5, Math.min(5, (w6 - r.win12) * 0.05));   // 近期信号变强加分/变弱减分
        const absRet = (r.ex12 ?? 0) + (r.base12 ?? 0);   // 绝对收益（超额+基准）
        return 0.4 * r.win12 + 0.15 * w6 + 0.25 * Math.max(0, r.ex12 ?? 0)
          + 0.1 * Math.max(0, absRet) + 10 * Math.min(1, r.n_buy / 20) + trend;
      };
      /* 与档位无关的公共部分（dy混合分/背离/触发） + 按档位算分 */
      const baseOf = (r) => {
        const pricePct = byCode[r.code] && byCode[r.code].factors && byCode[r.code].factors.price ? byCode[r.code].factors.price.pct : null;
        const diverge = (r.pct >= 90 && pricePct != null && pricePct >= 80) ? 5 : 0;   // 周期股假便宜
        const trig = r.pct >= 90 ? 5 : (r.pct <= 10 ? -5 : 0);   // 触发中 +5 / 卖出区 −5
        const dyPart = 0.5 * (r.crossPct ?? 0) + 0.5 * r.pct;   // dy 混合分：横截面50% + 历史50%
        return { dyPart, diverge, trig };
      };
      const scoreWith = (r, pname, base) => {
        const w = W[pname];
        const ana = anaScoreOf(r.code, r.type, pname);
        const sAna = ana == null ? 0 : 100 - ana;
        const bt = btScore(r);
        let s = (w.dy * base.dyPart + w.ana * sAna + w.bt * bt) / 100 + base.trig - base.diverge;
        s = Math.max(0, Math.min(100, s));
        return { s, dyPart: base.dyPart, anaPart: sAna, btPart: bt, diverge: base.diverge, trig: base.trig };
      };
      const recOf = (r) => scoreWith(r, preset, baseOf(r));
      /* 完美模式：三档全算完整分项（毫秒级，无需缓存） */
      const scoresOf = (r) => {
        const base = baseOf(r);
        return { 稳健: scoreWith(r, '稳健', base), 均衡: scoreWith(r, '均衡', base), 进取: scoreWith(r, '进取', base) };
      };

      /* 跳转对应板块历史K线：__openTicker 兜底（视图未挂载时挂载后消费）+ open-ticker 事件（已挂载即响应） */
      const goTicker = (r) => {
        const view = r.type === '指数' ? 'index' : r.type === 'ETF' ? 'etf' : 'stock';
        window.__openTicker = { code: r.code, name: r.name };
        if (location.hash === `#/${view}`) {
          window.dispatchEvent(new CustomEvent('open-ticker', { detail: { code: r.code, name: r.name } }));
        } else {
          location.hash = `#/${view}`;
          /* 视图容器常驻：已挂载视图不会重新 mount（__openTicker 仅在首次挂载时被消费），
             必须再派发事件让已挂载视图响应选中；未挂载场景事件无监听者，由 __openTicker 兜底 */
          window.dispatchEvent(new CustomEvent('open-ticker', { detail: { code: r.code, name: r.name } }));
        }
      };

      root.append(el('div', { class: 'view-head' },
        el('h1', {}, '智能推荐'),
        el('div', { class: 'desc' }, '信号扫描 × 回测报告 × 区间分析 三维融合：dy分位（高=便宜）+ 贵贱度反向 + 回测胜率/超额/样本')));

      const presetSel = el('div', { class: 'seg-group', role: 'group', 'aria-label': '权重档位' });
      const presetNote = el('span', { class: 'txt-3', style: 'font-size:11.5px;white-space:nowrap' });   // 当前档位权重动态说明
      const typeSel = el('select', { class: 'ind-filter', 'aria-label': '类型筛选', title: '按类型筛选（个股=池内全部股票）' },
        ['全部', '指数', 'ETF', '个股'].map((t) => el('option', { value: t }, t)));
      const sumEl = el('div', { class: 'bt-summary' });
      const tableBox = el('div', { class: 'card table-card rec-table-card' }, el('div', { class: 'table-wrap' }, ''));
      root.append(sumEl,
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 2px' }, presetSel, presetNote, typeSel),
        tableBox,
        el('div', { class: 'txt-3', style: 'font-size:11.5px;margin:8px 2px;line-height:1.7' },
          '推荐分 = w_dy×dy分 + w_ana×(100−贵贱度分) + w_bt×回测分，另加/减：触发中+5、卖出区−5、背离(dy≥90且价格分位≥80)−5；最终限幅 0~100。',
          'dy分 = 横截面绝对分位×50% + 历史分位×50%：横截面=候选池内当前股息率排名（高股息股不吃亏，不受全市场估值水平影响），历史分位=自身近5年位置（择时）；触发/卖出/背离判定仍用历史分位。',
          '回测分 = 0.40×胜率12M + 0.15×胜率6M + 0.25×max(0,超额12M) + 0.10×max(0,超额12M+基准12M，绝对收益) + 10×min(1,信号数/20) + 时效修正(胜率6M−12M)×0.05(限±5)。',
          'dy分位≥90 = 信号触发中（与回测 p90 同口径）；无回测覆盖或近5年从未触发买入信号的标的已过滤。',
          '贵贱度分按类型用对应因子组（指数/ETF 四因子、股票六因子），类型内可比；悬停推荐分可见三项子分与惩罚明细。',
          '档位对照：稳健 dy50%/贵贱度25%/回测25% —— 股息为王，便宜优先；均衡 35%/30%/35% —— 三分均衡（默认档）；进取 25%/25%/50% —— 回测弹性，历史超额驱动。切档只改变权重与排序，候选池与评级阈值不变。',
          '评级：≥75 强烈推荐 / ≥60 推荐 / ≥45 关注 / <45 回避。回测为历史统计（p90 信号次一交易日买入，价格口径不含分红再投），非投资建议。',
          '推荐分旁箭头 = 相比上一数据版本的变化（红升绿降，差值=分数差）；悬停推荐分可见变化原因（主要因哪个因子）。首次打开/同版本无对比。',
          '完美 = 稳健/均衡/进取三档权重下均为强烈推荐（≥75 分），代表估值、股息、回测三个视角的共识；悬停推荐分可见三档明细。'));

      /* ── 分数对比快照：相比“上一数据版本”的推荐分变化（localStorage）
         版本标记 = analysis_dy 序列最新日期（行情/分红更新即变）；
         版本变化时对比旧快照并刷新；同版本/首次打开无对比 */
      let oldSnap = null;
      try { oldSnap = JSON.parse(localStorage.getItem('pi_rec_scores') || 'null'); } catch { oldSnap = null; }
      const snapDate = maxDate || m.data_date || '';
      const hasBase = !!(oldSnap && oldSnap.date && oldSnap.date !== snapDate && oldSnap.codes);
      const hasAnySnap = !!(oldSnap && oldSnap.codes);
      const curSnap = { date: snapDate, codes: {} };
      if (snapDate) {
        for (const r of all) {
          const sc = scoresOf(r);
          curSnap.codes[r.code] = {
            稳健: { s: sc['稳健'].s, dyPart: sc['稳健'].dyPart, cross: r.crossPct ?? 0, hist: r.pct, anaPart: sc['稳健'].anaPart, btPart: sc['稳健'].btPart, trig: sc['稳健'].trig, diverge: sc['稳健'].diverge },
            均衡: { s: sc['均衡'].s, dyPart: sc['均衡'].dyPart, cross: r.crossPct ?? 0, hist: r.pct, anaPart: sc['均衡'].anaPart, btPart: sc['均衡'].btPart, trig: sc['均衡'].trig, diverge: sc['均衡'].diverge },
            进取: { s: sc['进取'].s, dyPart: sc['进取'].dyPart, cross: r.crossPct ?? 0, hist: r.pct, anaPart: sc['进取'].anaPart, btPart: sc['进取'].btPart, trig: sc['进取'].trig, diverge: sc['进取'].diverge },
          };
        }
        try { localStorage.setItem('pi_rec_scores', JSON.stringify(curSnap)); } catch { /* 忽略 */ }
      }
      /* 归因一句话 + 差值（当前档）：Δ贡献 = w_dy%×Δdy + w_ana%×Δana + w_bt%×Δbt + Δ触发 − Δ背离 */
      const LAB = { dy: 'dy', ana: '贵贱度', bt: '回测', trig: '触发', div: '背离' };
      const whyDelta = (code, 档) => {
        if (!hasBase) return null;
        const old = oldSnap.codes[code]?.[档], cur = curSnap.codes[code]?.[档];
        if (!old || !cur) return null;   // 新上榜/数据缺失 → 无对比
        const w = W[档];
        const dDy = cur.dyPart - old.dyPart, dAna = cur.anaPart - old.anaPart, dBt = cur.btPart - old.btPart;
        const dTri = (cur.trig || 0) - (old.trig || 0), dDiv = (cur.diverge || 0) - (old.diverge || 0);
        const contrib = { dy: w.dy / 100 * dDy, ana: w.ana / 100 * dAna, bt: w.bt / 100 * dBt, trig: dTri, div: -dDiv };
        const total = contrib.dy + contrib.ana + contrib.bt + contrib.trig + contrib.div;
        const arrow = total > 0.05 ? '↑' : total < -0.05 ? '↓' : '→';
        const [mk, mv] = Object.entries(contrib).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
        const desc = {
          dy: `股息率分位${dDy >= 0 ? '上升' : '下降'}（横截面 ${Math.round(old.cross)}→${Math.round(cur.cross)}）`,
          ana: dAna >= 0 ? '贵贱度改善（更便宜）' : '贵贱度转贵',
          bt: `回测分${dBt >= 0 ? '改善' : '下滑'}`,
          trig: dTri > 0 ? '进入触发区（dy分位≥90）+5' : dTri < 0 ? '退出触发区 −5' : '',
          div: dDiv > 0 ? '背离惩罚 −5' : dDiv < 0 ? '背离解除 +5' : '',
        }[mk];
        const others = Object.entries(contrib).filter(([k]) => k !== mk)
          .map(([k, v]) => `${LAB[k]} ${v >= 0 ? '+' : ''}${v.toFixed(1)}`).join(' · ');
        return { total, text: `${arrow} 总分 ${total >= 0 ? '+' : ''}${total.toFixed(1)}：主要因${desc}（贡献 ${mv >= 0 ? '+' : ''}${mv.toFixed(1)}）${others ? '；另 ' + others : ''}` };
      };
      /* 完美模式：三档均值差 */
      const deltaMean = (code) => {
        if (!hasBase) return null;
        const old = oldSnap.codes[code], cur = curSnap.codes[code];
        if (!old || !cur) return null;
        const om = (old['稳健'].s + old['均衡'].s + old['进取'].s) / 3;
        const cm = (cur['稳健'].s + cur['均衡'].s + cur['进取'].s) / 3;
        const total = cm - om;
        const arrow = total > 0.05 ? '↑' : total < -0.05 ? '↓' : '→';
        return { total, text: `${arrow} 三档均值 ${om.toFixed(1)} → ${cm.toFixed(1)}（${total >= 0 ? '+' : ''}${total.toFixed(1)}）` };
      };

      const paint = () => {
        presetSel.innerHTML = '';
        for (const p of ['稳健', '均衡', '进取', '完美']) {
          const active = p === '完美' ? perfect : (!perfect && preset === p);
          presetSel.append(el('button', {
            class: 'seg-btn' + (active ? ' active' : ''),
            title: p === '完美' ? '三档（稳健/均衡/进取）推荐分均 ≥75 的共识标的——最强信号' : `${p}：${PRESET_DESC[p].w} —— ${PRESET_DESC[p].tip}`,
            onclick: () => { if (p === '完美') perfect = true; else { perfect = false; preset = p; } paint(); },
          }, p));
        }
        presetNote.textContent = perfect ? '当前：完美 → 三档均≥75 共识（按三档均值排序）' : `当前：${preset} → ${PRESET_DESC[preset].w}`;
        const rows = perfect
          ? all
            .filter((r) => (typeF === '全部' ? true : typeF === '个股' ? r.type === '股票' : r.type === typeF))
            .map((r) => ({ ...r, _sc: scoresOf(r) }))
            .filter((r) => r._sc['稳健'].s >= 75 && r._sc['均衡'].s >= 75 && r._sc['进取'].s >= 75)
            .map((r) => ({
              ...r,
              s: (r._sc['稳健'].s + r._sc['均衡'].s + r._sc['进取'].s) / 3,
              anaPart: r._sc['均衡'].anaPart,   // 贵贱度分列：均衡档代表值（悬停见三档明细）
              dyPart: r._sc['均衡'].dyPart, btPart: r._sc['均衡'].btPart,
              cross: r.crossPct ?? 0, hist: r.pct,
            }))
            .sort((a, b) => (b.s - a.s) || ((b.pct >= 90 ? 1 : 0) - (a.pct >= 90 ? 1 : 0)) || (b.pct - a.pct))
          : all
            .filter((r) => (typeF === '全部' ? true : typeF === '个股' ? r.type === '股票' : r.type === typeF))
            .map((r) => ({ ...r, ...recOf(r) }))
            .sort((a, b) => (b.s - a.s) || ((b.pct >= 90 ? 1 : 0) - (a.pct >= 90 ? 1 : 0)) || (b.pct - a.pct));

        sumEl.innerHTML = '';
        sumEl.append(
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '数据日期'), el('b', {}, maxDate || m.data_date || '—')),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '候选池'), el('b', {}, rows.length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, perfect ? '完美' : '强烈推荐'), el('b', { class: 'txt-up' }, rows.filter((r) => (perfect ? true : bandOf(r.s) === '强烈推荐')).length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '推荐'), el('b', { class: 'txt-up' }, rows.filter((r) => bandOf(r.s) === '推荐').length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '触发中'), el('b', { class: 'txt-up' }, rows.filter((r) => r.pct >= 90).length)));

        const cols = [
          { key: 'fav', label: '★', align: 'center', sortable: false, filter: false, fmt: (_v, row) => favStar(row.code) },
          { key: 'code', label: '代码', align: 'left', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
          { key: 'name', label: '名称', align: 'left', sortable: true,
            fmt: (v, row) => el('div', {},
              el('a', { href: '#', onclick: (e) => { e.preventDefault(); goTicker(row); }, class: 'jump-link', title: '查看历史K线（' + row.type + '）' }, v),
              el('div', { class: 'rec-sub' }, row.type + (row.group ? ' · ' + row.group : ''))) },
          { key: 's', label: '推荐分', sortable: true,
            fmt: (v, row) => {
              const d = perfect ? deltaMean(row.code) : whyDelta(row.code, preset);
              const baseTitle = perfect
                ? `稳健 ${fmt2(row._sc['稳健'].s)} · 均衡 ${fmt2(row._sc['均衡'].s)} · 进取 ${fmt2(row._sc['进取'].s)}（三档均≥75 入选，按均值排序）`
                : `dy 横截面 ${fmt2(row.cross)} ×50% + 历史 ${fmt2(row.hist)} ×50% = ${fmt2(row.dyPart)} × ${W[preset].dy}% + 贵贱度反向 ${fmt2(row.anaPart)} × ${W[preset].ana}% + 回测 ${fmt2(row.btPart)} × ${W[preset].bt}%${row.trig > 0 ? ' + 触发中 5' : row.trig < 0 ? ' − 卖出区 5' : ''}${row.diverge ? ' − 背离 5' : ''}`;
              const title = baseTitle + (d ? '\n' + d.text : hasBase ? '' : '\n' + (hasAnySnap ? '本数据版本无变化' : '首次记录，暂无对比'));
              return el('span', { title },
                fmt2(v),
                d && Math.abs(d.total) > 0.05
                  ? el('span', { class: 'rec-delta ' + (d.total > 0 ? 'up' : 'down') }, ` ${d.total > 0 ? '↑' : '↓'}${Math.abs(d.total).toFixed(1)}`)
                  : null);
            },
            color: (v) => (v >= 75 ? 'up' : v >= 60 ? 'flat' : '') },
          { key: 'band', label: '评级', sortable: true, filter: false,
            fmt: (_v, row) => perfect
              ? el('span', { class: 'band-pill band-perfect', title: '稳健/均衡/进取三档均 ≥75 的共识标的' }, '完美')
              : el('span', { class: 'band-pill ' + bandCls(bandOf(row.s)) }, bandOf(row.s)) },
          { key: 'dy', label: '股息率(%)', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)) },
          { key: 'pct', label: 'dy分位', sortable: true,
            fmt: (v, row) => el('div', {},
              el('span', {}, v == null ? '—' : fmt2(v)),
              el('span', { class: 'rec-sub' }, '横 ' + (row.crossPct == null ? '—' : fmt2(row.crossPct)))),
            color: (v) => (v >= 90 ? 'up' : v <= 10 ? 'down' : '') },
          { key: 'trig', label: '状态', sortable: false, filter: false,
            fmt: (_v, row) => (row.pct >= 90 ? el('span', { class: 'trig-badge' }, '触发中')
              : row.pct <= 10 ? el('span', { class: 'trig-badge sell' }, '卖出区')
              : el('span', { class: 'txt-3' }, '—')) },
          { key: 'anaPart', label: '贵贱度分', sortable: true, filter: false,
            fmt: (v, row) => (v == null ? '—' : el('span', { title: perfect ? `贵贱度反向分（按档位权重）：稳健 ${fmt2(row._sc['稳健'].anaPart)} · 均衡 ${fmt2(row._sc['均衡'].anaPart)} · 进取 ${fmt2(row._sc['进取'].anaPart)}` : null }, fmt2(v))),
            color: (v) => (v != null && v <= 25 ? 'up' : v != null && v >= 80 ? 'down' : '') },
          { key: 'pr', label: 'PR市赚率', sortable: true, filter: false,
            fmt: (v) => (v == null ? '—' : el('span', { title: 'PE-TTM ÷ 近5年TTM年化ROE；<1 低估、≈1 合理、>1 高估；仅股票（指数/ETF 无财报）' }, fmt2(v))),
            color: (v) => (v != null && v < 0.7 ? 'up' : v != null && v > 1.5 ? 'down' : '') },
          { key: 'win6', label: '胜率', sortable: true,
            fmt: (v, row) => el('div', {},
              el('span', {}, v == null ? '—' : fmt2(v)),
              el('span', { class: 'rec-sub' }, '12M ' + (row.win12 == null ? '—' : fmt2(row.win12)))) },
          { key: 'base12', label: '基准12M(%)', sortable: true, fmt: (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)), color: (v) => dirOf(v) },
          { key: 'ex6', label: '超额', sortable: true,
            fmt: (v, row) => el('div', {},
              el('span', {}, v == null ? '—' : (v >= 0 ? '+' : '') + fmt2(v)),
              el('span', { class: 'rec-sub' }, '12M ' + (row.ex12 == null ? '—' : (row.ex12 >= 0 ? '+' : '') + fmt2(row.ex12)))),
            color: (v) => dirOf(v) },
          { key: 'n_buy', label: '信号数', sortable: true, filter: false },
          { key: 'close', label: '现价', sortable: true,
            fmt: (v, row) => el('div', {},
              el('span', {}, v == null ? '—' : fmt2(v)),
              el('span', { class: 'rec-sub' }, '买 ' + (row.anchor == null ? '—' : fmt2(row.anchor)))) },
        ];
        renderTable(tableBox.querySelector('.table-wrap'), { columns: cols, rows, pageSize: 50 });
      };

      typeSel.addEventListener('change', () => { typeF = typeSel.value; paint(); });
      paint();
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox(`智能推荐加载失败：${err.message}`, () => { root.innerHTML = ''; this.mount(root); }));
    }
  },
  dispose() {},
};
