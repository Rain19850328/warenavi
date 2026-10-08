// tabs/display.js — 진열보충 탭
// 스토리지렉에서 꺼내 진열 위치를 채워 달라는 요청 목록.
// 가져올 곳과 수량을 고르고 완료하면 그 위치 재고가 차감된다. 되돌리면 같은 위치에 다시 채운다.
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
.tab-display .dp-rack{
  appearance: none; min-height: 40px; padding: 0 12px; border-radius: 10px;
  border: 1px solid #7dd3fc; background: #fff; color: #075985; cursor: pointer;
  font: inherit; font-size: 14px; font-weight: 600;
}
.tab-display .dp-rack b{ margin-left: 4px; color: #0f172a; }
.tab-display .dp-rack.is-active{ background: #0ea5e9; border-color: #0284c7; color: #fff; }
.tab-display .dp-rack.is-active b{ color: #fff; }
.tab-display .dp-take{
  flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600; color: #334155;
}
.tab-display .dp-take input{
  width: 84px; height: 44px; padding: 0 8px; border: 1px solid #cbd5e1; border-radius: 10px;
  background: #fff; color: #0f172a; font: inherit; font-size: 16px; text-align: right;
}
.tab-display .dp-take input:focus{ outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,.25); }
.tab-display .dp-take .btn-sm{ min-height: 44px; }
.tab-display .dp-hint{ flex: 1 0 100%; font-size: 12px; font-weight: 500; color: #64748b; }
.tab-display .dp-taken{
  margin-top: 6px; padding: 6px 8px; border-radius: 8px;
  background: #ecfdf5; border: 1px solid #a7f3d0; font-size: 13px; font-weight: 600; color: #065f46;
}
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
    pick: new Map(),          // String(id) -> {rack, qty(입력 중인 글자)} : 고른 가져올 곳
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
  function rackList(r) { return Array.isArray(r.racks) ? r.racks.filter(x => x && x.rack_code) : []; }
  function rackQty(r, code) {
    const hit = rackList(r).find(x => String(x.rack_code) === String(code));
    return hit ? (numOrNull(hit.qty) ?? 0) : 0;
  }
  // 목록이 새로 왔을 때 그 위치에 재고가 더 없으면 선택을 버린다.
  function pickOf(r) {
    const id = String(r.id);
    const pick = state.pick.get(id);
    if (!pick) return null;
    if (r.status !== 'open' || rackQty(r, pick.rack) <= 0) { state.pick.delete(id); return null; }
    return pick;
  }
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

    const pick = done ? null : pickOf(r);
    let racks;
    if (!hasRacks(r)) {
      racks = `<div class="dp-racks dp-racks--empty">${UI.chip('스토리지렉 재고 없음', 'warn')}</div>`;
    } else if (done) {
      racks = `<div class="dp-racks"><span class="dp-racks__label">스토리지렉</span>${UI.rackChips(r.racks)}</div>`;
    } else {
      const buttons = rackList(r).map(x => {
        const on = !!pick && String(pick.rack) === String(x.rack_code);
        return `<button type="button" class="dp-rack${on ? ' is-active' : ''}" data-act="pick-rack" data-rack="${esc(x.rack_code)}" aria-pressed="${on ? 'true' : 'false'}">${esc(x.rack_code)}<b>${esc(UI.num(x.qty))}개</b></button>`;
      }).join('');
      const take = pick
        ? `<div class="dp-take">
             <label for="dpQty-${esc(id)}">가져올 수량</label>
             <input type="text" id="dpQty-${esc(id)}" data-role="take-qty" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" value="${esc(pick.qty)}" />
             <span>/ ${esc(UI.num(rackQty(r, pick.rack)))}개</span>
             <button type="button" class="btn-sm" data-act="take-all">전체</button>
           </div>`
        : '<span class="dp-hint">가져올 곳을 누르고 수량을 넣으면 완료할 때 그 위치 재고가 차감됩니다.</span>';
      racks = `<div class="dp-racks"><span class="dp-racks__label">가져올 곳</span>${buttons}${take}</div>`;
    }
    const takenQty = numOrNull(r.taken_qty);
    const taken = done && r.taken_rack_code && takenQty
      ? `<div class="dp-taken">가져온 곳 ${esc(r.taken_rack_code)} · ${esc(UI.num(takenQty))}개 차감</div>`
      : '';

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
      : `<button type="button" class="btn-primary dp-act-main" data-act="done">${pick ? '완료 · 재고 차감' : '완료'}</button>`) + soldoutHtml(r);

    return `
      <li class="wl-row${done ? ' is-done' : ''}" data-id="${esc(id)}">
        <div class="wl-main">
          <button type="button" class="wl-code dp-code" data-act="open-item" title="상품조회에서 보기">${esc(r.item_code)}</button>
          <div class="wl-name">${esc(r.item_name)}</div>
          <div class="wl-meta"><span>진열 위치 <span class="dp-loc">${esc(locText(r.location_code))}</span></span><span>재고 <b>${esc(UI.num(r.stock_today))}</b></span></div>
          ${racks}
          ${taken}
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
    if (state.loadedDate !== date) state.pick.clear();
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

  // 스토리지렉 재고가 바뀌었으면 창고맵도 최신으로 맞춘다(실패해도 이 탭에는 영향 없음).
  function refreshMap() {
    try {
      if (typeof loadCells === 'function') Promise.resolve(loadCells()).catch(() => {});
      if (typeof loadMovements === 'function') Promise.resolve(loadMovements()).catch(() => {});
    } catch (_) {}
  }

  async function setStatus(btn, r, status, extra) {
    const body = Object.assign({ id: r.id, status }, extra || {});
    const res = await UI.busy(btn, () => UI.api.post('/display_requests/status', body));
    if (res === undefined) return false;
    state.pick.delete(String(r.id));
    applyItem(res && res.item);
    return true;
  }

  async function completeRow(btn, r) {
    const pick = pickOf(r);
    if (!pick) {
      if (hasRacks(r) && !(await UI.confirm(
        `${r.item_code}\n가져올 곳을 고르지 않았습니다.\n스토리지렉 재고를 차감하지 않고 완료할까요?`))) return;
      await setStatus(btn, r, 'done');
      return;
    }
    const max = rackQty(r, pick.rack);
    const raw = String(pick.qty ?? '').trim();
    if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) {
      UI.toast('가져올 수량을 1 이상의 숫자로 입력해 주세요', 'error');
      focusQty(r.id);
      return;
    }
    const qty = Number(raw);
    if (qty > max) {
      UI.toast(`${pick.rack} 위치에는 ${UI.num(max)}개만 있습니다`, 'error');
      focusQty(r.id);
      return;
    }
    const rack = pick.rack;
    if (await setStatus(btn, r, 'done', { rack_code: rack, qty })) {
      UI.toast(`완료 · ${rack}에서 ${UI.num(qty)}개 차감했습니다`, 'ok');
      refreshMap();
    }
  }

  async function reopenRow(btn, r) {
    const qty = numOrNull(r.taken_qty);
    const restore = !!(r.taken_rack_code && qty);
    if (restore && !(await UI.confirm(
      `${r.item_code}\n차감했던 ${UI.num(qty)}개를 ${r.taken_rack_code}에 되돌리고 미완료로 바꿀까요?`))) return;
    if (await setStatus(btn, r, 'open') && restore) {
      UI.toast(`${r.taken_rack_code}에 ${UI.num(qty)}개를 되돌렸습니다`, 'info');
      refreshMap();
    }
  }

  function rowLi(id) {
    for (const li of state.bodyEl.querySelectorAll('li.wl-row')) {
      if (li.dataset.id === String(id)) return li;
    }
    return null;
  }
  function focusQty(id) {
    const li = rowLi(id);
    const input = li && li.querySelector('input[data-role="take-qty"]');
    if (input) { try { input.focus({ preventScroll: true }); input.select(); } catch (_) {} }
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
    if (act === 'pick-rack') {
      const rack = btn.dataset.rack;
      const cur = state.pick.get(id);
      if (cur && String(cur.rack) === String(rack)) state.pick.delete(id);
      else state.pick.set(id, { rack, qty: '' });
      replaceRow(id);
      if (state.pick.has(id)) focusQty(id);
      return;
    }
    if (act === 'take-all') {
      const cur = pickOf(r);
      if (!cur) return;
      cur.qty = String(rackQty(r, cur.rack));
      const input = li.querySelector('input[data-role="take-qty"]');
      if (input) input.value = cur.qty;
      return;
    }
    if (act === 'done') { await completeRow(btn, r); return; }
    if (act === 'reopen') { await reopenRow(btn, r); return; }
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

  function onInput(ev) {
    const input = ev.target;
    if (!input || !input.matches || !input.matches('input[data-role="take-qty"]')) return;
    const li = input.closest('li.wl-row');
    const pick = li && state.pick.get(li.dataset.id);
    if (pick) pick.qty = input.value;
  }

  function onKeyDown(ev) {
    const input = ev.target;
    if (ev.key !== 'Enter' || ev.isComposing || !input || !input.matches || !input.matches('input[data-role="take-qty"]')) return;
    ev.preventDefault();
    const li = input.closest('li.wl-row');
    const btn = li && li.querySelector('[data-act="done"]');
    if (btn) btn.click();
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
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
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
