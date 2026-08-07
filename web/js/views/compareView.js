/* 视图：对比分析（同类对比：指数/ETF/股票各自内部多选，归一化净值同图观察趋势关系）
   数据全部来自现有缓存（klineUrl 直读 /cache/），零后端改动 */

import { loadJSON, MANIFEST_URL } from '../data.js';
import { el, fmt2, fmtSigned, dirOf, fmtScale } from './common.js';

const MAX = 8;   // 最多同时对比的标的数

export default {
  async mount(root) {
    root.innerHTML = '';
    const m = await loadJSON(MANIFEST_URL);
    const toItem = (x, type) => ({ code: x.code, name: x.name, type, price: x.last_close, chg: x.last_chg, scale: x.scale });
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
    let query = '';
    const selected = new Map(); // code -> item（已选）
    const order = [];           // 选择顺序（chips 展示序）

    /* ── DOM ── */
    root.append(el('div', { class: 'view-head' },
      el('h1', {}, '对比分析'),
      el('div', { class: 'txt-3', style: 'font-size:12px' },
        '同类对比：指数↔指数 / ETF↔ETF / 股票↔股票，归一化净值同图观察趋势关系（最多 ' + MAX + ' 只）')));

    const typeTabs = el('div', { class: 'seg-group', role: 'group', 'aria-label': '对比类型' });
    const chipsEl = el('div', { class: 'cmp-chips' });
    const btnClear = el('button', { class: 'seg-btn', disabled: true }, '清空');
    const btnGo = el('button', { class: 'cmp-go', disabled: true }, '开始对比');
    const toolbar = el('div', { class: 'cmp-toolbar' },
      typeTabs,
      el('div', { class: 'cmp-toolbar-right' }, chipsEl, el('div', { class: 'cmp-actions' }, btnClear, btnGo)));

    const searchBox = el('input', { class: 'ticker-search', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索标的' });
    const groupTabs = el('div', { class: 'cmp-groups', style: 'display:none' });
    const listEl = el('ul', { class: 'cmp-list' });
    const listPanel = el('div', { class: 'card cmp-list-panel' }, searchBox, groupTabs, listEl);

    const mainEl = el('div', { class: 'card cmp-main' },
      el('div', { class: 'empty-state', style: 'padding:64px 16px' },
        '选择 ≥2 只同类标的，点击「开始对比」查看归一化净值走势'));
    const body = el('div', { class: 'cmp-body' }, listPanel, mainEl);

    root.append(el('div', { class: 'card cmp-panel' }, toolbar, body));

    /* ── 当前类型列表（含搜索/分组）── */
    function currentItems() {
      let items = curType === 'stock' ? stockGroups[curGroup].items : allItems[curType];
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
        listEl.append(el('li', { class: 'empty-state', style: 'padding:20px 8px' }, '无匹配标的'));
        return;
      }
      for (const it of items) {
        const sel = selected.has(it.code);
        const li = el('li', { class: 'cmp-item' + (sel ? ' sel' : ''), role: 'button', tabindex: '0',
            'aria-label': it.name + it.code },
          el('span', { class: 'cmp-check' }, sel ? '✓' : ''),
          el('span', { class: 'cmp-item-name' }, it.name, it.scale != null ? el('em', { class: 'cmp-scale' }, fmtScale(it.scale)) : null),
          el('span', { class: 'cmp-item-code' }, it.code),
          el('span', { class: 'cmp-item-price txt-' + dirOf(it.chg) }, it.price == null ? '—' : fmt2(it.price)));
        const pick = () => toggle(it);
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        listEl.append(li);
      }
    }

    function renderGroupTabs() {
      groupTabs.innerHTML = '';
      groupTabs.style.display = curType === 'stock' ? '' : 'none';
      if (curType !== 'stock') return;
      stockGroups.forEach((g, i) => {
        groupTabs.append(el('button', { class: 'cmp-gtab' + (i === curGroup ? ' active' : ''),
            onclick: () => { curGroup = i; query = ''; searchBox.value = ''; renderList(); } },
          g.label, el('em', {}, g.items.length)));
      });
    }

    /* ── 已选 chips ── */
    function renderChips() {
      chipsEl.innerHTML = '';
      if (!order.length) {
        chipsEl.append(el('span', { class: 'txt-3', style: 'font-size:12px' }, '未选择标的'));
      }
      for (const code of order) {
        const it = selected.get(code);
        const chip = el('span', { class: 'cmp-chip' }, it.name, el('i', { class: 'cmp-chip-x', role: 'button', 'aria-label': '移除' }, '×'));
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
      renderGroupTabs();
      renderList();
      renderChips();
    }

    /* 类型 Tab */
    for (const [key, label] of [['index', '指数'], ['etf', 'ETF'], ['stock', '股票']]) {
      typeTabs.append(el('button', { class: 'seg-btn' + (key === 'index' ? ' active' : ''), 'data-t': key, onclick: () => setType(key) }, label));
    }

    searchBox.addEventListener('input', () => { query = searchBox.value.trim(); renderList(); });
    btnClear.addEventListener('click', () => { selected.clear(); order.length = 0; renderChips(); renderList(); });
    btnGo.addEventListener('click', () => renderCompare());

    /* ── 开始对比（步骤 2 接入图表）── */
    function renderCompare() {
      if (order.length < 2) return;
      mainEl.innerHTML = '';
      mainEl.append(el('div', { class: 'empty-state', style: 'padding:64px 16px' }, '图表渲染（步骤 2 接入）'));
    }

    renderGroupTabs();
    renderList();
    renderChips();
  },
  dispose() {},
};

