// tabs/irregular.js — 이형포장 탭
// MOPS가 엑셀 출력 시 저장한 그날의 이형 품목을 포장 담당자가 위에서부터 처리한다.
(function () {
  'use strict';

  const STATUSES = ['대기', '작업중', '포장완료'];
  const STATUS_TONE = { '대기': 'muted', '작업중': 'warn', '포장완료': 'ok' };
  const FILTERS = [['all', '전체'], ['대기', '대기'], ['작업중', '작업중'], ['포장완료', '포장완료']];
  const REQUESTS = {
    stock: {
      path: '/stock_checks/request', key: 'stock_check',
      label: '재고확인 요청', doneLabel: '재고확인 요청됨', okMsg: '재고확인 리스트에 추가했습니다',
    },
    display: {
      path: '/display_requests/request', key: 'display',
      label: '진열 요청', doneLabel: '진열 요청됨', okMsg: '진열보충 리스트에 추가했습니다',
    },
  };
  const EMPTY_TEXT = '이 날짜에 저장된 이형 리스트가 없습니다. MOPS 물류관리에서 엑셀로 출력하면 자동으로 저장됩니다.';

  const state = {
    root: null,
    els: {},
    dateBar: null,
    date: '',
    followToday: true,   // 사용자가 다른 날짜를 고르지 않았으면 날짜가 바뀔 때 오늘을 따라간다
    items: [],
    loaded: false,       // 현재 날짜의 목록을 한 번이라도 받았는지
    error: '',
    filter: 'all',
    seq: 0,              // 늦게 도착한 응답 무시용
    note: null,          // 열려 있는 요청 메모칸 {id, kind, text}
    rendering: false,    // 목록을 통째로 다시 그리는 중(이때 생기는 focusout 무시)
  };

  const esc = v => UI.esc(v);

  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function toInt(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function locText(v) {
    const s = String(v ?? '').trim();
    return !s || s === '00' ? '위치 미지정' : s;
  }
  function findItem(id) { return state.items.find(it => String(it.id) === String(id)); }
  function rowEl(id) {
    if (!state.els.body) return null;
    for (const li of state.els.body.querySelectorAll('.wl-row')) {
      if (li.dataset.id === String(id)) return li;
    }
    return null;
  }
  function rowIdOf(el) {
    const li = el && el.closest ? el.closest('.wl-row') : null;
    return li ? li.dataset.id : null;
  }
  function boxInput(id) {
    const li = rowEl(id);
    return li ? li.querySelector('input[data-role="box"]') : null;
  }
  function cmp(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true });
  }
  function sortItems(list) {
    return list.slice().sort((a, b) => {
      const da = a.status === '포장완료' ? 1 : 0;
      const db = b.status === '포장완료' ? 1 : 0;
      return da - db || cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code);
    });
  }

  /* ---------- styles ---------- */
  function injectStyle() {
    if (document.getElementById('tab-irregular-style')) return;
    const style = document.createElement('style');
    style.id = 'tab-irregular-style';
    style.textContent = `
.tab-irregular .irr-summary{ margin:0 0 10px; padding:8px 10px; border-radius:10px; background:#f1f5f9; font-size:13px; line-height:1.6; color:#334155; }
.tab-irregular .irr-summary b{ color:#0f172a; }
.tab-irregular .irr-batch{ margin:14px 0 6px; font-size:13px; font-weight:700; color:#475569; word-break:break-all; }
.tab-irregular .irr-batch:first-child{ margin-top:0; }
.tab-irregular .irr-loc{ font-size:20px; font-weight:800; line-height:1.25; color:#0f172a; word-break:break-all; }
.tab-irregular .irr-code{ appearance:none; display:inline-block; min-height:32px; padding:4px 0; border:0; background:none; color:#0369a1; font:inherit; font-size:13px; text-decoration:underline; text-align:left; cursor:pointer; }
.tab-irregular .irr-qty{ font-size:14px; font-weight:700; color:#0f172a; }
.tab-irregular .wl-row.is-done{ opacity:1; }
.tab-irregular .wl-row.is-done .wl-main{ opacity:.55; }
.tab-irregular .btn-sm, .tab-irregular .btn-primary, .tab-irregular .btn-ghost{ min-height:44px; }
.tab-irregular .seg > button{ min-height:44px; }
.tab-irregular .irr-filter{ flex:1 1 260px; }
.tab-irregular .irr-status{ flex:1 1 220px; display:flex; }
.tab-irregular .irr-status > button{ font-size:14px; }
.tab-irregular .irr-status > button.is-active[data-value="대기"]{ background:#64748b; }
.tab-irregular .irr-status > button.is-active[data-value="작업중"]{ background:#d97706; }
.tab-irregular .irr-status > button.is-active[data-value="포장완료"]{ background:#16a34a; }
.tab-irregular .irr-box{ display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; color:#334155; }
.tab-irregular .irr-box input{ width:76px; height:44px; padding:0 8px; border:1px solid #cbd5e1; border-radius:10px; background:#fff; color:#0f172a; font:inherit; font-size:16px; text-align:right; }
.tab-irregular .irr-box input:focus{ outline:none; border-color:#38bdf8; box-shadow:0 0 0 3px rgba(56,189,248,.25); }
.tab-irregular .irr-box input:disabled{ background:#f1f5f9; color:#64748b; }
.tab-irregular .irr-tick{ width:14px; color:#16a34a; font-weight:700; opacity:0; transition:opacity .2s ease; }
.tab-irregular .irr-tick.is-on{ opacity:1; }
.tab-irregular .irr-req.is-requested{ background:#e0f2fe; border-color:#7dd3fc; color:#075985; }
.tab-irregular .irr-note{ flex:1 0 100%; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding-top:8px; border-top:1px dashed #e2e8f0; }
.tab-irregular .irr-note[hidden]{ display:none; }
.tab-irregular .irr-note label{ flex:1 0 100%; font-size:12px; font-weight:600; color:#475569; }
.tab-irregular .irr-note input{ flex:1 1 160px; min-width:0; height:44px; padding:0 10px; border:1px solid #cbd5e1; border-radius:10px; background:#fff; color:#0f172a; font:inherit; font-size:16px; }
.tab-irregular .irr-note input:focus{ outline:none; border-color:#38bdf8; box-shadow:0 0 0 3px rgba(56,189,248,.25); }
.tab-irregular .irr-error{ text-align:center; }
`;
    document.head.append(style);
  }

  /* ---------- html builders ---------- */
  function mainHtml(it) {
    const mixed = Number(it.mixed_order_count) > 0 ? `<span>합포 ${esc(UI.num(it.mixed_order_count))}건</span>` : '';
    const changed = it.status_changed_at || it.status_changed_by_name
      ? `<div class="wl-meta">상태 변경: ${esc(it.status_changed_by_name || '-')}${it.status_changed_at ? ' · ' + esc(UI.fmtDateTime(it.status_changed_at)) : ''}</div>`
      : '';
    return `
      <div class="irr-loc">${esc(locText(it.location_code))}</div>
      <button type="button" class="wl-code irr-code" data-act="open-item">${esc(it.item_code)}</button>
      <div class="wl-name">${esc(it.item_name)}</div>
      <div class="wl-meta">
        <span class="irr-qty">수량 ${esc(UI.num(it.qty))}</span>
        <span>주문 ${esc(UI.num(it.order_count))}건</span>
        ${mixed}
        <span>재고 ${esc(UI.num(it.stock_today))}</span>
      </div>
      <div class="wl-meta">${UI.rackChips(it.racks)}</div>
      ${changed}`;
  }

  function sideHtml(it) {
    const status = STATUSES.includes(it.status) ? it.status : '대기';
    return UI.chip(status, STATUS_TONE[status]) + (it.stale ? UI.chip('주문서에서 제외됨', 'danger') : '');
  }

  function statusHtml(it) {
    return STATUSES.map(s =>
      `<button type="button" data-act="status" data-value="${esc(s)}"${it.status === s ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${esc(s)}</button>`
    ).join('');
  }

  function reqHtml(it) {
    const open = it.open_requests || {};
    return Object.keys(REQUESTS).map(kind => {
      const r = REQUESTS[kind];
      const on = !!open[r.key];
      return `<button type="button" class="btn-sm irr-req${on ? ' is-requested' : ''}" data-act="req" data-kind="${kind}">${on ? r.doneLabel : r.label}</button>`;
    }).join('');
  }

  function noteHtml(note) {
    const r = REQUESTS[note.kind];
    return `
      <label>${r.label} 메모 (선택)</label>
      <input type="text" data-role="note" maxlength="200" autocomplete="off" placeholder="예: 박스 파손, 수량 부족" value="${esc(note.text || '')}" />
      <button type="button" class="btn-primary" data-act="note-submit">요청 보내기</button>
      <button type="button" class="btn-ghost" data-act="note-cancel">취소</button>`;
  }

  function rowHtml(it) {
    const note = state.note && String(state.note.id) === String(it.id) ? state.note : null;
    const box = toInt(it.expected_box_count);
    return `
      <li class="wl-row${it.status === '포장완료' ? ' is-done' : ''}" data-id="${esc(it.id)}">
        <div class="wl-main" data-part="main">${mainHtml(it)}</div>
        <div class="wl-side" data-part="side">${sideHtml(it)}</div>
        <div class="wl-actions">
          <div class="seg irr-status" data-part="status" role="group" aria-label="작업 상태">${statusHtml(it)}</div>
          <label class="irr-box">예상박스
            <input type="text" data-role="box" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"
                   placeholder="-" aria-label="예상박스수량" value="${box === null ? '' : esc(box)}" />
            <span class="irr-tick" data-role="tick" aria-hidden="true">✓</span>
          </label>
        </div>
        <div class="wl-actions" data-part="req">${reqHtml(it)}</div>
        <div class="irr-note" data-part="note"${note ? '' : ' hidden'}>${note ? noteHtml(note) : ''}</div>
      </li>`;
  }

  /* ---------- render ---------- */
  function renderSummary() {
    const el = state.els.summary;
    if (!el) return;
    if (!state.loaded || !state.items.length) { el.hidden = true; el.innerHTML = ''; return; }
    let qty = 0, boxes = 0, missing = 0;
    const count = { '대기': 0, '작업중': 0, '포장완료': 0 };
    for (const it of state.items) {
      qty += Number(it.qty) || 0;
      const box = toInt(it.expected_box_count);
      if (box === null) missing += 1; else boxes += box;
      if (count[it.status] !== undefined) count[it.status] += 1;
    }
    el.hidden = false;
    el.innerHTML =
      `총 <b>${esc(UI.num(state.items.length))}</b>개 품목 · 수량 합계 <b>${esc(UI.num(qty))}</b> · ` +
      `대기 <b>${count['대기']}</b> / 작업중 <b>${count['작업중']}</b> / 포장완료 <b>${count['포장완료']}</b> · ` +
      `예상박스 합계 <b>${esc(UI.num(boxes))}</b>${missing ? ` (미입력 ${esc(UI.num(missing))}건)` : ''}`;
  }

  function renderFilter() {
    const el = state.els.filter;
    if (!el) return;
    el.querySelectorAll('button').forEach(btn => {
      const on = btn.dataset.filter === state.filter;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function listHtml() {
    if (!state.loaded) {
      if (state.error) {
        return `<div class="irr-error"><p class="empty">불러오지 못했습니다<br>${esc(state.error)}</p>
          <button type="button" class="btn-primary" data-act="reload">다시 시도</button></div>`;
      }
      return '<p class="empty">불러오는 중…</p>';
    }
    if (!state.items.length) return `<p class="empty">${esc(EMPTY_TEXT)}</p>`;

    const shown = state.filter === 'all' ? state.items : state.items.filter(it => it.status === state.filter);
    if (!shown.length) return `<p class="empty">'${esc(state.filter)}' 상태인 품목이 없습니다.</p>`;

    const batches = Array.from(new Set(state.items.map(it => String(it.batch_key ?? '')))).sort(cmp);
    if (batches.length <= 1) {
      return `<ul class="wl-list">${sortItems(shown).map(rowHtml).join('')}</ul>`;
    }
    return batches.map(key => {
      const rows = sortItems(shown.filter(it => String(it.batch_key ?? '') === key));
      if (!rows.length) return '';
      return `<h3 class="irr-batch">${esc(key || '(주문서 이름 없음)')} · ${rows.length}개</h3>
        <ul class="wl-list">${rows.map(rowHtml).join('')}</ul>`;
    }).join('');
  }

  // 목록 전체를 다시 그린다. 입력 중이던 예상박스 값·메모는 가능한 한 되살린다.
  function renderList() {
    const body = state.els.body;
    if (!body) return;
    const active = document.activeElement;
    let keep = null;
    if (active && body.contains(active) && active.matches('input[data-role="box"], input[data-role="note"]')) {
      keep = { role: active.dataset.role, id: rowIdOf(active), value: active.value };
    }
    if (state.note) {
      const li = rowEl(state.note.id);
      const input = li && li.querySelector('input[data-role="note"]');
      if (input) state.note.text = input.value;
    }

    state.rendering = true;
    try { body.innerHTML = listHtml(); } finally { state.rendering = false; }

    if (state.note && !rowEl(state.note.id)) state.note = null;
    if (keep && keep.id) {
      const li = rowEl(keep.id);
      const input = li && li.querySelector(`input[data-role="${keep.role}"]`);
      if (input) {
        input.value = keep.value;
        try { input.focus({ preventScroll: true }); } catch (_) {}
      }
    }
  }

  function renderAll() {
    renderFilter();
    renderSummary();
    renderList();
  }

  // 한 행만 제자리에서 갱신한다. 예상박스 입력칸과 메모칸은 건드리지 않는다.
  function patchRow(it) {
    const li = rowEl(it.id);
    if (!li) return;
    li.classList.toggle('is-done', it.status === '포장완료');
    const set = (part, html) => {
      const el = li.querySelector(`[data-part="${part}"]`);
      if (el) el.innerHTML = html;
    };
    set('main', mainHtml(it));
    set('side', sideHtml(it));
    set('status', statusHtml(it));
    set('req', reqHtml(it));
    const input = li.querySelector('input[data-role="box"]');
    if (input && input !== document.activeElement && !input.disabled) {
      const box = toInt(it.expected_box_count);
      input.value = box === null ? '' : String(box);
    }
  }

  function renderNote(prevId) {
    const ids = new Set([prevId, state.note && state.note.id].filter(v => v !== null && v !== undefined).map(String));
    for (const id of ids) {
      const li = rowEl(id);
      const el = li && li.querySelector('[data-part="note"]');
      if (!el) continue;
      const open = state.note && String(state.note.id) === id;
      el.hidden = !open;
      el.innerHTML = open ? noteHtml(state.note) : '';
    }
  }

  /* ---------- data ---------- */
  async function load() {
    const seq = ++state.seq;
    const date = state.date;
    if (!state.loaded) { state.error = ''; renderAll(); }
    try {
      const res = await UI.api.get('/irregular_items', { date });
      if (seq !== state.seq) return;
      state.items = Array.isArray(res && res.items) ? res.items : [];
      state.loaded = true;
      state.error = '';
    } catch (err) {
      if (seq !== state.seq) return;
      const msg = (err && err.message) || '요청에 실패했습니다.';
      if (state.loaded) {
        // 이미 보고 있는 목록은 유지한다.
        if (!err || err.code !== 'AUTH_REQUIRED') UI.toast(`불러오지 못했습니다: ${msg}`, 'error');
        return;
      }
      state.error = msg;
    }
    renderAll();
  }

  function setDate(ymd) {
    if (ymd === state.date) return;
    state.date = ymd;
    state.items = [];
    state.loaded = false;
    state.error = '';
    state.note = null;
  }

  // 서버가 돌려준 item으로 교체(없으면 보낸 값만 반영)하고 그 행·요약·뱃지를 갱신한다.
  function applyItem(id, serverItem, fallback) {
    const idx = state.items.findIndex(it => String(it.id) === String(id));
    if (idx < 0) return;
    const merged = Object.assign({}, state.items[idx], serverItem && typeof serverItem === 'object' ? serverItem : fallback);
    state.items[idx] = merged;
    patchRow(merged);
    renderSummary();
    Shell.refreshBadges();
  }

  /* ---------- actions ---------- */
  // 쓰기 요청은 보낸 순서대로 하나씩 처리한다(늦게 온 옛 응답이 새 값을 덮어쓰지 않도록).
  let writeChain = Promise.resolve();
  function postInOrder(path, body) {
    const run = () => UI.api.post(path, body);
    const p = writeChain.then(run, run);
    writeChain = p.catch(() => {});
    return p;
  }

  async function setStatus(btn, id, value) {
    const it = findItem(id);
    if (!it || !STATUSES.includes(value) || it.status === value) return;
    await UI.busy(btn, async () => {
      const res = await postInOrder('/irregular_items/update', { id: it.id, status: value });
      applyItem(id, res && res.item, { status: value });
    });
  }

  function flashTick(id) {
    const li = rowEl(id);
    const tick = li && li.querySelector('[data-role="tick"]');
    if (!tick) return;
    tick.classList.add('is-on');
    setTimeout(() => tick.classList.remove('is-on'), 1800);
  }

  async function saveBox(input) {
    if (state.rendering || input.disabled) return;
    const id = rowIdOf(input);
    const it = id === null ? null : findItem(id);
    if (!it) return;
    const prev = toInt(it.expected_box_count);
    const prevText = prev === null ? '' : String(prev);
    const raw = input.value.trim();
    let next;
    if (raw === '') next = null;
    else if (/^\d{1,6}$/.test(raw)) next = Number(raw);
    else {
      UI.toast('예상박스수량은 0 이상의 숫자로 입력해 주세요', 'error');
      input.value = prevText;
      return;
    }
    if (next === prev) { input.value = prevText; return; }

    input.disabled = true;
    const ok = await UI.busy(null, async () => {
      const res = await postInOrder('/irregular_items/update', { id: it.id, expected_box_count: next });
      applyItem(id, res && res.item, { expected_box_count: next });
      return true;
    });
    input.disabled = false;
    // 저장 중 목록이 다시 그려졌을 수 있으므로 지금 화면의 입력칸을 다시 찾는다.
    const cur = boxInput(id);
    const now = findItem(id);
    if (cur && cur !== document.activeElement) {
      const val = now ? toInt(now.expected_box_count) : prev;
      cur.value = val === null ? '' : String(val);
    }
    if (ok) flashTick(id);
  }

  function toggleNote(id, kind) {
    if (!REQUESTS[kind] || !findItem(id)) return;
    const prevId = state.note ? state.note.id : null;
    const same = state.note && String(state.note.id) === String(id) && state.note.kind === kind;
    state.note = same ? null : { id, kind, text: '' };
    renderNote(prevId);
  }

  function closeNote() {
    const prevId = state.note ? state.note.id : null;
    state.note = null;
    renderNote(prevId);
  }

  async function submitNote(btn) {
    const note = state.note;
    if (!note) return;
    const it = findItem(note.id);
    const r = REQUESTS[note.kind];
    if (!it || !r) { closeNote(); return; }
    const li = rowEl(note.id);
    const input = li && li.querySelector('input[data-role="note"]');
    const text = input ? input.value.trim() : '';
    await UI.busy(btn, async () => {
      const res = await UI.api.post(r.path, {
        item_code: it.item_code,
        source: 'irregular',
        note: text || undefined,
        date: String(it.work_date || state.date).slice(0, 10),
      });
      if (res && res.created === false) UI.toast('이미 요청된 상품입니다 (요청 내용 추가됨)', 'info');
      else UI.toast(r.okMsg, 'ok');
      if (state.note === note) closeNote();
      applyItem(note.id, null, { open_requests: Object.assign({}, it.open_requests, { [r.key]: true }) });
    });
  }

  /* ---------- events ---------- */
  function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !state.root.contains(btn)) return;
    const act = btn.dataset.act;
    if (act === 'reload') { UI.busy(btn, load); return; }
    if (act === 'filter') {
      if (state.filter === btn.dataset.filter) return;
      state.filter = btn.dataset.filter;
      renderFilter();
      renderList();
      return;
    }
    const id = rowIdOf(btn);
    if (id === null) return;
    if (act === 'open-item') {
      const it = findItem(id);
      if (it) Shell.show('items', { code: it.item_code });
    } else if (act === 'status') {
      setStatus(btn, id, btn.dataset.value);
    } else if (act === 'req') {
      toggleNote(id, btn.dataset.kind);
    } else if (act === 'note-submit') {
      submitNote(btn);
    } else if (act === 'note-cancel') {
      closeNote();
    }
  }

  function onFocusOut(ev) {
    const input = ev.target;
    if (input && input.matches && input.matches('input[data-role="box"]')) saveBox(input);
  }

  function onKeyDown(ev) {
    const input = ev.target;
    if (!input || !input.matches || ev.isComposing) return;
    if (input.matches('input[data-role="box"]')) {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      else if (ev.key === 'Escape') {
        const it = findItem(rowIdOf(input));
        const prev = it ? toInt(it.expected_box_count) : null;
        input.value = prev === null ? '' : String(prev);
        input.blur();
      }
    } else if (input.matches('input[data-role="note"]')) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const li = input.closest('.wl-row');
        submitNote(li && li.querySelector('[data-act="note-submit"]'));
      } else if (ev.key === 'Escape') {
        closeNote();
      }
    }
  }

  /* ---------- lifecycle ---------- */
  function mount(root) {
    injectStyle();
    state.root = root;
    state.date = today();
    root.classList.add('tab-irregular');
    root.innerHTML = `
      <div class="view-head"><h2>이형포장</h2><div data-role="datebar"></div></div>
      <div class="view-toolbar">
        <div class="seg irr-filter" data-role="filter" role="group" aria-label="상태 필터">
          ${FILTERS.map(([key, label]) => `<button type="button" data-act="filter" data-filter="${key}">${label}</button>`).join('')}
        </div>
        <button type="button" class="btn-sm" data-act="reload">새로고침</button>
      </div>
      <p class="irr-summary" data-role="summary" hidden></p>
      <div class="view-body" data-role="body"></div>`;
    state.els = {
      filter: root.querySelector('[data-role="filter"]'),
      summary: root.querySelector('[data-role="summary"]'),
      body: root.querySelector('[data-role="body"]'),
    };
    state.dateBar = UI.dateBar(root.querySelector('[data-role="datebar"]'), {
      value: state.date,
      onChange: ymd => {
        state.followToday = ymd === today();
        setDate(ymd);
        load();
      },
    });
    root.addEventListener('click', onClick);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKeyDown);
    renderAll();
  }

  function onShow(params) {
    const now = today();
    let next = state.date;
    if (params && isYmd(params.date)) {
      next = params.date;
      state.followToday = next === now;
    } else if (state.followToday) {
      next = now;
    }
    if (next !== state.date) {
      setDate(next);
      state.dateBar.set(next);
    }
    load();
  }

  Shell.register({ id: 'irregular', label: '이형포장', mount, onShow, onHide() {} });
})();
