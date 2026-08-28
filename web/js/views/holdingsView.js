/* 视图：我的持仓（真实交易台账 + 持仓决策面板，多持仓页签）
   台账 = 交易流水，唯一事实来源 cache/持仓.json（serve.py POST /api/holdings 原子写；localStorage 仅失败草稿）
   v2 多持仓页：{version:2, portfolios:[{id,name,preset,trades:[...]}]}，每页独立台账/持仓/盈亏/决策，档位每页记忆
   持仓/成本/盈亏：平均成本法重放（common.replayTrades）；累计分红：东财分红缓存按除权日分段归属（估算，不复投不摊薄成本）
   决策：与智能推荐同口径（reco.js 推荐分三档）+ 分红异常检查 + 卖出区检查；无回测覆盖标的回退 dy+贵贱度双条件
   动作映射：强烈推荐→加仓 / 推荐→持有偏加 / 关注→持有 / 回避→减仓；dy分位≤10→卖出（持仓亏损则减仓观察） */

import { loadJSON, MANIFEST_URL, ANALYSIS_URL, BACKTEST_URL } from '../data.js';
import { el, fmt2, fmt0, dirOf, skeleton, errorBox, emptyState, renderTable, openTicker, attachDatePicker, favStar,
  loadHoldings, saveHoldings, normalizeHoldings, replayTrades, allPositions, accruedDiv, refreshHoldMeta } from './common.js';
import { buildRecoPool, recoScoreOf, recoBandOf, recoBandCls, RECO_PRESET_DESC } from './reco.js';
import { scoreOf as anaScoreOf } from './analysis.js';

const DY_URL = '/cache/analysis_dy.json';
const DIV_PREFIX = '/cache/分红_';
const DRAFT_KEY = 'pi_holdings_draft';
const ACTIVE_KEY = 'pi_holdings_active';

export default {
  async mount(root) {
    root.innerHTML = '';
    root.append(skeleton());
    try {
      const [dy, an, bt, m] = await Promise.all([loadJSON(DY_URL), loadJSON(ANALYSIS_URL), loadJSON(BACKTEST_URL), loadJSON(MANIFEST_URL)]);
      let data = await loadHoldings();
      let curId = data.portfolios[0].id;
      try {
        const saved = localStorage.getItem(ACTIVE_KEY);
        if (saved && data.portfolios.some((p) => p.id === saved)) curId = saved;
      } catch { /* 忽略 */ }
      const byCode = an.by_code || {};
      const { all, maxDate } = buildRecoPool(dy, bt, an, m);
      const poolByCode = new Map(all.map((r) => [r.code, r]));
      /* 名称元信息（池内标的；池外标的无行情数据，仅记账） */
      const meta = {};
      for (const s of (m.indices || [])) meta[s.code] = s;
      for (const s of (m.etfs || [])) meta[s.code] = s;
      for (const s of (m.stocks || [])) meta[s.code] = s;
      /* 表单候选：全部股票+ETF（台账允许记池外标的，但无评估数据） */
      const candidates = [
        ...(m.stocks || []).map((s) => ({ code: s.code, name: s.name, kind: 'stock' })),
        ...(m.etfs || []).map((s) => ({ code: s.code, name: s.name, kind: 'etf' })),
      ];

      /* 当前持仓页（normalize 保证至少一页） */
      const cur = () => data.portfolios.find((p) => p.id === curId) || data.portfolios[0];

      /* 分红缓存：按全部持仓页的股票代码懒加载（跨页共享，切页不重拉；缺失/失败→null，分红列显示 —） */
      const divCache = new Map();
      const ensureDivs = async () => {
        const codes = [...new Set(data.portfolios.flatMap((p) => (p.trades || [])
          .filter((t) => t.kind === 'stock').map((t) => t.code)))];
        await Promise.all(codes.map(async (code) => {
          if (divCache.has(code)) return;
          try {
            const d = await loadJSON(DIV_PREFIX + code + '.json');
            divCache.set(code, (d.rows || []).map((r) => ({ date: r.ex_date, ps: (r.bonus10 || 0) / 10 }))
              .filter((e) => e.ps > 0).sort((a, b) => (a.date < b.date ? -1 : 1)));
          } catch { divCache.set(code, null); }
        }));
      };
      await ensureDivs();
      root.innerHTML = '';   // 清掉加载骨架屏，再渲染实际内容

      let formMode = 'buy';   // buy / sell
      let saveState = { ok: null, err: null };

      /* 持仓行构建（平均成本法重放，仅当前页） */
      const rowsOf = () => {
        const trades = cur().trades;
        const positions = allPositions(trades);
        const { sells } = replayTrades(trades);
        return positions.map((p) => {
          const dEnt = dy[p.code];
          const r = poolByCode.get(p.code) || null;
          /* 现价优先 manifest last_close（真实交易价格；ETF 的 dy.close_now 是跟踪指数点位） */
          const close = (meta[p.code] && meta[p.code].last_close != null) ? meta[p.code].last_close : (dEnt ? dEnt.close_now : null);
          const divs = divCache.get(p.code) || null;
          const divTotal = divs ? accruedDiv(trades, p.code, divs) : null;
          return { ...p, r, close, divs, divTotal, sells,
            name: (dEnt && dEnt.name) || (meta[p.code] && meta[p.code].name) || p.code,
            type: (dEnt && dEnt.type) || (p.kind === 'etf' ? 'ETF' : '股票'),
            pct: dEnt ? dEnt.dy_pct : null,
            dyNow: dEnt ? dEnt.dy_now : null };
        });
      };

      /* 决策（参考智能推荐规则，优先级自上而下命中即出） */
      const decide = (row) => {
        const pct = row.pct, close = row.close, avg = row.avg;
        const pnl = close != null ? (close / avg - 1) * 100 : null;
        const preset = cur().preset;
        /* 1. 分红异常：股票、有分红历史但最近除息距今 >400 天（约13个月无派息） */
        const divs = row.divs;
        if (divs && divs.length && maxDate) {
          const lastEx = divs[divs.length - 1].date;
          const days = (new Date(maxDate) - new Date(lastEx)) / 86400000;
          if (days > 400) return { act: '警惕', cls: 'band-warn', why: '近12个月无派息（最近除息 ' + lastEx + '），高股息逻辑可能失效，核查财报' };
        }
        /* 2. 卖出区（dy 历史分位 ≤10，与信号扫描同口径） */
        if (pct != null && pct <= 10) {
          if (pnl == null) return { act: '卖出', cls: 'band-sell2', why: 'dy 分位 ' + fmt2(pct) + '%（卖出区）：股息率处 5 年最低 10% 内' };
          if (pnl < 0) return { act: '减仓观察', cls: 'band-sell', why: 'dy 分位 ' + fmt2(pct) + '%（卖出区）但持仓亏损 ' + fmt2(pnl) + '%：个股卖出信号历史弱有效，建议分批减而非清仓' };
          return { act: '卖出', cls: 'band-sell2', why: 'dy 分位 ' + fmt2(pct) + '%（卖出区）且盈利 ' + fmt2(pnl) + '%：信号+盈利双确认，分批落袋' };
        }
        /* 3. 推荐分（候选池内，与智能推荐同口径） */
        if (row.r) {
          const sc = recoScoreOf(row.r, preset, byCode, an);
          const b = recoBandOf(sc.s);
          if (sc.s >= 75) return { act: '加仓', cls: 'band-buy', why: '推荐分 ' + fmt2(sc.s) + '（' + b + '）：dy分位 ' + fmt2(row.r.pct) + '% · 贵贱度反向 ' + fmt2(sc.anaPart) + ' · 回测 ' + fmt2(sc.btPart), sc };
          if (sc.s >= 60) return { act: '持有偏加', cls: 'band-build', why: '推荐分 ' + fmt2(sc.s) + '（' + b + '）：状态与历史胜率均衡，可逢低小步加仓', sc };
          if (sc.s >= 45) return { act: '持有', cls: 'band-hold', why: '推荐分 ' + fmt2(sc.s) + '（' + b + '）：维持现有仓位', sc };
          return { act: '减仓', cls: 'band-sell', why: '推荐分 ' + fmt2(sc.s) + '（' + b + '）：低于关注线，逐步减仓', sc };
        }
        /* 4. 回退：无回测覆盖/近5年无买入信号 → dy 分位 + 贵贱度双条件 */
        const ana = anaScoreOf(byCode[row.code], preset, row.type, an.presets);
        if (pct != null && pct >= 90) return { act: '加仓', cls: 'band-buy', why: 'dy 分位 ' + fmt2(pct) + '%（买入区，无回测覆盖，仅 dy 信号）' };
        if (ana != null && ana <= 25) return { act: '加仓', cls: 'band-buy', why: '贵贱度分 ' + fmt2(ana) + '（买入区间，无回测覆盖）' };
        if (ana != null && ana >= 80) return { act: '减仓', cls: 'band-sell', why: '贵贱度分 ' + fmt2(ana) + '（卖出区间，无回测覆盖）' };
        return { act: '持有', cls: 'band-hold', why: '无触发信号（无回测覆盖标的，仅记账与基础信息）' };
      };

      /* ── 保存（POST 落盘；失败降级 localStorage 草稿） ── */
      const persist = async () => {
        try {
          await saveHoldings(data);
          saveState = { ok: new Date().toLocaleTimeString('zh-CN', { hour12: false }), err: null };
          try { localStorage.removeItem(DRAFT_KEY); localStorage.setItem(ACTIVE_KEY, curId); } catch { /* 忽略 */ }
          await refreshHoldMeta(true);
          await ensureDivs();   // 新买入股票的分红缓存补齐
          paint();
        } catch (err) {
          saveState = { ok: saveState.ok, err: '保存失败（' + err.message + '）：请确认用 python serve.py 启动本页面；改动已留本地草稿' };
          try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
          paint();
        }
      };

      /* ── 持仓页操作：新增 / 重命名 / 删除（删除连同台账，至少保留一页） ── */
      const addPortfolio = () => {
        const defName = '持仓' + (data.portfolios.length + 1);
        const name = window.prompt('新持仓名称（留空自动命名为「' + defName + '」）', defName);
        if (name === null) return;   // 取消
        const id = 'p' + Date.now();
        data.portfolios.push({ id, name: (name.trim() || defName).slice(0, 20), preset: cur().preset, trades: [] });
        curId = id;
        persist();
      };
      const renamePortfolio = () => {
        const p = cur();
        const name = window.prompt('重命名持仓页', p.name);
        if (name === null || !name.trim() || name.trim() === p.name) return;
        p.name = name.trim().slice(0, 20);
        persist();
      };
      const delPortfolio = () => {
        if (data.portfolios.length <= 1) {
          window.alert('至少保留一个持仓页');
          return;
        }
        const p = cur();
        if (!window.confirm('删除持仓页「' + p.name + '」？将连同该页全部 ' + p.trades.length + ' 笔交易记录一起删除，且不可恢复。')) return;
        data.portfolios = data.portfolios.filter((x) => x.id !== p.id);
        curId = data.portfolios[0].id;
        persist();
      };

      /* ── DOM 骨架 ── */
      const tabsEl = el('div', { class: 'seg-group hld-tabs', role: 'tablist', 'aria-label': '持仓页签' });
      const saveBar = el('div', { class: 'hld-savebar' });
      const warnBar = el('div', {});
      const sumEl = el('div', { class: 'bt-summary' });
      const presetSel = el('div', { class: 'seg-group', role: 'group', 'aria-label': '权重档位' });
      const presetNote = el('span', { class: 'txt-3', style: 'font-size:11.5px;white-space:nowrap' });
      const tableBox = el('div', { class: 'card table-card' }, el('div', { class: 'table-wrap' }, ''));
      const ledgerBox = el('div', { class: 'card table-card' }, el('div', { class: 'table-wrap' }, ''));
      const formBox = el('div', {});

      root.append(el('div', { class: 'view-head' },
          el('h1', {}, '我的持仓'),
          el('div', { class: 'desc' }, '真实交易台账（平均成本法）· 多持仓页签 · 决策与智能推荐同口径（推荐分三档）+ 卖出区/分红异常检查')),
        tabsEl, saveBar, warnBar, sumEl,
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 2px' }, presetSel, presetNote),
        tableBox,
        el('div', { class: 'txt-3', style: 'font-size:11.5px;margin:8px 2px;line-height:1.7' },
          '决策优先级：① 分红异常（近12个月无派息）→ 警惕；② dy 分位≤10（卖出区）→ 卖出（持仓亏损则减仓观察）；',
          '③ 推荐分（与智能推荐同口径，切换权重档位会改变建议）：≥75 强烈推荐→加仓 / ≥60→持有偏加 / ≥45→持有 / <45→减仓；',
          '④ 无回测覆盖标的回退 dy 分位≥90 或贵贱度≤25→加仓、贵贱度≥80→减仓。',
          '本页为规则化辅助决策，非投资建议；累计分红为估算口径（不复投、不摊薄成本、忽略送转股）。'),
        el('div', { class: 'chart-title', style: 'font-size:13.5px;font-weight:700;margin:16px 2px 4px' }, '交易台账',
          el('span', { class: 'txt-3', style: 'font-size:11px;font-weight:400;margin-left:8px' }, '表格可左右滚动 · 最后一列可删除任意一笔交易（持仓/盈亏随之重算）')),
        ledgerBox, formBox);

      /* ── 持仓页签栏（每页一个 tab + 新增 + 当前页操作） ── */
      const paintTabs = () => {
        tabsEl.innerHTML = '';
        for (const p of data.portfolios) {
          tabsEl.append(el('button', {
            class: 'seg-btn' + (p.id === curId ? ' active' : ''),
            role: 'tab', 'aria-selected': p.id === curId ? 'true' : 'false',
            title: p.name + ' · ' + p.trades.length + ' 笔交易',
            onclick: () => { curId = p.id; try { localStorage.setItem(ACTIVE_KEY, curId); } catch { /* 忽略 */ } paint(); },
          }, p.name));
        }
        tabsEl.append(el('button', { class: 'seg-btn hld-tab-add', title: '新建一个独立持仓页（各自台账/盈亏/决策）', onclick: addPortfolio }, '＋新增'));
        tabsEl.append(el('button', { class: 'hld-mini-btn', title: '重命名当前持仓页', onclick: renamePortfolio }, '重命名'));
        tabsEl.append(el('button', { class: 'hld-mini-btn', title: '删除当前持仓页（连同台账，至少保留一页）', onclick: delPortfolio }, '删除'));
      };

      /* ── 表单区（买入/卖出切换，每次重绘重建；作用于当前持仓页） ── */
      const paintForm = () => {
        formBox.innerHTML = '';
        const positions = allPositions(cur().trades);
        const modeSel = el('div', { class: 'seg-group', role: 'group', 'aria-label': '交易方向' },
          ...['buy', 'sell'].map((k) => el('button', {
            class: 'seg-btn' + (formMode === k ? ' active' : ''), onclick: () => { formMode = k; paintForm(); },
          }, k === 'buy' ? '买入' : '卖出')));

        const msg = el('span', { class: 'txt-3', style: 'font-size:11px' });
        const flash = (t) => { msg.textContent = t; };

        if (formMode === 'buy') {
          const codeInput = el('input', { list: 'hld-codes', placeholder: '代码，如 600036', autocomplete: 'off', 'aria-label': '代码' });
          const dl = el('datalist', { id: 'hld-codes' });
          for (const c of candidates) dl.append(el('option', { value: c.code }, c.name + ' ' + c.code));
          const kindSel = el('select', { class: 'hld-input', 'aria-label': '类型' },
            el('option', { value: 'stock' }, '股票'), el('option', { value: 'etf' }, 'ETF'));
          const dateInput = el('input', { type: 'text', placeholder: 'YYYY-MM-DD', 'aria-label': '日期' });
          dateInput.value = maxDate || new Date().toISOString().slice(0, 10);
          const priceInput = el('input', { type: 'number', step: '0.001', placeholder: '价格', 'aria-label': '价格' });
          const qtyInput = el('input', { type: 'number', step: '1', placeholder: '数量（股）', 'aria-label': '数量' });
          const feeInput = el('input', { type: 'number', step: '0.01', placeholder: '费用', 'aria-label': '费用' });
          feeInput.value = '5';
          /* 代码输入后自动补现价与类型；池外代码保持手工填写 */
          codeInput.addEventListener('change', () => {
            const c = candidates.find((x) => x.code === codeInput.value.trim());
            if (c) {
              kindSel.value = c.kind; kindSel.disabled = true;
              const mv = meta[c.code];   // 真实交易价格：ETF 用场内价（dy.close_now 是跟踪指数点位）
              if (mv && mv.last_close != null && !priceInput.value) priceInput.value = String(mv.last_close);
            } else { kindSel.disabled = false; }
          });
          const submit = el('button', { class: 'hld-submit', onclick: () => {
            const code = codeInput.value.trim();
            if (!code) return flash('请输入代码');
            const price = parseFloat(priceInput.value), qty = parseInt(qtyInput.value, 10), fee = parseFloat(feeInput.value) || 0;
            if (!(price > 0)) return flash('价格无效');
            if (!(qty > 0)) return flash('数量无效');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return flash('日期格式 YYYY-MM-DD');
            const c = candidates.find((x) => x.code === code);
            cur().trades.push({ id: 't' + Date.now(), code, kind: c ? c.kind : kindSel.value, side: 'buy',
              date: dateInput.value, price, qty, fee });
            persist();
          } }, '记买入');
          formBox.append(el('div', { class: 'hld-form' },
            el('div', { class: 'hld-field' }, el('label', {}, '代码（股票/ETF）'), codeInput),
            el('div', { class: 'hld-field' }, el('label', {}, '类型（池内自动锁定）'), kindSel),
            el('div', { class: 'hld-field' }, el('label', {}, '日期'), attachDatePicker(dateInput, { min: '2004-01-01' }).wrap),
            el('div', { class: 'hld-field' }, el('label', {}, '价格（默认现价）'), priceInput),
            el('div', { class: 'hld-field' }, el('label', {}, '数量（股）'), qtyInput),
            el('div', { class: 'hld-field' }, el('label', {}, '费用（默认5元）'), feeInput),
            submit),
            el('div', { style: 'margin:6px 2px' }, msg),
            dl,
            modeSel);
        } else {
          if (!positions.length) {
            formBox.append(el('div', { class: 'txt-3', style: 'margin:10px 2px' }, '当前持仓页暂无持仓可卖，请先记买入。'), modeSel);
            return;
          }
          const sel = el('select', { class: 'hld-input', 'aria-label': '持仓选择' },
            ...positions.map((p) => {
              const nm = (dy[p.code] && dy[p.code].name) || (meta[p.code] && meta[p.code].name) || '';
              return el('option', { value: p.code },
                (nm ? nm + ' ' : '') + p.code + '（可卖 ' + fmt0(p.qty) + ' 股 · 成本 ' + fmt2(p.avg) + '）');
            }));
          const dateInput = el('input', { type: 'text', placeholder: 'YYYY-MM-DD', 'aria-label': '日期' });
          dateInput.value = maxDate || new Date().toISOString().slice(0, 10);
          const priceInput = el('input', { type: 'number', step: '0.001', placeholder: '价格', 'aria-label': '价格' });
          const qtyInput = el('input', { type: 'number', step: '1', placeholder: '数量（股）', 'aria-label': '数量' });
          const feeInput = el('input', { type: 'number', step: '0.01', placeholder: '费用', 'aria-label': '费用' });
          feeInput.value = '5';
          const preview = el('span', { class: 'txt-3', style: 'font-size:11px' });
          const cur2 = () => positions.find((p) => p.code === sel.value) || positions[0];
          const refresh = () => {
            const p = cur2();
            const mv = meta[p.code];   // 真实交易价格：ETF 用场内价
            if (!priceInput.value && mv && mv.last_close != null) priceInput.value = String(mv.last_close);
            if (!qtyInput.value) qtyInput.value = String(p.qty);
            const price = parseFloat(priceInput.value), qty = parseInt(qtyInput.value, 10), fee = parseFloat(feeInput.value) || 0;
            if (price > 0 && qty > 0 && qty <= p.qty) {
              const r = (price - p.avg) * qty - fee;
              preview.textContent = '预估已实现盈亏 ' + (r >= 0 ? '+' : '') + r.toFixed(2) + ' 元（平均成本法）';
            } else preview.textContent = '';
          };
          sel.addEventListener('change', () => { priceInput.value = ''; qtyInput.value = ''; refresh(); });
          priceInput.addEventListener('input', refresh);
          qtyInput.addEventListener('input', refresh);
          feeInput.addEventListener('input', refresh);
          refresh();
          const submit = el('button', { class: 'hld-submit', onclick: () => {
            const p = cur2();
            const price = parseFloat(priceInput.value), qty = parseInt(qtyInput.value, 10), fee = parseFloat(feeInput.value) || 0;
            if (!(price > 0)) return flash('价格无效');
            if (!(qty > 0) || qty > p.qty) return flash('数量须在 1~' + fmt0(p.qty) + ' 之间');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return flash('日期格式 YYYY-MM-DD');
            cur().trades.push({ id: 't' + Date.now(), code: p.code, kind: p.kind, side: 'sell',
              date: dateInput.value, price, qty, fee });
            persist();
          } }, '记卖出');
          formBox.append(el('div', { class: 'hld-form' },
            el('div', { class: 'hld-field' }, el('label', {}, '持仓'), sel),
            el('div', { class: 'hld-field' }, el('label', {}, '日期'), attachDatePicker(dateInput, { min: '2004-01-01' }).wrap),
            el('div', { class: 'hld-field' }, el('label', {}, '价格'), priceInput),
            el('div', { class: 'hld-field' }, el('label', {}, '数量（股）'), qtyInput),
            el('div', { class: 'hld-field' }, el('label', {}, '费用'), feeInput),
            submit),
            el('div', { class: 'hld-preview' }, preview, el('br'), msg),
            modeSel);
        }
      };

      /* ── 主重绘 ── */
      const paint = () => {
        paintTabs();
        /* 保存状态条 + 草稿提示 */
        saveBar.innerHTML = '';
        if (saveState.ok) saveBar.append(el('span', { class: 'txt-up', style: 'font-size:11.5px' }, '已保存 ' + saveState.ok));
        if (data.missing) saveBar.append(el('span', { class: 'txt-3', style: 'font-size:11.5px' }, 'cache/持仓.json 尚未创建：首次保存后自动生成'));
        if (saveState.err) saveBar.append(el('span', { class: 'txt-down', style: 'font-size:11.5px' }, '⚠ ' + saveState.err));
        const exportBtn = el('button', { class: 'hld-mini-btn', title: '下载持仓 JSON（全部持仓页，备份/换机器迁移）', onclick: () => {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '持仓.json';
          a.click();
          URL.revokeObjectURL(a.href);
        } }, '导出JSON');
        const importInput = el('input', { type: 'file', accept: '.json', style: 'display:none', 'aria-label': '导入持仓' });
        importInput.addEventListener('change', async () => {
          const file = importInput.files && importInput.files[0];
          if (!file) return;
          try {
            const d = normalizeHoldings(JSON.parse(await file.text()));
            data = d;
            curId = d.portfolios[0].id;
            await persist();
          } catch (e) { saveState = { ok: saveState.ok, err: '导入失败：' + e.message }; paint(); }
        });
        saveBar.append(el('button', { class: 'hld-mini-btn', onclick: () => importInput.click() }, '导入JSON'), importInput);
        /* 草稿检测（上次保存失败遗留；v1 旧草稿自动归一化） */
        warnBar.innerHTML = '';
        try {
          const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
          if (draft && Array.isArray(draft.trades) && draft.trades.length) {
            const fileIds = new Set(data.portfolios.flatMap((p) => (p.trades || []).map((t) => t.id)));
            const extra = draft.trades.filter((t) => !fileIds.has(t.id)).length;
            if (extra > 0) {
              warnBar.append(el('div', { class: 'cmp-warn', style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
                el('span', {}, '检测到本地草稿（上次保存可能失败）：含 ' + extra + ' 笔未落盘的交易'),
                el('button', { class: 'hld-mini-btn', onclick: () => { data = normalizeHoldings(draft); curId = data.portfolios[0].id; persist(); } }, '恢复草稿'),
                el('button', { class: 'hld-mini-btn', onclick: () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ } warnBar.innerHTML = ''; } }, '清除草稿')));
            }
          }
        } catch { /* 忽略 */ }

        /* 档位切换（每页独立记忆：写入当前页 preset 并落盘） */
        presetSel.innerHTML = '';
        for (const p of ['稳健', '均衡', '进取']) {
          presetSel.append(el('button', {
            class: 'seg-btn' + (cur().preset === p ? ' active' : ''),
            title: p + '：' + RECO_PRESET_DESC[p].w + ' —— ' + RECO_PRESET_DESC[p].tip,
            onclick: () => { cur().preset = p; persist(); },
          }, p));
        }
        presetNote.textContent = '当前：' + cur().preset + ' → ' + RECO_PRESET_DESC[cur().preset].w + '（切档改变推荐分与建议动作，每持仓页独立记忆）';

        const rows = rowsOf();
        const decided = rows.map((row) => ({ ...row, d: decide(row) }));

        /* 汇总卡（仅当前页） */
        const mkt = rows.reduce((a, p) => a + p.qty * (p.close != null ? p.close : p.avg), 0);   // 池外标的按成本近似
        const cost = rows.reduce((a, p) => a + p.cost, 0);
        const divT = rows.reduce((a, p) => a + (p.divTotal != null ? p.divTotal : 0), 0);
        const rel = rows.reduce((a, p) => a + p.realized, 0);
        const unreal = mkt - cost;
        const total = unreal + divT + rel;
        sumEl.innerHTML = '';
        sumEl.append(
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '持仓页'), el('b', {}, cur().name)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '数据日期'), el('b', {}, maxDate || m.data_date || '—')),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '持仓标的'), el('b', {}, rows.length)),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '总市值'), el('b', {}, mkt.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '总成本'), el('b', {}, cost.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '持仓盈亏'), el('b', { class: 'txt-' + dirOf(unreal) }, (unreal >= 0 ? '+' : '') + unreal.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '累计分红(估)'), el('b', { class: 'txt-up' }, divT.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '已实现盈亏'), el('b', { class: 'txt-' + dirOf(rel) }, (rel >= 0 ? '+' : '') + rel.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))),
          el('div', { class: 'bt-cell' }, el('span', { class: 'txt-3' }, '总盈亏(含分红)'), el('b', { class: 'txt-' + dirOf(total) }, (total >= 0 ? '+' : '') + total.toLocaleString('zh-CN', { maximumFractionDigits: 0 }))));

        /* 决策表 */
        if (!rows.length) {
          tableBox.querySelector('.table-wrap').innerHTML = '';
          tableBox.querySelector('.table-wrap').append(emptyState('「' + cur().name + '」暂无持仓',
            '在下方台账记一笔买入，或先到「信号扫描 / 智能推荐」找当前值得买的标的。'));
        } else {
          const cols = [
            { key: 'fav', label: '★', align: 'center', sortable: false, filter: false, fmt: (_v, row) => favStar(row.code) },
            { key: 'code', label: '代码', align: 'center', sortable: true, cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0) },
            { key: 'name', label: '名称', align: 'center', sortable: true,
              fmt: (v, row) => el('div', {},
                el('a', { href: '#', onclick: (e) => { e.preventDefault(); openTicker(row.code, row.name, row.type); }, class: 'jump-link', title: '查看历史K线（' + row.type + '）' }, v),
                el('div', { class: 'rec-sub' }, row.type)) },
            { key: 'qty', label: '数量', align: 'center', sortable: true, fmt: (v) => fmt0(v) },
            { key: 'avg', label: '平均成本', align: 'center', sortable: true, fmt: (v) => fmt2(v) },
            { key: 'close', label: '现价', align: 'center', sortable: true, fmt: (v) => (v == null ? '池外—' : fmt2(v)) },
            { key: 'pnl', label: '盈亏%', align: 'center', sortable: true,
              fmt: (_v, row) => {
                const v = row.close != null ? (row.close / row.avg - 1) * 100 : null;
                return v == null ? '—' : el('span', { class: 'txt-' + dirOf(v) }, (v >= 0 ? '+' : '') + fmt2(v) + '%');
              } },
            { key: 'divTotal', label: '累计分红(估)', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })) },
            { key: 'dyNow', label: '股息率%', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)) },
            { key: 'pct', label: 'dy分位', align: 'center', sortable: true, fmt: (v) => (v == null ? '—' : fmt2(v)), color: (v) => (v >= 90 ? 'up' : v <= 10 ? 'down' : '') },
            { key: 's', label: '推荐分', align: 'center', sortable: true,
              fmt: (_v, row) => (row.d.sc ? el('span', { title: '与智能推荐同口径（' + cur().preset + '档）：dy混合 ' + fmt2(row.d.sc.dyPart) + ' · 贵贱度反向 ' + fmt2(row.d.sc.anaPart) + ' · 回测 ' + fmt2(row.d.sc.btPart) }, fmt2(row.d.sc.s)) : '—'),
              color: (_v, row) => (row.d.sc && row.d.sc.s >= 75 ? 'up' : '') },
            { key: 'band', label: '评级', align: 'center', sortable: false, filter: false,
              fmt: (_v, row) => (row.d.sc ? el('span', { class: 'band-pill ' + recoBandCls(recoBandOf(row.d.sc.s)) }, recoBandOf(row.d.sc.s)) : el('span', { class: 'txt-3' }, '无覆盖')) },
            { key: 'act', label: '建议动作', align: 'center', sortable: false, filter: false,
              fmt: (_v, row) => el('span', { class: 'band-pill ' + row.d.cls, title: row.d.why }, row.d.act) },
            { key: 'why', label: '理由', align: 'left', sortable: false, filter: false,
              fmt: (v) => el('span', { style: 'font-size:11px;color:var(--text-3);line-height:1.5' }, v) },
          ];
          renderTable(tableBox.querySelector('.table-wrap'), { columns: cols, rows: decided, pageSize: 20 });
        }

        /* 台账流水表（当前页，降序展示，最新在前） */
        const trades = [...cur().trades].sort((a, b) => (a.date > b.date ? -1 : 1));
        if (!trades.length) {
          ledgerBox.querySelector('.table-wrap').innerHTML = '';
          ledgerBox.querySelector('.table-wrap').append(emptyState('台账为空', '用下方表单记录第一笔交易。'));
        } else {
          const lcols = [
            { key: 'date', label: '日期', align: 'center', sortable: true },
            { key: 'code', label: '代码', align: 'center', sortable: true },
            { key: 'name', label: '名称', align: 'center', sortable: true },
            { key: 'side', label: '方向', align: 'center', sortable: true, filter: false,
              fmt: (v) => el('span', { class: 'trig-badge' + (v === 'sell' ? ' sell' : '') }, v === 'buy' ? '买入' : '卖出') },
            { key: 'price', label: '价格', align: 'center', sortable: true, fmt: (v) => fmt2(v) },
            { key: 'qty', label: '数量', align: 'center', sortable: true, fmt: (v) => fmt0(v) },
            { key: 'fee', label: '费用', align: 'center', sortable: true, fmt: (v) => fmt2(v) },
            { key: 'real', label: '已实现盈亏', align: 'center', sortable: true,
              fmt: (_v, row) => {
                const v = row.side === 'sell' ? row.sells.get(row.id) : null;
                return v == null ? '—' : el('span', { class: 'txt-' + dirOf(v) }, (v >= 0 ? '+' : '') + v.toFixed(2));
              } },
            { key: 'op', label: '操作', align: 'center', sortable: false, filter: false,
              fmt: (_v, row) => el('button', { class: 'hld-del', title: '删除该笔交易（持仓/盈亏将重新计算）', onclick: () => {
                if (!window.confirm('删除这笔交易（' + row.code + ' ' + row.date + ' ' + (row.side === 'buy' ? '买入' : '卖出') + ' ' + row.qty + ' 股）？')) return;
                cur().trades = cur().trades.filter((t) => t.id !== row.id);
                persist();
              } }, '删除') },
          ];
          const { sells } = replayTrades(trades);
          const lrows = trades.map((t) => ({
            ...t,
            name: (dy[t.code] && dy[t.code].name) || (meta[t.code] && meta[t.code].name) || '—',
            sells,
          }));
          renderTable(ledgerBox.querySelector('.table-wrap'), { columns: lcols, rows: lrows, pageSize: 20 });
        }

        paintForm();
      };

      paint();
    } catch (err) {
      root.innerHTML = '';
      root.append(errorBox('我的持仓加载失败：' + err.message, () => { root.innerHTML = ''; this.mount(root); }));
    }
  },
  dispose() {},
};