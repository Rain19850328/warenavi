// tabs/display.js — 진열보충 탭
// 스토리지렉에서 꺼내 진열 위치를 채워 달라는 요청 목록. 완료 처리와 되돌리기.
(function () {
  'use strict';

  const STYLE_ID = 'tab-display-style';
  const CSS = `
.tab-display .dp-toolbar .seg{ flex: 1 1 100%; }
.tab-display .dp-cnt{ margin-left: 4px; font-weight: 500; opacity: .75; }
.tab-display .dp-summary{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-display .dp-code{
  appearance: none; display: inline-block; min-height: 28px; padding: 4px 0;
  border: 0; background: none; cursor: pointer; text-align: left;
  font: inherit; font-size: 13px; font-weight: 700; color: #0369a1; text-decoration: underline;
}
.tab-display .dp-loc{ font-size: 14px; font-weight: 700; color: #0f172a; }
.tab-display .dp-racks{
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin-top: 8px; padding: 8px; border-radius: 10px;
  background: #f0f9ff; border: 1px solid #bae6fd;
}
.tab-display .dp-racks--empty{ background: #fffbeb; border-color: #fde68a; }
.tab-display .dp-racks__label{ font-size: 12px; font-weight: 600; color: #475569; }
.tab-display .dp-racks .chip{ padding: 4px 10px; font-size: 14px; }
.tab-display .dp-note{
  margin-top: 6px; padding: 6px 8px; border-radius: 8px;
  background: #f1f5f9; font-size: 13px; line-height: 1.4; color: #334155; word-break: break-word;
}
.tab-display .dp-side-sub{ font-size: 11px; color: #64748b; }
.tab-display .wl-actions .dp-act-main{ flex: 1 1 120px; min-height: 44px; font-size: 15px; }
.tab-display .dp-state{ display: grid; justify-items: center; gap: 4px; padding-bottom: 20px; }
@media (min-width: 640px){
  .tab-display .dp-toolbar .seg{ flex: 0 1 auto; }
}`;

  const STATUS_OPTS = [['all', '전체'], ['open', '미완료'], ['done', '완료']];
  const SOURCE_LABEL = {
    item: ['상품조회 요청', 'info'],
    irregular: ['이형포장 요청', 'info'],
  };

  const state = {
    root: null,
    bodyEl: null,
    dateBar: null,
    date: '',
    items: [],
    index: new Map(),         // String(id) -> row
    loadedDate: null,
    phase: 'idle',            // loading | error | ready
    errorMsg: '',
    seq: 0,
    filter: 'all',
    sticky: new Set(),        // 방금 처리한 행: 필터에 안 맞아도 제자리에 둔다
  };

  const esc = v => UI.esc(v);

  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

  /* ---------- row helpers ---------- */
  function sourcesOf(r) {
    return Array.isArray(r.sources) && r.sources.length ? r.sources : (r.source ? [r.source] : []);
  }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function locText(code) {
    const s = String(code ?? '').trim();
    return !s || s === '00' ? '위치 미지정' : s;
  }
  function hasRacks(r) { return Array.isArray(r.racks) && r.racks.some(x => x && x.rack_code); }
  function statusTone(s) {
    if (s === '안정') return 'ok';
    if (s === '주문필요') return 'warn';
    if (s === '주문완료') return 'info';
    if (s === '품절') return 'danger';
    if (s === '단종') return 'muted';
    if (String(s || '').includes('보류')) return 'warn';
    return 'muted';
  }

  function sortRows(rows) {
    const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true });
    return rows.slice().sort((a, b) => {
      // 방금 처리한 행은 원래 자리(미완료 묶음)에 그대로 둔다
      const da = a.status === 'done' && !state.sticky.has(String(a.id)) ? 1 : 0;
      const db = b.status === 'done' && !state.sticky.has(String(b.id)) ? 1 : 0;
      if (da !== db) return da - db;
      return cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code);
    });
  }

  function isVisible(r) {
    if (state.sticky.has(String(r.id))) return true;
    return state.filter === 'all' || r.status === state.filter;
  }

  function updateCounts() {
    const c = { all: 0, open: 0, done: 0 };
    for (const r of state.items) {
      c.all++;
      if (c[r.status] !== undefined) c[r.status]++;
    }
    state.root.querySelectorAll('[data-cnt]').forEach(el => {
      el.textContent = state.phase === 'ready' ? String(c[el.dataset.cnt] ?? 0) : '';
    });
  }

  function syncToolbar() {
    state.root.querySelectorAll('[data-act="filter"]').forEach(b => b.classList.toggle('is-active', b.dataset.val === state.filter));
    updateCounts();
  }

  /* ---------- rendering ---------- */
  function soldoutHtml(r) {
    if (r.in_soldout) return UI.chip('품절관리 등록됨', 'muted');
    const urgent = !hasRacks(r) && numOrNull(r.stock_today) === 0;
    return `<button type="button" class="${urgent ? 'btn-danger' : 'btn-ghost btn-sm'}" data-act="soldout">품절관리에 추가</button>`;
  }

  function rowHtml(r) {
    const id = String(r.id);
    const done = r.status === 'done';

    const chips = [];
    for (const s of sourcesOf(r)) {
      const def = SOURCE_LABEL[s];
      chips.push(UI.chip(def ? def[0] : s, def ? def[1] : 'muted'));
    }
    if (r.stock_status) chips.push(UI.chip(r.stock_status, statusTone(r.stock_status)));

    const racks = hasRacks(r)
      ? `<div class="dp-racks"><span class="dp-racks__label">가져올 곳</span>${UI.rackChips(r.racks)}</div>`
      : `<div class="dp-racks dp-racks--empty">${UI.chip('스토리지렉 재고 없음', 'warn')}</div>`;

    const who = [r.requested_by_name, UI.fmtDateTime(r.created_at)].filter(Boolean).join(' · ');

    let side;
    if (done) {
      const doneWho = [r.done_by_name, UI.fmtDateTime(r.done_at)].filter(Boolean).join(' ');
      side = UI.chip('완료', 'ok') + (doneWho ? `<span class="dp-side-sub">완료 · ${esc(doneWho)}</span>` : '');
    } else {
      side = UI.chip('미완료', 'warn');
    }

    const actions = (done
      ? '<button type="button" class="btn-ghost btn-sm" data-act="reopen">되돌리기</button>'
      : '<button type="button" class="btn-primary dp-act-main" data-act="done">완료</button>') + soldoutHtml(r);

    return `
      <li class="wl-row${done ? ' is-done' : ''}" data-id="${esc(id)}">
        <div class="wl-main">
          <button type="button" class="wl-code dp-code" data-act="open-item" title="상품조회에서 보기">${esc(r.item_code)}</button>
          <div class="wl-name">${esc(r.item_name)}</div>
          <div class="wl-meta"><span>진열 위치 <span class="dp-loc">${esc(locText(r.location_code))}</span></span><span>재고 <b>${esc(UI.num(r.stock_today))}</b></span></div>
          ${racks}
          ${chips.length ? `<div class="wl-meta">${chips.join('')}</div>` : ''}
          ${r.request_note ? `<div class="dp-note">요청 메모: ${esc(r.request_note)}</div>` : ''}
          ${who ? `<div class="wl-meta">요청: ${esc(who)}</div>` : ''}
        </div>
        <div class="wl-side">${side}</div>
        <div class="wl-actions">${actions}</div>
      </li>`;
  }

  function stateHtml(text, sub, btnAct, btnLabel) {
    return `<div class="dp-state"><p class="empty">${esc(text)}${sub ? `<br><small>${esc(sub)}</small>` : ''}</p>${
      btnAct ? `<button type="button" class="btn-ghost" data-act="${btnAct}">${esc(btnLabel)}</button>` : ''}</div>`;
  }

  function renderBody() {
    const body = state.bodyEl;
    if (state.phase === 'loading') { body.innerHTML = stateHtml('불러오는 중…'); return; }
    if (state.phase === 'error') { body.innerHTML = stateHtml('불러오지 못했습니다', state.errorMsg, 'retry', '다시 시도'); return; }
    if (state.phase !== 'ready') { body.innerHTML = ''; return; }

    if (!state.items.length) {
      body.innerHTML = stateHtml(`${state.date} 에는 진열보충 요청이 없습니다.`);
      return;
    }
    const rows = sortRows(state.items.filter(isVisible));
    if (!rows.length) {
      body.innerHTML = stateHtml(state.filter === 'open' ? '미완료 요청이 없습니다.' : '완료된 요청이 없습니다.', `전체 ${state.items.length}건`, 'show-all', '전체 보기');
      return;
    }
    body.innerHTML =
      `<p class="dp-summary">표시 ${esc(UI.num(rows.length))}건 / 전체 ${esc(UI.num(state.items.length))}건</p>` +
      `<ul class="wl-list">${rows.map(rowHtml).join('')}</ul>`;
  }

  // 한 행만 다시 그린다(스크롤·필터 유지)
  function replaceRow(id) {
    const r = state.index.get(String(id));
    if (!r) return;
    for (const li of state.bodyEl.querySelectorAll('li.wl-row')) {
      if (li.dataset.id !== String(id)) continue;
      const tpl = document.createElement('template');
      tpl.innerHTML = rowHtml(r).trim();
      li.replaceWith(tpl.content.firstElementChild);
      return;
    }
  }

  /* ---------- data ---------- */
  async function load() {
    const date = state.date;
    const seq = ++state.seq;
    state.sticky.clear();
    // 같은 날짜를 다시 불러올 때는 화면을 비우지 않는다(스크롤 유지)
    if (!(state.phase === 'ready' && state.loadedDate === date)) {
      state.phase = 'loading';
      state.items = [];
      state.index = new Map();
      state.loadedDate = null;
      renderBody();
      updateCounts();
    }
    try {
      const res = await UI.api.get('/display_requests', { date });
      if (seq !== state.seq) return;
      state.items = Array.isArray(res && res.items) ? res.items : [];
      state.index = new Map(state.items.map(r => [String(r.id), r]));
      state.loadedDate = date;
      state.phase = 'ready';
    } catch (err) {
      if (seq !== state.seq) return;
      state.items = [];
      state.index = new Map();
      state.loadedDate = null;
      state.phase = 'error';
      state.errorMsg = (err && err.message) || '';
    }
    renderBody();
    updateCounts();
  }

  function applyItem(item) {
    if (!item || item.id === undefined || item.id === null) { load(); return; }
    const id = String(item.id);
    if (!state.index.has(id)) return;           // 그 사이 다른 날짜로 바뀜
    const i = state.items.findIndex(r => String(r.id) === id);
    if (i >= 0) state.items[i] = item;
    state.index.set(id, item);
    state.sticky.add(id);
    replaceRow(id);
    updateCounts();
    Shell.refreshBadges();
  }

  async function setStatus(btn, r, status) {
    const res = await UI.busy(btn, () => UI.api.post('/display_requests/status', { id: r.id, status }));
    if (res === undefined) return;
    applyItem(res && res.item);
  }

  /* ---------- events ---------- */
  async function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !state.root.contains(btn)) return;
    const act = btn.dataset.act;

    if (act === 'filter' || act === 'show-all') {
      state.filter = act === 'show-all' ? 'all' : btn.dataset.val;
      state.sticky.clear();
      syncToolbar();
      renderBody();
      return;
    }
    if (act === 'retry') { load(); return; }

    const li = btn.closest('li.wl-row');
    if (!li) return;
    const id = li.dataset.id;
    const r = state.index.get(id);
    if (!r) return;

    if (act === 'open-item') { Shell.show('items', { code: r.item_code }); return; }
    if (act === 'done') { await setStatus(btn, r, 'done'); return; }
    if (act === 'reopen') { await setStatus(btn, r, 'open'); return; }
    if (act === 'soldout') {
      const res = await UI.busy(btn, () => UI.api.post('/soldout_items/add', {
        item_code: r.item_code, source: 'display', source_id: r.id, date: r.request_date,
      }));
      if (res === undefined) return;
      const existed = !!res && res.created === false;
      UI.toast(existed ? '이미 품절관리에 있는 상품입니다' : '품절관리에 추가했습니다', existed ? 'info' : 'ok');
      const cur = state.index.get(id);
      if (cur) { cur.in_soldout = true; replaceRow(id); }
      Shell.refreshBadges();
    }
  }

  /* ---------- lifecycle ---------- */
  function mount(root) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    state.root = root;
    state.date = today();
    root.classList.add('tab-display');
    root.innerHTML = `
      <div class="view-head"><h2>진열보충</h2><div class="dp-datebar"></div></div>
      <div class="view-toolbar dp-toolbar">
        <div class="seg" role="group">${STATUS_OPTS.map(([val, label]) =>
          `<button type="button" data-act="filter" data-val="${val}">${label}<span class="dp-cnt" data-cnt="${val}"></span></button>`).join('')}</div>
      </div>
      <div class="view-body"></div>`;
    state.bodyEl = root.querySelector('.view-body');
    state.dateBar = UI.dateBar(root.querySelector('.dp-datebar'), {
      value: state.date,
      onChange: ymd => { state.date = ymd; load(); },
    });
    root.addEventListener('click', onClick);
    syncToolbar();
  }

  function onShow(params) {
    const p = params || {};
    if (isYmd(p.date)) {
      state.date = p.date;
      state.dateBar.set(p.date);
    }
    load();
  }

  function onHide() {
    state.seq++;                 // 진행 중이던 조회 결과는 버린다
    if (state.phase === 'loading') state.phase = 'idle';
  }

  Shell.register({ id: 'display', label: '진열보충', mount, onShow, onHide });
})();
