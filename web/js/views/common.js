/* 共享 UI 组件与格式化工具 */

/* ── DOM 辅助 ── */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ── 数字格式化 ── */
const F2 = (v) => (v === null || v === undefined || v === '' || Number.isNaN(v)) ? '—' : Number(v).toFixed(2);
const F0 = (v) => (v === null || v === undefined || v === '' || Number.isNaN(v)) ? '—' : Math.round(v).toLocaleString('zh-CN');

export function fmt2(v) { return F2(v); }
export function fmt0(v) { return F0(v); }
export function fmtPct(v, digits) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  // digits 可能被 renderTable 以 row 对象传入，仅接受整数；否则默认 2 位
  const d = (typeof digits === 'number' && Number.isInteger(digits)) ? digits : 2;
  const s = Number(v).toFixed(d);
  return (Number(v) > 0 ? '+' : '') + s + '%';
}
export function fmtVol(v) { return F2(v); }     // 万手
export function fmtAmount(v) { return F2(v); }  // 亿元
export function fmtSigned(v) {  // 带正负号的纯数字（无%）
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(2);
}

/* 涨跌类别 */
export function dirOf(v) {
  if (v === null || v === undefined || Number.isNaN(v) || Math.abs(v) < 1e-9) return 'flat';
  return v > 0 ? 'up' : 'down';
}
export function badgeHtml(v) {
  const d = dirOf(v);
  const txt = d === 'flat' ? '0.00%' : fmtPct(v);
  return `<span class="chg-badge ${d}">${txt}</span>`;
}

/* 计算日涨跌幅（前收盘口径，数组内相邻） */
export function dailyChg(rows, i) {
  if (i <= 0) return null;
  const prev = rows[i - 1].close, cur = rows[i].close;
  if (!prev || !cur) return null;
  return (cur - prev) / prev * 100;
}

/* ── 加载骨架 ── */
export function skeleton() {
  return el('div', { class: 'skeleton', 'aria-hidden': 'true' });
}

/* ── 空状态 ── */
export function emptyState(title, desc) {
  return el('div', { class: 'empty-state' },
    el('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '◫'),
    el('div', { class: 'empty-title' }, title),
    el('div', { class: 'empty-desc' }, desc || ''));
}

/* ── 错误框（带重试） ── */
export function errorBox(message, onRetry) {
  const box = el('div', { class: 'error-box', role: 'alert' }, message);
  if (onRetry) {
    box.append(el('div', {},
      el('button', { class: 'retry-btn', onclick: () => onRetry() }, '重试')));
  }
  return box;
}

/* ── 左侧标的列表 ── */
/**
 * items: [{code, name, price, chg, sub, subDir}]
 * 选中回调 onSelect(item)
 * title: 可选标题区（Node），渲染在搜索框之前（注意本函数会清空 container）
 */
export function renderTickerList(container, items, { onSelect, activeCode, searchable = true, title = null }) {
  container.innerHTML = '';
  if (title) container.append(title);
  const searchBox = searchable ? el('input', { class: 'ticker-search', type: 'search', placeholder: '搜索代码 / 名称…', 'aria-label': '搜索标的' }) : null;
  if (searchBox) container.append(searchBox);
  const ul = el('ul', { class: 'ticker-list' });
  container.append(ul);

  let current = items;
  const paint = (list) => {
    ul.innerHTML = '';
    if (!list.length) {
      ul.append(el('li', { class: 'empty-state', style: 'padding:24px 8px' }, '无匹配标的'));
      return;
    }
    for (const it of list) {
      const priceTxt = it.price == null ? '—' : Number(it.price).toFixed(2);
      const li = el('li', { class: 'ticker-item' + (it.code === activeCode ? ' active' : ''), role: 'button', tabindex: '0', 'aria-label': `${it.name} ${it.code}，最新价 ${priceTxt}` },
        el('div', { class: 'ticker-name' }, it.name),
        el('div', { class: 'ticker-price txt-' + dirOf(it.chg) }, priceTxt),
        el('div', { class: 'ticker-code' }, it.code),
        el('div', { class: 'ticker-sub' },
          it.subHtml != null ? it.subHtml : (it.chg == null ? el('span', { class: 'txt-3' }, '—') : el('span', { class: 'txt-' + dirOf(it.chg) }, fmtSigned(it.chg) + '%'))));
      const pick = () => onSelect(it);
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ul.append(li);
    }
  };
  paint(items);

  if (searchBox) {
    searchBox.addEventListener('input', () => {
      const q = searchBox.value.trim().toLowerCase();
      current = q ? items.filter(i => i.name.toLowerCase().includes(q) || i.code.includes(q)) : items;
      paint(current);
    });
  }
  return {
    setActive(code) { activeCode = code; paint(current); },
    /* 切换分组：替换列表数据并清空搜索 */
    refresh(newItems) {
      items = newItems; current = newItems;
      if (searchBox) searchBox.value = '';
      paint(newItems);
    },
  };
}

/* ── 筛选条件解析：>5 / <3 / >=2 / <=8 / 2~8 / 文本包含 / 日期起~止 ── */
function parseFilter(raw) {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (m) return { op: m[1], val: m[2].trim() };
  m = s.match(/^(.+?)\s*~\s*(.+)$/);
  if (m) return { op: '~', lo: m[1].trim(), hi: m[2].trim() };
  return { op: 'contains', val: s };
}

function matchFilter(cellVal, f) {
  if (cellVal === null || cellVal === undefined) return false;
  const sv = String(cellVal);
  if (f.op === 'contains') return sv.includes(f.val);
  const nv = Number(cellVal);
  const tv = Number(f.val);
  if (Number.isNaN(nv) || Number.isNaN(tv)) {
    // 非数值（日期/文本）：字符串比较（YYYY-MM-DD 字典序=时间序）
    if (f.op === '>=') return sv >= f.val;
    if (f.op === '<=') return sv <= f.val;
    if (f.op === '>') return sv > f.val;
    if (f.op === '<') return sv < f.val;
    if (f.op === '~') return sv >= f.lo && sv <= f.hi;
    return false;
  }
  if (f.op === '>=') return nv >= tv;
  if (f.op === '<=') return nv <= tv;
  if (f.op === '>') return nv > tv;
  if (f.op === '<') return nv < tv;
  if (f.op === '~') return nv >= Number(f.lo) && nv <= Number(f.hi);
  return false;
}

/* ── 日期选择器：手动输入 + 自绘日历弹窗（深色主题，超范围日期禁用） ── */
let activePicker = null;

const CAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>';

const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

function fmtDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function closePicker() {
  if (activePicker) {
    activePicker.popup.remove();
    document.removeEventListener('click', activePicker.outside);
    document.removeEventListener('keydown', activePicker.esc);
    window.removeEventListener('scroll', activePicker.onScroll, true);
    activePicker = null;
  }
}

/**
 * 给文本输入框挂载日历按钮（返回 wrap 供调用方放入布局）；input 保持可手动输入
 * opts: { min, max: 'YYYY-MM-DD'，超范围日期禁用；onPick() 选中后回调 }
 */
export function attachDatePicker(input, opts) {
  const btn = el('button', { class: 'dp-btn', type: 'button', 'aria-label': '打开日历选择', title: '打开日历选择' });
  btn.innerHTML = CAL_ICON;
  const wrap = el('div', { class: 'dp-wrap' }, input, btn);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activePicker && activePicker.input === input) { closePicker(); return; }
    openPicker(input, opts);
  });
  return { wrap, btn };
}

function openPicker(input, opts) {
  closePicker();
  const { min = '', max = '' } = opts;
  const popup = el('div', { class: 'dp-popup', role: 'dialog', 'aria-label': '日期选择' });
  document.body.append(popup);

  // 初始视图月：取输入值或数据上限/今天
  const init = (input.value || max || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  let viewY = init[0], viewM = init[1] - 1;
  let viewMode = 'month'; // 'month' | 'year'

  const render = () => {
    popup.innerHTML = '';
    if (viewMode === 'year') { renderYearView(); return; }
    renderMonthView();
  };

  /* 月视图 */
  const renderMonthView = () => {
    const head = el('div', { class: 'dp-head' },
      el('button', { class: 'dp-nav-btn', type: 'button', 'aria-label': '上个月', onclick: (e) => { e.stopPropagation(); stepMonth(-1); } }, '‹'),
      el('button', { class: 'dp-title-btn', type: 'button', 'aria-label': '切换年份视图', onclick: (e) => { e.stopPropagation(); viewMode = 'year'; render(); } }, `${viewY}年${viewM + 1}月`),
      el('button', { class: 'dp-nav-btn', type: 'button', 'aria-label': '下个月', onclick: (e) => { e.stopPropagation(); stepMonth(1); } }, '›'));
    popup.append(head);

    const grid = el('div', { class: 'dp-grid' });
    for (const w of WEEK_CN) grid.append(el('span', { class: 'dp-week' }, w));

    const firstDow = (new Date(viewY, viewM, 1).getDay() + 6) % 7; // 周一=0
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < firstDow; i++) grid.append(el('span', {}));
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = fmtDate(viewY, viewM, d);
      const disabled = (min && ds < min) || (max && ds > max);
      const b = el('button', {
        class: 'dp-day' + (ds === input.value ? ' selected' : '') + (ds === todayStr ? ' today' : ''),
        type: 'button', disabled: disabled || undefined,
        'aria-label': ds, onclick: (e) => { e.stopPropagation(); input.value = ds; opts.onPick?.(); closePicker(); },
      }, String(d));
      grid.append(b);
    }
    popup.append(grid);

    const foot = el('div', { class: 'dp-foot' },
      el('span', { class: 'dp-hint' }, min ? `${min} ~ ${max}` : ''),
      el('button', { class: 'dp-close', type: 'button', onclick: (e) => { e.stopPropagation(); closePicker(); } }, '关闭'));
    popup.append(foot);
  };

  /* 年视图（点标题进入） */
  const renderYearView = () => {
    const head = el('div', { class: 'dp-head' },
      el('button', { class: 'dp-nav-btn', type: 'button', 'aria-label': '上十年', onclick: (e) => { e.stopPropagation(); viewY -= 10; render(); } }, '‹'),
      el('button', { class: 'dp-title-btn', type: 'button', 'aria-label': '返回月份视图', onclick: (e) => { e.stopPropagation(); viewMode = 'month'; render(); } }, `${viewY}年`),
      el('button', { class: 'dp-nav-btn', type: 'button', 'aria-label': '下十年', onclick: (e) => { e.stopPropagation(); viewY += 10; render(); } }, '›'));
    popup.append(head);

    const grid = el('div', { class: 'dp-grid dp-year-grid' });
    const startY = viewY - 5;
    for (let i = 0; i < 12; i++) {
      const y = startY + i;
      const b = el('button', {
        class: 'dp-day dp-year' + (y === init[0] ? ' selected' : ''),
        type: 'button',
        onclick: (e) => { e.stopPropagation(); viewY = y; viewMode = 'month'; render(); },
      }, String(y));
      grid.append(b);
    }
    popup.append(grid);

    const foot = el('div', { class: 'dp-foot' },
      el('span', { class: 'dp-hint' }, '点击年份返回月份视图'),
      el('button', { class: 'dp-close', type: 'button', onclick: (e) => { e.stopPropagation(); closePicker(); } }, '关闭'));
    popup.append(foot);
  };

  const stepMonth = (delta) => {
    viewM += delta;
    if (viewM < 0) { viewM = 11; viewY--; }
    if (viewM > 11) { viewM = 0; viewY++; }
    render();
  };

  /* 滚轮翻月（阻止页面滚动） */
  popup.addEventListener('wheel', (e) => {
    e.preventDefault();
    stepMonth(e.deltaY < 0 ? -1 : 1);
  }, { passive: false });

  render();

  // 定位到按钮下方（fixed 相对视口）
  const wrap = input.closest('.dp-wrap');
  const btn = wrap ? wrap.querySelector('.dp-btn') : input;
  const pos = () => {
    const r = btn.getBoundingClientRect();
    const pw = popup.offsetWidth;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + popup.offsetHeight > window.innerHeight - 8) top = r.top - popup.offsetHeight - 6;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  };
  pos();

  const outside = (e) => { if (!popup.contains(e.target) && !btn.contains(e.target)) closePicker(); };
  const esc = (e) => { if (e.key === 'Escape') closePicker(); };
  const onScroll = () => closePicker();
  setTimeout(() => document.addEventListener('click', outside), 0);
  document.addEventListener('keydown', esc);
  window.addEventListener('scroll', onScroll, true);
  activePicker = { popup, input, outside, esc, onScroll };
}

/* ── 通用表格（列筛选 + 排序 + 分页 + 页码跳转） ── */
/**
 * columns: [{key, label, align: 'num'|'left'|'center', sortable, fmt, cls, color, filter}]
 *   filter: false 可关闭该列筛选框；默认开启
 */
export function renderTable(container, { columns, rows, pageSize = 50 }) {
  container.innerHTML = '';
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const tbody = el('tbody');
  const trh = el('tr');
  let sortKey = null, sortDir = 1;

  const headCells = [];
  for (const c of columns) {
    const th = el('th', { class: c.align === 'left' ? 'left' : (c.align === 'center' ? 'center' : 'num'), 'aria-sort': 'none' }, c.label);
    if (c.sortable) {
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        if (sortKey === c.key) { sortDir = -sortDir; } else { sortKey = c.key; sortDir = 1; }
        paint();
      });
    }
    headCells.push({ th, col: c });
    trh.append(th);
  }
  thead.append(trh);

  /* 筛选行（每列一个条件输入框） */
  const filters = new Map(); // key -> 解析后的条件
  const filterRow = el('tr', { class: 'filter-row' });
  for (const c of columns) {
    const cell = el('th', {});
    if (c.filter !== false) {
      const input = el('input', {
        class: 'col-filter', type: 'text',
        'aria-label': '筛选' + c.label,
        placeholder: c.align === 'left' ? '包含…' : '>5 或 2~8',
        title: '筛选语法：>5 / <3 / >=2 / 2~8（区间）/ 日期 起~止 / 文本包含',
      });
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const raw = input.value;
          filters.set(c.key, raw.trim() ? parseFilter(raw) : null);
          page = 1;
          paint();
        }, 250);
      });
      cell.append(input);
    }
    filterRow.append(cell);
  }
  thead.append(filterRow);

  table.append(thead, tbody);
  wrap.append(table);

  const pager = el('div', { class: 'pagination' });
  container.append(wrap, pager);

  const get = (row, key) => {
    if (typeof key === 'function') return key(row);
    return row[key];
  };

  let page = 1, totalPages = 1, filteredRows = [], sortedRows = [];

  const filterRows = () => {
    if (!filters.size) { filteredRows = [...rows]; return; }
    filteredRows = rows.filter((row) => {
      for (const [key, f] of filters) {
        if (f && !matchFilter(get(row, key), f)) return false;
      }
      return true;
    });
  };

  const sortRows = () => {
    sortedRows = [...filteredRows];
    if (sortKey) {
      const c = columns.find(x => x.key === sortKey);
      const cv = c && c.cmp ? c.cmp : (a, b) => (a === null || a === undefined ? -Infinity : a) - (b === null || b === undefined ? -Infinity : b);
      sortedRows.sort((x, y) => sortDir * (c && c.cmp ? c.cmp(get(x, sortKey), get(y, sortKey)) : cv(get(x, sortKey), get(y, sortKey))));
    }
  };

  const paint = () => {
    filterRows();
    sortRows();
    totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
    if (page > totalPages) page = totalPages;
    tbody.innerHTML = '';
    const start = (page - 1) * pageSize;
    const slice = sortedRows.slice(start, start + pageSize);

    // 表头排序指示
    headCells.forEach(({ th, col }) => {
      th.classList.remove('sorted');
      th.setAttribute('aria-sort', 'none');
      const oldInd = th.querySelector('.sort-ind');
      if (oldInd) oldInd.remove();
      if (sortKey === col.key) {
        th.classList.add('sorted');
        th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
        th.append(el('span', { class: 'sort-ind' }, sortDir === 1 ? '▲' : '▼'));
      }
    });

    if (!slice.length) {
      tbody.append(el('tr', { class: 'row-empty' }, el('td', { colspan: columns.length }, '暂无数据（调整筛选条件）')));
    }
    for (const row of slice) {
      const tr = el('tr');
      if (row._rec) tr.classList.add('row-rec');
      for (const c of columns) {
        let v = get(row, c.key);
        const td = el('td', { class: c.align === 'left' ? 'left' : (c.align === 'center' ? 'center' : 'num') });
        if (c.color && v !== null && v !== undefined && !Number.isNaN(v)) td.classList.add('txt-' + (typeof c.color === 'function' ? c.color(v, row) : c.color));
        td.textContent = c.fmt ? c.fmt(v, row) : (v === null || v === undefined ? '—' : String(v));
        tr.append(td);
      }
      tbody.append(tr);
    }

    // 分页 + 页码跳转
    pager.innerHTML = '';
    if (totalPages > 1) {
      const mkBtn = (label, p, disabled, active) => {
        const b = el('button', { class: 'page-btn' + (active ? ' active' : ''), disabled: disabled || undefined, 'aria-label': `第 ${p} 页`, 'aria-current': active ? 'page' : undefined }, label);
        b.addEventListener('click', () => { page = p; paint(); });
        pager.append(b);
      };
      mkBtn('‹', page - 1, page <= 1);
      const from = Math.max(1, page - 2), to = Math.min(totalPages, page + 2);
      for (let p = from; p <= to; p++) mkBtn(String(p), p, false, p === page);
      mkBtn('›', page + 1, page >= totalPages);
      pager.append(el('span', { class: 'page-info' }, `${filteredRows.length} 行 · 第 ${page}/${totalPages} 页`));
      const jumpInput = el('input', { class: 'page-jump-input', type: 'number', min: '1', max: String(totalPages), 'aria-label': '跳转到页码' });
      const go = () => {
        const p = parseInt(jumpInput.value, 10);
        if (p >= 1 && p <= totalPages) { page = p; jumpInput.value = ''; paint(); }
      };
      jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const jumpBtn = el('button', { class: 'page-btn', onclick: go }, '跳转');
      pager.append(el('span', { class: 'page-jump' }, '跳至 ', jumpInput, ' 页 ', jumpBtn));
    } else if (filteredRows.length) {
      pager.append(el('span', { class: 'page-info' }, `${filteredRows.length} 行`));
    } else {
      pager.append(el('span', { class: 'page-info' }, '0 行'));
    }
  };

  paint();
  return {
    refresh(newRows) { rows = newRows; page = 1; paint(); },
    sortBy(key, dir) { sortKey = key; sortDir = dir || 1; paint(); },
    clearFilters() { filters.clear(); document.querySelectorAll('.col-filter').forEach((i) => { i.value = ''; }); paint(); },
  };
}
