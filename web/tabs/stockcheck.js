// tabs/stockcheck.js — 재고확인 탭
// 날짜별 재고확인 대상(자동 + 요청)을 보여 주고 일치/불일치를 기록한다. 총 재고(MOPS가 넣는 값)는 바꾸지 않는다.
(function () {
  'use strict';

  const STYLE_ID = 'tab-stockcheck-style';
  const CSS = `
.tab-stockcheck .sc-toolbar{ align-items: stretch; }
.tab-stockcheck .sc-toolbar .seg{ flex: 1 1 100%; }
.tab-stockcheck .sc-toolbar .seg > button{ padding: 0 6px; }
.tab-stockcheck .sc-cnt{ margin-left: 3px; font-weight: 500; opacity: .75; }
.tab-stockcheck .sc-toggle[aria-pressed="true"]{ background: #0ea5e9; border-color: #0284c7; color: #fff; }
.tab-stockcheck .sc-open-toggle{ flex: 1 1 100%; min-height: 40px; border-color: #e2e8f0; background: #fff; color: #b91c1c; font-size: 14px; }
.tab-stockcheck .sc-open-toggle[aria-pressed="true"]{ background: #dc2626; border-color: #b91c1c; color: #fff; }
.tab-stockcheck .sc-q{ flex: 1 1 160px; }
.tab-stockcheck.is-open-mode .sc-datebar,
.tab-stockcheck.is-open-mode .sc-seg-status{ display: none; }
.tab-stockcheck .sc-summary{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-stockcheck .sc-row--req{ border-left: 4px solid #0ea5e9; }
.tab-stockcheck .sc-row--mismatch{ border-left: 4px solid #ef4444; }
.tab-stockcheck .sc-row--match{ border-left: 4px solid #22c55e; }
.tab-stockcheck .sc-code{
  appearance: none; display: inline-block; min-height: 28px; padding: 4px 0;
  border: 0; background: none; cursor: pointer; text-align: left;
  font: inherit; font-size: 13px; font-weight: 700; color: #0369a1; text-decoration: underline;
}
.tab-stockcheck .sc-loc{ font-size: 14px; font-weight: 700; color: #0f172a; }
.tab-stockcheck .sc-total{ display: flex; flex-direction: column; align-items: flex-end; min-width: 64px; line-height: 1.1; }
.tab-stockcheck .sc-total__label{ font-size: 12px; font-weight: 600; color: #64748b; }
.tab-stockcheck .sc-total__num{ font-size: 30px; font-weight: 800; color: #0f172a; }
.tab-stockcheck .sc-total__num.is-zero{ color: #b91c1c; }
.tab-stockcheck .sc-note{
  margin-top: 6px; padding: 6px 8px; border-radius: 8px;
  background: #f1f5f9; font-size: 13px; line-height: 1.4; color: #334155; word-break: break-word;
}
.tab-stockcheck .sc-note--reason{ background: #fef2f2; color: #991b1b; }
.tab-stockcheck .sc-side-qty{ font-size: 13px; font-weight: 600; color: #0f172a; }
.tab-stockcheck .sc-side-sub{ font-size: 11px; color: #64748b; }
.tab-stockcheck .sc-diff--minus{ color: #b91c1c; }
.tab-stockcheck .sc-diff--plus{ color: #1d4ed8; }
.tab-stockcheck .wl-actions .sc-act-main{ flex: 1 1 96px; min-height: 40px; font-size: 15px; }
.tab-stockcheck .sc-form{
  flex: 1 0 100%; min-width: 0; box-sizing: border-box;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px;
  padding: 10px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc;
}
.tab-stockcheck .sc-form-actions{ display: flex; gap: 8px; }
.tab-stockcheck .sc-form-actions button{ flex: 1 1 0; min-height: 40px; }
.tab-stockcheck .sc-state{ display: grid; justify-items: center; gap: 4px; padding-bottom: 20px; }
@media (min-width: 640px){
  .tab-stockcheck .sc-toolbar .seg,
  .tab-stockcheck .sc-open-toggle{ flex: 0 1 auto; }
  .tab-stockcheck .sc-toolbar .seg > button{ padding: 0 12px; }
  .tab-stockcheck .sc-form{ grid-template-columns: 160px minmax(0, 1fr) auto; align-items: end; }
}`;

  const STATUS_OPTS = [['all', '전체'], ['pending', '미확인'], ['match', '일치'], ['mismatch', '불일치']];
  const KIND_OPTS = [['all', '전체'], ['req', '요청'], ['auto', '자동']];
  const SOURCE_LABEL = {
    auto_low_stock: ['자동', 'muted'],
    item: ['상품조회 요청', 'info'],
    irregular: ['이형포장 요청', 'info'],
  };

  const state = {
    root: null,
    bodyEl: null,
    dateBar: null,
    date: '',
    openMode: false,          // 미처리 불일치만 보기(전 날짜)
    items: [],
    index: new Map(),         // String(id) -> row
    loadedKey: null,          // 지금 items가 어느 조회의 결과인지
    phase: 'idle',            // loading | error | ready
    errorMsg: '',
    seq: 0,
    filter: { status: 'pending', kind: 'all', hideDisc: false, q: '' },
    sticky: new Set(),        // 이번 화면에서 방금 처리한 행: 필터에 안 맞아도 제자리에 둔다
    form: null,               // {id, kind:'mismatch'|'resolve'}
    qTimer: null,
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
    const list = Array.isArray(r.sources) && r.sources.length ? r.sources : (r.source ? [r.source] : []);
    return list;
  }
  function isRequested(r) {
    const s = sourcesOf(r);
    return s.includes('item') || s.includes('irregular');
  }
  function isDisc(r) { return r.stock_status === '단종' || r.item_status === '단종'; }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function locText(code) {
    const s = String(code ?? '').trim();
    return !s || s === '00' ? '위치 미지정' : s;
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
      if (state.openMode) {
        const d = cmp(b.check_date, a.check_date);
        if (d) return d;
      }
      const ra = isRequested(a) ? 0 : 1;
      const rb = isRequested(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code);
    });
  }

  /* ---------- filters ---------- */
  function passKind(r) {
    const k = state.filter.kind;
    if (k === 'all') return true;
    return k === 'req' ? isRequested(r) : !isRequested(r);
  }
  function passStatus(r) {
    if (state.openMode) return true;
    const s = state.filter.status;
    return s === 'all' || r.status === s;
  }
  function passDisc(r) { return !state.filter.hideDisc || !isDisc(r); }
  function passText(r) {
    const q = state.filter.q;
    if (!q) return true;
    return `${r.item_code ?? ''}\n${r.item_name ?? ''}\n${r.location_code ?? ''}`.toLowerCase().includes(q);
  }
  function isVisible(r) {
    if (state.sticky.has(String(r.id))) return true;
    return passKind(r) && passStatus(r) && passDisc(r) && passText(r);
  }

  function updateCounts() {
    const st = { all: 0, pending: 0, match: 0, mismatch: 0 };
    const kd = { all: 0, req: 0, auto: 0 };
    for (const r of state.items) {
      if (!passDisc(r) || !passText(r)) continue;
      if (passKind(r)) {
        st.all++;
        if (st[r.status] !== undefined) st[r.status]++;
      }
      if (passStatus(r)) {
        kd.all++;
        kd[isRequested(r) ? 'req' : 'auto']++;
      }
    }
    state.root.querySelectorAll('[data-cnt]').forEach(el => {
      const [group, key] = el.dataset.cnt.split(':');
      const n = (group === 'status' ? st : kd)[key];
      el.textContent = state.phase === 'ready' ? String(n ?? 0) : '';
    });
  }

  function syncToolbar() {
    const root = state.root;
    root.classList.toggle('is-open-mode', state.openMode);
    root.querySelectorAll('[data-act="f-status"]').forEach(b => b.classList.toggle('is-active', b.dataset.val === state.filter.status));
    root.querySelectorAll('[data-act="f-kind"]').forEach(b => b.classList.toggle('is-active', b.dataset.val === state.filter.kind));
    root.querySelector('[data-act="toggle-disc"]').setAttribute('aria-pressed', String(state.filter.hideDisc));
    root.querySelector('[data-act="toggle-open"]').setAttribute('aria-pressed', String(state.openMode));
    updateCounts();
  }

  /* ---------- rendering ---------- */
  function soldoutHtml(r) {
    if (r.in_soldout) return UI.chip('품절관리 등록됨', 'muted');
    const urgent = numOrNull(r.counted_qty) === 0 || numOrNull(r.stock_today) === 0;
    return `<button type="button" class="${urgent ? 'btn-danger' : 'btn-ghost btn-sm'}" data-act="soldout">품절관리에 추가</button>`;
  }

  // 미확인 줄은 '일치'가 기록할 지금 재고를, 확인한 줄은 확인 당시 재고를 보여 준다.
  function totalStock(r) {
    const db = numOrNull(r.db_stock);
    const live = numOrNull(r.stock_today);
    return r.status === 'pending' ? (live ?? db) : (db ?? live);
  }

  function sideHtml(r) {
    const parts = [];
    const total = totalStock(r);
    parts.push(`<div class="sc-total"><span class="sc-total__label">총 재고</span><span class="sc-total__num${total === 0 ? ' is-zero' : ''}">${esc(UI.num(total))}</span></div>`);
    const liveNow = numOrNull(r.stock_today);
    if (r.status !== 'pending' && liveNow !== null && total !== null && liveNow !== total) {
      parts.push(`<span class="sc-side-sub">현재 ${esc(UI.num(liveNow))}</span>`);
    }
    if (r.status === 'match' || r.status === 'mismatch') {
      parts.push(UI.chip(r.status === 'match' ? '일치' : '불일치', r.status === 'match' ? 'ok' : 'danger'));
      if (r.status === 'mismatch' && r.resolved) parts.push(UI.chip('처리완료', 'ok'));
      const counted = numOrNull(r.counted_qty);
      const db = numOrNull(r.db_stock);
      if (counted !== null) {
        let diff = '';
        if (db !== null && counted !== db) {
          const d = counted - db;
          diff = ` <span class="${d < 0 ? 'sc-diff--minus' : 'sc-diff--plus'}">(${d > 0 ? '+' : ''}${esc(UI.num(d))})</span>`;
        }
        parts.push(`<span class="sc-side-qty">실재고 ${esc(UI.num(counted))}${diff}</span>`);
      }
      const who = [r.checked_by_name, UI.fmtDateTime(r.checked_at)].filter(Boolean).join(' · ');
      if (who) parts.push(`<span class="sc-side-sub">${esc(who)}</span>`);
    } else {
      parts.push(UI.chip('미확인', 'warn'));
    }
    return parts.join('');
  }

  function formHtml(r, kind) {
    if (kind === 'mismatch') {
      const qty = r.status === 'mismatch' && numOrNull(r.counted_qty) !== null ? r.counted_qty : '';
      const reason = r.status === 'mismatch' ? (r.mismatch_reason || '') : '';
      return `
        <form class="sc-form" data-form="mismatch" novalidate>
          <label class="field"><span>실재고 수량</span>
            <input type="number" name="qty" inputmode="numeric" pattern="[0-9]*" min="0" step="1" required autocomplete="off" value="${esc(qty)}" /></label>
          <label class="field"><span>사유 (선택)</span>
            <input type="text" name="reason" maxlength="200" autocomplete="off" value="${esc(reason)}" /></label>
          <div class="sc-form-actions">
            <button type="submit" class="btn-primary">저장</button>
            <button type="button" class="btn-ghost" data-act="form-cancel">취소</button>
          </div>
        </form>`;
    }
    return `
      <form class="sc-form" data-form="resolve" novalidate>
        <label class="field" style="grid-column: 1 / -2"><span>처리 메모 (선택)</span>
          <input type="text" name="note" maxlength="200" autocomplete="off" value="${esc(r.resolved_note || '')}" /></label>
        <div class="sc-form-actions">
          <button type="submit" class="btn-primary">처리완료 저장</button>
          <button type="button" class="btn-ghost" data-act="form-cancel">취소</button>
        </div>
      </form>`;
  }

  function actionsHtml(r, formKind) {
    const out = [];
    if (r.status === 'pending') {
      out.push('<button type="button" class="btn-primary sc-act-main" data-act="match">일치</button>');
      out.push(`<button type="button" class="btn-danger sc-act-main" data-act="open-mismatch"${formKind === 'mismatch' ? ' disabled' : ''}>불일치</button>`);
    } else if (r.status === 'match') {
      out.push('<button type="button" class="btn-ghost btn-sm" data-act="reset">다시 확인</button>');
    } else if (r.resolved) {
      out.push('<button type="button" class="btn-ghost btn-sm" data-act="unresolve">처리취소</button>');
    } else {
      out.push(`<button type="button" class="btn-primary" data-act="open-resolve"${formKind === 'resolve' ? ' disabled' : ''}>처리완료</button>`);
      out.push(`<button type="button" class="btn-ghost btn-sm" data-act="open-mismatch"${formKind === 'mismatch' ? ' disabled' : ''}>수량·사유 수정</button>`);
      out.push('<button type="button" class="btn-ghost btn-sm" data-act="reset">다시 확인</button>');
    }
    // 품절관리 추가는 일치·불일치를 기록한 뒤에만 보인다.
    if (r.status !== 'pending') out.push(soldoutHtml(r));
    return out.join('');
  }

  function rowHtml(r) {
    const id = String(r.id);
    const requested = isRequested(r);
    const formKind = state.form && state.form.id === id ? state.form.kind : null;
    const done = r.status === 'mismatch' && !!r.resolved;

    const cls = ['wl-row'];
    if (done) cls.push('is-done');
    if (r.status === 'mismatch' && !done) cls.push('sc-row--mismatch');
    else if (r.status === 'match') cls.push('sc-row--match');
    else if (requested) cls.push('sc-row--req');

    const chips = [];
    if (state.openMode && r.check_date) chips.push(UI.chip(r.check_date, 'warn'));
    for (const s of sourcesOf(r)) {
      const def = SOURCE_LABEL[s];
      chips.push(UI.chip(def ? def[0] : s, def ? def[1] : 'muted'));
    }
    if (r.stock_status) chips.push(UI.chip(r.stock_status, statusTone(r.stock_status)));
    if (r.item_status === '단종' && r.stock_status !== '단종') chips.push(UI.chip('판매등급 단종', 'muted'));

    const notes = [];
    if (r.request_note) notes.push(`<div class="sc-note">요청 메모: ${esc(r.request_note)}</div>`);
    if (r.status === 'mismatch' && r.mismatch_reason) notes.push(`<div class="sc-note sc-note--reason">사유: ${esc(r.mismatch_reason)}</div>`);
    if (done) {
      const who = [r.resolved_by_name, UI.fmtDateTime(r.resolved_at)].filter(Boolean).join(' · ');
      const text = ['처리완료', who, r.resolved_note].filter(Boolean).join(' — ');
      notes.push(`<div class="sc-note">${esc(text)}</div>`);
    }
    let reqLine = '';
    if (requested) {
      const who = [r.requested_by_name, UI.fmtDateTime(r.created_at)].filter(Boolean).join(' · ');
      if (who) reqLine = `<div class="wl-meta">요청: ${esc(who)}</div>`;
    }

    return `
      <li class="${cls.join(' ')}" data-id="${esc(id)}">
        <div class="wl-main">
          <button type="button" class="wl-code sc-code" data-act="open-item" title="상품조회에서 보기">${esc(r.item_code)}</button>
          <div class="wl-name">${esc(r.item_name)}</div>
          <div class="wl-meta"><span class="sc-loc">${esc(locText(r.location_code))}</span></div>
          <div class="wl-meta">${UI.rackChips(r.racks)}</div>
          <div class="wl-meta">${chips.join('')}</div>
          ${notes.join('')}
          ${reqLine}
        </div>
        <div class="wl-side">${sideHtml(r)}</div>
        <div class="wl-actions">${actionsHtml(r, formKind)}</div>
        ${formKind ? formHtml(r, formKind) : ''}
      </li>`;
  }

  function stateHtml(text, sub, btnAct, btnLabel) {
    return `<div class="sc-state"><p class="empty">${esc(text)}${sub ? `<br><small>${esc(sub)}</small>` : ''}</p>${
      btnAct ? `<button type="button" class="btn-ghost" data-act="${btnAct}">${esc(btnLabel)}</button>` : ''}</div>`;
  }

  function renderBody() {
    const body = state.bodyEl;
    if (state.phase === 'loading') { body.innerHTML = stateHtml('불러오는 중…'); return; }
    if (state.phase === 'error') { body.innerHTML = stateHtml('불러오지 못했습니다', state.errorMsg, 'retry', '다시 시도'); return; }
    if (state.phase !== 'ready') { body.innerHTML = ''; return; }

    if (!state.items.length) {
      body.innerHTML = stateHtml(state.openMode ? '미처리 불일치가 없습니다.' : `${state.date} 에는 재고확인 대상이 없습니다.`);
      return;
    }
    const rows = sortRows(state.items.filter(isVisible));
    if (!rows.length) {
      body.innerHTML = stateHtml('조건에 맞는 항목이 없습니다.', `전체 ${state.items.length}건`, 'reset-filters', '필터 초기화');
      return;
    }
    body.innerHTML =
      `<p class="sc-summary">표시 ${esc(UI.num(rows.length))}건 / 전체 ${esc(UI.num(state.items.length))}건</p>` +
      `<ul class="wl-list">${rows.map(rowHtml).join('')}</ul>`;
  }

  function rowEl(id) {
    for (const li of state.bodyEl.querySelectorAll('li.wl-row')) {
      if (li.dataset.id === String(id)) return li;
    }
    return null;
  }

  // 한 행만 다시 그린다(스크롤·필터 유지)
  function replaceRow(id) {
    const el = rowEl(id);
    const r = state.index.get(String(id));
    if (!el || !r) return null;
    const tpl = document.createElement('template');
    tpl.innerHTML = rowHtml(r).trim();
    const next = tpl.content.firstElementChild;
    el.replaceWith(next);
    return next;
  }

  /* ---------- data ---------- */
  function currentKey() { return state.openMode ? 'open' : `date:${state.date}`; }

  async function load() {
    const key = currentKey();
    const seq = ++state.seq;
    state.form = null;
    state.sticky.clear();
    // 같은 목록을 다시 불러올 때는 화면을 비우지 않는다(스크롤 유지)
    if (!(state.phase === 'ready' && state.loadedKey === key)) {
      state.phase = 'loading';
      state.items = [];
      state.index = new Map();
      state.loadedKey = null;
      renderBody();
      updateCounts();
    }
    try {
      const res = await UI.api.get('/stock_checks', state.openMode ? { open_mismatch: 1 } : { date: state.date });
      if (seq !== state.seq) return;
      state.items = Array.isArray(res && res.items) ? res.items : [];
      state.index = new Map(state.items.map(r => [String(r.id), r]));
      state.loadedKey = key;
      state.phase = 'ready';
    } catch (err) {
      if (seq !== state.seq) return;
      state.items = [];
      state.index = new Map();
      state.loadedKey = null;
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
    if (state.form && state.form.id === id) state.form = null;
    replaceRow(id);
    updateCounts();
    Shell.refreshBadges();
  }

  async function write(btn, path, body) {
    const res = await UI.busy(btn, () => UI.api.post(path, body));
    if (res === undefined) return false;
    applyItem(res && res.item);
    return true;
  }

  // 일치로 확인한 재고가 기준 미만이면 품절관리에 자동으로 올린다.
  const AUTO_SOLDOUT_BELOW = 10;
  async function autoSoldout(id) {
    const r = state.index.get(String(id));
    if (!r || r.status !== 'match' || r.in_soldout) return;
    const qty = numOrNull(r.counted_qty) ?? totalStock(r);
    if (qty === null || qty >= AUTO_SOLDOUT_BELOW) return;
    try {
      const res = await UI.api.post('/soldout_items/add', { item_code: r.item_code, source: 'stock_check', source_id: r.id });
      const cur = state.index.get(String(id));
      if (cur) { cur.in_soldout = true; replaceRow(id); }
      UI.toast(res && res.created === false
        ? `재고 ${UI.num(qty)}개 · 이미 품절관리에 있는 상품입니다`
        : `재고 ${UI.num(qty)}개 · 품절관리에 자동으로 추가했습니다`, 'info');
      Shell.refreshBadges();
    } catch (err) {
      if (!err || err.code !== 'AUTH_REQUIRED') {
        UI.toast(`품절관리 자동 추가 실패: ${(err && err.message) || '요청에 실패했습니다.'}`, 'error');
      }
    }
  }

  function openForm(id, kind) {
    const prev = state.form;
    state.form = { id: String(id), kind };
    if (prev && prev.id !== String(id)) replaceRow(prev.id);
    const el = replaceRow(id);
    const input = el && el.querySelector('.sc-form input');
    if (input) {
      try { input.focus({ preventScroll: false }); if (input.select) input.select(); } catch (_) {}
    }
  }
  function closeForm() {
    const prev = state.form;
    state.form = null;
    if (prev) replaceRow(prev.id);
  }

  function changeFilter(mutate) {
    mutate();
    state.sticky.clear();
    state.form = null;
    syncToolbar();
    renderBody();
  }

  /* ---------- events ---------- */
  async function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !state.root.contains(btn)) return;
    const act = btn.dataset.act;

    switch (act) {
      case 'f-status': changeFilter(() => { state.filter.status = btn.dataset.val; }); return;
      case 'f-kind': changeFilter(() => { state.filter.kind = btn.dataset.val; }); return;
      case 'toggle-disc': changeFilter(() => { state.filter.hideDisc = !state.filter.hideDisc; }); return;
      case 'toggle-open':
        state.openMode = !state.openMode;
        syncToolbar();
        load();
        return;
      case 'retry': load(); return;
      case 'reset-filters': {
        const q = state.root.querySelector('.sc-q');
        if (q) q.value = '';
        changeFilter(() => { state.filter = { status: 'all', kind: 'all', hideDisc: false, q: '' }; });
        return;
      }
      default:
    }

    const li = btn.closest('li.wl-row');
    if (!li) return;
    const id = li.dataset.id;
    const r = state.index.get(id);
    if (!r) return;

    switch (act) {
      case 'open-item':
        Shell.show('items', { code: r.item_code });
        return;
      case 'match':
        if (await write(btn, '/stock_checks/record', { id: r.id, result: 'match' })) await autoSoldout(id);
        return;
      case 'open-mismatch': openForm(id, 'mismatch'); return;
      case 'open-resolve': openForm(id, 'resolve'); return;
      case 'form-cancel': closeForm(); return;
      case 'reset':
        if (!(await UI.confirm(`${r.item_code}\n기록한 확인 결과를 지우고 미확인으로 되돌릴까요?`))) return;
        await write(btn, '/stock_checks/record', { id: r.id, result: 'pending' });
        return;
      case 'unresolve':
        await write(btn, '/stock_checks/resolve', { id: r.id, resolved: false });
        return;
      case 'soldout': {
        const res = await UI.busy(btn, () => UI.api.post('/soldout_items/add', {
          item_code: r.item_code, source: 'stock_check', source_id: r.id,
        }));
        if (res === undefined) return;
        UI.toast(res && res.created === false ? '이미 품절관리에 있는 상품입니다' : '품절관리에 추가했습니다', res && res.created === false ? 'info' : 'ok');
        const cur = state.index.get(id);
        if (cur) { cur.in_soldout = true; replaceRow(id); }
        Shell.refreshBadges();
        return;
      }
      default:
    }
  }

  async function onSubmit(ev) {
    const form = ev.target.closest('form.sc-form');
    if (!form) return;
    ev.preventDefault();
    const li = form.closest('li.wl-row');
    const r = li && state.index.get(li.dataset.id);
    if (!r) return;
    const submitBtn = form.querySelector('button[type="submit"]');

    if (form.dataset.form === 'mismatch') {
      const input = form.elements.qty;
      const raw = String(input.value).trim();
      const qty = Number(raw);
      if (!raw || !Number.isInteger(qty) || qty < 0) {
        UI.toast('실재고 수량을 0 이상의 숫자로 입력해 주세요', 'error');
        input.focus();
        return;
      }
      await write(submitBtn, '/stock_checks/record', {
        id: r.id, result: 'mismatch', counted_qty: qty, reason: String(form.elements.reason.value).trim(),
      });
      return;
    }
    await write(submitBtn, '/stock_checks/resolve', {
      id: r.id, resolved: true, note: String(form.elements.note.value).trim(),
    });
  }

  function onInput(ev) {
    if (!ev.target.classList || !ev.target.classList.contains('sc-q')) return;
    const value = ev.target.value;
    clearTimeout(state.qTimer);
    state.qTimer = setTimeout(() => {
      const q = String(value).trim().toLowerCase();
      if (q === state.filter.q) return;
      changeFilter(() => { state.filter.q = q; });
    }, 150);
  }

  /* ---------- lifecycle ---------- */
  function segHtml(group, act, opts) {
    return `<div class="seg sc-seg-${group}" role="group">${opts.map(([val, label]) =>
      `<button type="button" data-act="${act}" data-val="${val}">${label}<span class="sc-cnt" data-cnt="${group}:${val}"></span></button>`).join('')}</div>`;
  }

  function mount(root) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    state.root = root;
    state.date = today();
    root.classList.add('tab-stockcheck');
    root.innerHTML = `
      <div class="view-head"><h2>재고확인</h2><div class="sc-datebar"></div></div>
      <div class="view-toolbar sc-toolbar">
        <button type="button" class="btn-sm sc-toggle sc-open-toggle" data-act="toggle-open" aria-pressed="false">미처리 불일치만 보기 (전체 날짜)</button>
        ${segHtml('status', 'f-status', STATUS_OPTS)}
        ${segHtml('kind', 'f-kind', KIND_OPTS)}
        <button type="button" class="btn-sm sc-toggle" data-act="toggle-disc" aria-pressed="false">단종 제외</button>
        <input type="search" class="sc-q" placeholder="코드 · 상품명 · 위치" aria-label="목록 내 검색" autocomplete="off" />
        <button type="button" class="btn-sm" data-scan-for=".sc-q" title="사진으로 코드 읽기" aria-label="사진으로 코드 읽기">📷</button>
      </div>
      <div class="view-body"></div>`;
    state.bodyEl = root.querySelector('.view-body');
    state.dateBar = UI.dateBar(root.querySelector('.sc-datebar'), {
      value: state.date,
      onChange: ymd => { state.date = ymd; load(); },
    });
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    syncToolbar();
  }

  function onShow(params) {
    const p = params || {};
    if (isYmd(p.date)) {
      state.date = p.date;
      state.dateBar.set(p.date);
      if (state.openMode) { state.openMode = false; }
    } else if (p.open === '1') {
      state.openMode = true;     // 상품조회 첫 화면의 '불일치 미처리' 바로가기
    }
    syncToolbar();
    load();
  }

  function onHide() {
    clearTimeout(state.qTimer);
    state.seq++;                 // 진행 중이던 조회 결과는 버린다
    if (state.phase === 'loading') state.phase = 'idle';
  }

  Shell.register({ id: 'stockcheck', label: '재고확인', mount, onShow, onHide });
})();
