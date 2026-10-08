// tabs/items.js — 상품조회 탭: 검색 → 선택 → 상세 → 수정 / 수량확인·진열 요청
(function () {
  'use strict';

  const SEARCH_LIMIT = 100;
  const DEBOUNCE_MS = 250;
  const SIZE_KEYS = ['w', 'l', 'h'];
  const SIZE_LABELS = { w: '가로(W)', l: '세로(L)', h: '높이(H)' };
  // 서버 규칙과 같은 값: 포장타입에 따라 운반상자가 정해진다.
  const FORCED_CARRIER = { '이형': '별도', 'N.P': '' };

  const REQUESTS = {
    stock: {
      path: '/stock_checks/request',
      flag: 'stock_check',
      label: '수량확인 요청',
      title: '수량확인 요청',
      help: '진열랙 수량이 전산 재고와 다를 때 요청합니다.',
      placeholder: '예: 진열랙에 3개만 있음 (선택)',
      okToast: '재고확인 리스트에 추가했습니다',
    },
    display: {
      path: '/display_requests/request',
      flag: 'display',
      label: '진열 요청',
      title: '진열 요청',
      help: '진열랙 재고가 부족하거나 비었을 때 요청합니다.',
      placeholder: '예: 진열랙 비어 있음 (선택)',
      okToast: '진열보충 리스트에 추가했습니다',
    },
  };

  const state = {
    root: null,
    q: '',
    list: null,          // null = 아직 검색 안 함
    listLoading: false,
    listError: '',
    searchSeq: 0,
    timer: null,
    code: '',            // 선택한 상품
    item: null,
    detailLoading: false,
    detailError: '',
    detailSeq: 0,
    pane: 'list',        // 좁은 화면에서 보이는 쪽: 'list' | 'detail'
    mode: 'view',        // 'view' | 'edit'
    noteFor: null,       // null | 'stock' | 'display'
    options: null,       // /item_options 응답
    optionsPromise: null,
    shownOnce: false,
    scan: null,          // 사진에서 읽은 코드 후보가 여러 개일 때 [{text, kind, matches}]
  };

  /* ---------- helpers ---------- */
  const esc = v => UI.esc(v);
  const $ = sel => state.root.querySelector(sel);

  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function stockTone(status) {
    const s = String(status || '');
    if (s === '안정') return 'ok';
    if (s === '주문필요') return 'warn';
    if (s === '주문완료') return 'info';
    if (s === '품절') return 'danger';
    if (s === '단종') return 'muted';
    if (s.includes('보류')) return 'warn';
    return 'muted';
  }
  function stockChip(status) {
    return status ? UI.chip(status, stockTone(status)) : UI.chip('재고상태 없음', 'muted');
  }
  function gradeChip(grade) {
    if (!grade) return UI.chip('등급 없음', 'muted');
    return UI.chip(grade, grade === '단종' ? 'muted' : 'info');
  }

  function isNoLocation(loc) { return !loc || loc === '00'; }
  function normLocation(loc) { const v = String(loc ?? '').trim(); return v === '' ? '00' : v; }

  // 12.50 -> "12.5", 12.00 -> "12", null -> ""
  function fmtSize(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return String(parseFloat(n.toFixed(2)));
  }
  function sizeText(dim) {
    const parts = SIZE_KEYS.map(k => fmtSize(dim && dim[k]));
    if (parts.every(p => p === '')) return '-';
    return parts.map(p => (p === '' ? '-' : p)).join(' × ');
  }
  function carrierLabel(value) { return value ? value : '없음'; }

  function hasPackaging(item) {
    return !!(item && item.packaging && Number(item.packaging.row_count) > 0);
  }

  /* ---------- styles ---------- */
  function injectStyle() {
    if (document.getElementById('tab-items-style')) return;
    const style = document.createElement('style');
    style.id = 'tab-items-style';
    style.textContent = `
.tab-items [hidden]{ display: none !important; }
.tab-items .ti-search{ flex-wrap: nowrap; }
.tab-items .ti-search input{ flex: 1 1 auto; height: 40px; }
.tab-items .ti-search button{ flex: 0 0 auto; min-height: 40px; }
.tab-items .ti-search .ti-scan-btn{ min-width: 44px; padding: 0 10px; font-size: 18px; }
.tab-items .ti-scan{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
.tab-items .ti-scan__label{ flex: 1 0 100%; font-size: 12px; font-weight: 600; color: #475569; }
.tab-items .ti-scan .btn-sm{ max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.tab-items .ti-scan .ti-scan__close{ margin-left: auto; }
.tab-items .ti-home{ display: grid; gap: 16px; }
.tab-items .ti-home__scan{ width: 100%; min-height: 56px; font-size: 17px; font-weight: 700; }
.tab-items .ti-home__title{ display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #334155; }
.tab-items .ti-todo{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tab-items .ti-todo__card{
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0 8px;
  min-height: 64px; padding: 10px 12px; text-align: left; white-space: normal;
  background: #f8fafc; color: #64748b;
}
.tab-items .ti-todo__label{ font-size: 14px; font-weight: 700; color: #334155; }
.tab-items .ti-todo__num{ grid-row: span 2; font-size: 26px; line-height: 1; color: #94a3b8; }
.tab-items .ti-todo__unit{ font-size: 12px; }
.tab-items .ti-todo__card.has-work{ background: #fff7ed; border-color: #fed7aa; }
.tab-items .ti-todo__card.has-work .ti-todo__num{ color: #c2410c; }
.tab-items .ti-count{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-items .ti-row{ cursor: pointer; -webkit-tap-highlight-color: transparent; }
.tab-items .ti-row:hover{ background: #f8fafc; }
.tab-items .ti-row:focus-visible{ outline: 2px solid #38bdf8; outline-offset: 1px; }
.tab-items .ti-row.is-selected{ border-color: #38bdf8; background: #e0f2fe; }
.tab-items .ti-row .wl-code strong{ font-size: 14px; color: #0f172a; }
.tab-items .ti-loc{ margin-left: 6px; font-weight: 600; color: #0369a1; }
.tab-items .ti-qty{ font-size: 12px; line-height: 1.4; color: #64748b; white-space: nowrap; }
.tab-items .ti-qty b{ font-size: 15px; color: #0f172a; }
.tab-items .ti-back{ margin-bottom: 8px; }
.tab-items .ti-card{
  padding: 14px 12px;
  border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;
}
.tab-items .ti-card-head{ margin-bottom: 12px; }
.tab-items .ti-card-head .wl-code{ font-size: 13px; }
.tab-items .ti-card-head .wl-name{ font-size: 17px; }
.tab-items .ti-info{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin: 0; }
.tab-items .ti-info > div{ min-width: 0; }
.tab-items .ti-info .is-wide{ grid-column: 1 / -1; }
.tab-items .ti-info dt{ font-size: 12px; font-weight: 600; color: #64748b; }
.tab-items .ti-info dd{ margin: 2px 0 0; font-size: 15px; line-height: 1.4; color: #0f172a; word-break: break-word; }
.tab-items .ti-section{ margin-top: 14px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
.tab-items .ti-section h3{ margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #334155; }
.tab-items .ti-stock{ display: flex; flex-wrap: wrap; gap: 6px 20px; margin-bottom: 8px; font-size: 13px; color: #64748b; }
.tab-items .ti-stock b{ margin-left: 4px; font-size: 18px; color: #0f172a; }
.tab-items .ti-actions{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
.tab-items .ti-actions button{ min-height: 40px; white-space: normal; }
.tab-items .ti-actions .is-wide{ grid-column: 1 / -1; }
.tab-items .ti-actions .is-requested{ background: #fef3c7; border-color: #fde68a; color: #92400e; }
.tab-items .ti-note{
  margin-top: 10px; padding: 12px;
  border: 1px solid #bae6fd; border-radius: 12px; background: #f0f9ff;
}
.tab-items .ti-note-title{ margin: 0 0 2px; font-size: 14px; font-weight: 700; color: #0f172a; }
.tab-items .ti-note-btns, .tab-items .ti-edit-btns{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.tab-items .ti-note-btns button, .tab-items .ti-edit-btns button{ min-height: 40px; }
.tab-items .ti-edit-btns{
  position: sticky; bottom: calc(var(--footer-h, 56px) + 8px); z-index: 2;
  padding: 8px; margin-left: -8px; margin-right: -8px;
  border: 1px solid #e2e8f0; border-radius: 12px; background: rgba(255,255,255,.96);
}
/* 수정 화면에서는 토스트(오류 안내 등)가 고정된 취소/저장 줄을 가리지 않게 그 위로 올린다 */
body:has(#view-items:not([hidden]) .ti-edit-btns) .toast-host{ bottom: calc(var(--footer-h, 56px) + 84px); }
.tab-items .ti-hint{ margin: 0; font-size: 12px; font-weight: 400; line-height: 1.4; color: #64748b; }
.tab-items .ti-err{ margin: 0; font-size: 12px; font-weight: 600; line-height: 1.4; color: #b91c1c; }
.tab-items .ti-size{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.tab-items .ti-size label{ display: grid; gap: 2px; font-size: 11px; font-weight: 600; color: #64748b; }
.tab-items .field .is-invalid{ border-color: #f87171; }
.tab-items .ti-readonly{
  display: flex; align-items: center; min-height: 40px; padding: 0 10px;
  border: 1px dashed #cbd5e1; border-radius: 10px; background: #f8fafc;
}
.tab-items .ti-link{
  appearance: none; margin-top: 12px; padding: 8px 0; border: 0; background: none;
  color: #0369a1; font: inherit; font-size: 13px; font-weight: 600; text-decoration: underline; cursor: pointer;
}
.tab-items .ti-layout.is-detail .ti-list-pane{ display: none; }
.tab-items .ti-layout:not(.is-detail) .ti-detail-pane{ display: none; }
@media (min-width: 900px){
  .tab-items .ti-layout{ display: grid; grid-template-columns: minmax(320px, 420px) minmax(0, 1fr); gap: 16px; align-items: start; }
  .tab-items .ti-layout.is-detail .ti-list-pane,
  .tab-items .ti-layout:not(.is-detail) .ti-detail-pane{ display: block; }
  .tab-items .ti-list-pane{ max-height: calc(100vh - 200px); overflow: auto; padding: 2px; }
  .tab-items .ti-back{ display: none; }
}`;
    document.head.append(style);
  }

  /* ---------- home (검색 전 첫 화면) ---------- */
  const RECENT_KEY = 'warenavi.items.recent';
  const RECENT_MAX = 10;
  // 오늘 할 일 카드: /tab_counts 의 값 → 누르면 가는 탭
  const TODOS = [
    { key: 'irregular_open', label: '이형포장', unit: '남은 묶음', tab: 'irregular' },
    { key: 'stock_check_pending', label: '재고확인', unit: '미확인', tab: 'stockcheck' },
    { key: 'mismatch_open', label: '불일치', unit: '미처리', tab: 'stockcheck', params: { open: 1 } },
    { key: 'display_open', label: '진열보충', unit: '미완료', tab: 'display' },
  ];

  // 최근 본 상품은 이 기기(브라우저)에만 저장한다. 저장소를 못 쓰는 환경에서는 그냥 비어 있다.
  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter(r => r && typeof r.code === 'string' && r.code).slice(0, RECENT_MAX) : [];
    } catch (_) { return []; }
  }
  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (_) {}
  }
  function pushRecent(item) {
    if (!item || !item.code) return;
    const rest = readRecent().filter(r => r.code !== item.code);
    writeRecent([{ code: item.code, name: item.name || '', location: item.location || '' }].concat(rest));
  }

  function todoHtml() {
    const counts = Shell.counts();
    return TODOS.map((t, i) => {
      const n = counts ? (Number(counts[t.key]) || 0) : null;
      return `
        <button type="button" class="ti-todo__card${n ? ' has-work' : ''}" data-act="todo" data-idx="${i}">
          <span class="ti-todo__label">${esc(t.label)}</span>
          <b class="ti-todo__num">${n === null ? '-' : esc(UI.num(n))}</b>
          <span class="ti-todo__unit">${n === 0 ? '없음' : esc(t.unit)}</span>
        </button>`;
    }).join('');
  }

  function recentRowHtml(r) {
    const loc = isNoLocation(r.location) ? '로케이션 미지정' : r.location;
    return `
      <li class="wl-row ti-row" data-code="${esc(r.code)}" role="button" tabindex="0">
        <div class="wl-main">
          <div class="wl-code"><strong>${esc(r.code)}</strong><span class="ti-loc">${esc(loc)}</span></div>
          <div class="wl-name">${esc(r.name)}</div>
        </div>
      </li>`;
  }

  function homeHtml() {
    const recent = readRecent();
    return `
      <div class="ti-home">
        <button type="button" class="btn-primary ti-home__scan" data-act="scan">📷 라벨 찍어서 찾기</button>
        <section>
          <h3 class="ti-home__title">오늘 할 일</h3>
          <div class="ti-todo">${todoHtml()}</div>
        </section>
        <section>
          <h3 class="ti-home__title">최근 본 상품
            ${recent.length ? '<button type="button" class="btn-sm btn-ghost" data-act="recent-clear">지우기</button>' : ''}</h3>
          ${recent.length
            ? `<ul class="wl-list">${recent.map(recentRowHtml).join('')}</ul>`
            : '<p class="empty">상품을 조회하면 여기에 최근 10개가 남습니다.</p>'}
        </section>
      </div>`;
  }

  // 건수가 새로 도착했을 때 카드 숫자만 바꾼다(첫 화면이 떠 있을 때만).
  function refreshTodo() {
    const box = state.root && state.root.querySelector('.ti-todo');
    if (box) box.innerHTML = todoHtml();
  }

  /* ---------- list ---------- */
  function rowHtml(it) {
    const selected = it.code === state.code;
    const loc = isNoLocation(it.location) ? '로케이션 미지정' : it.location;
    return `
      <li class="wl-row ti-row${selected ? ' is-selected' : ''}" data-code="${esc(it.code)}" role="button" tabindex="0">
        <div class="wl-main">
          <div class="wl-code"><strong>${esc(it.code)}</strong><span class="ti-loc">${esc(loc)}</span></div>
          <div class="wl-name">${esc(it.name)}</div>
          <div class="wl-meta">${stockChip(it.stock_status)}${gradeChip(it.item_status)}</div>
        </div>
        <div class="wl-side">
          <span class="ti-qty">총 재고 <b>${esc(UI.num(it.stock_qty))}</b></span>
          <span class="ti-qty">스토리지렉 <b>${esc(UI.num(it.rack_qty))}</b></span>
        </div>
      </li>`;
  }

  function renderList() {
    const pane = $('.ti-list-pane');
    if (!pane) return;
    if (state.listLoading) {
      pane.innerHTML = '<p class="empty">검색 중…</p>';
      return;
    }
    if (state.listError) {
      pane.innerHTML = `<p class="empty">${esc(state.listError)}</p>`;
      return;
    }
    if (state.list === null) {
      pane.innerHTML = homeHtml();
      return;
    }
    if (!state.list.length) {
      pane.innerHTML = `<p class="empty">"${esc(state.q)}" 검색 결과가 없습니다.</p>`;
      return;
    }
    const more = state.list.length >= SEARCH_LIMIT ? ` (최대 ${SEARCH_LIMIT}건까지 표시 — 검색어를 더 입력해 보세요)` : '';
    pane.innerHTML = `
      <p class="ti-count">${esc(UI.num(state.list.length))}건${esc(more)}</p>
      <ul class="wl-list">${state.list.map(rowHtml).join('')}</ul>`;
  }

  function cancelTimer() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }

  /* ---------- photo scan ---------- */
  function renderScan() {
    const box = $('.ti-scan');
    if (!box) return;
    const list = state.scan || [];
    box.hidden = !list.length;
    box.innerHTML = list.length
      ? `<span class="ti-scan__label">사진에서 읽은 코드 — 찾을 코드를 고르세요</span>
         ${list.map((c, i) => `<button type="button" class="btn-sm" data-act="scan-pick" data-idx="${i}">${c.kind === 'rack' ? '랙 ' : ''}${esc(c.text)}</button>`).join('')}
         <button type="button" class="btn-sm btn-ghost ti-scan__close" data-act="scan-close" aria-label="닫기">닫기</button>`
      : '';
  }

  function clearScan() {
    if (!state.scan) return;
    state.scan = null;
    renderScan();
  }

  // 읽은 코드 하나를 실제 화면에 반영한다.
  async function applyScan(c) {
    if (!c) return;
    if (c.kind === 'rack') {
      // 랙 코드는 창고맵 검색으로 넘긴다.
      if (Shell.show('map') === false) return;
      const input = document.querySelector('#search');
      const button = document.querySelector('#btnSearch');
      if (input) input.value = c.text;
      if (button) button.click();
      return;
    }
    const matches = Array.isArray(c.matches) ? c.matches : [];
    const input = $('#tiQuery');
    if (matches.length === 1 && matches[0].code) {
      if (input) input.value = matches[0].code;
      runSearch(matches[0].code);
      await openCode(matches[0].code);
      return;
    }
    if (input) input.value = c.text;
    setPane('list');
    await runSearch(c.text);
  }

  async function scanPhoto(button) {
    if (!window.Scan) { UI.toast('사진 검색을 불러오지 못했습니다. 새로고침해 주세요.', 'error'); return; }
    const res = await window.Scan.recognize(button);
    if (!res) return;                       // 취소했거나 실패(실패는 이미 안내됨)
    const candidates = Array.isArray(res.candidates) ? res.candidates.filter(c => c && c.text) : [];
    if (!candidates.length) {
      state.scan = null;
      renderScan();
      const raw = Array.isArray(res.raw) ? res.raw.filter(Boolean).slice(0, 4).join(', ') : '';
      UI.toast(`코드를 찾지 못했습니다. 라벨을 가까이서 다시 찍어주세요${raw ? ` (읽은 글자: ${raw})` : ''}`, 'error');
      return;
    }
    if (candidates.length === 1) {
      state.scan = null;
      renderScan();
      await applyScan(candidates[0]);
      return;
    }
    state.scan = candidates;
    renderScan();
    UI.toast(`코드 ${candidates.length}개를 읽었습니다. 찾을 코드를 골라 주세요`, 'info');
  }

  async function runSearch(rawQuery) {
    cancelTimer();
    const q = String(rawQuery ?? '').trim();
    const seq = ++state.searchSeq;   // 늦게 도착한 이전 응답은 버린다
    state.q = q;
    state.listError = '';
    if (!q) {
      state.list = null;
      state.listLoading = false;
      renderList();
      return;
    }
    state.listLoading = true;
    renderList();
    try {
      const data = await UI.api.get('/items_search', { q, limit: SEARCH_LIMIT });
      if (seq !== state.searchSeq) return;
      state.list = Array.isArray(data && data.items) ? data.items : [];
    } catch (err) {
      if (seq !== state.searchSeq) return;
      if (err && err.code === 'AUTH_REQUIRED') { state.list = null; }
      else { state.list = null; state.listError = err?.message || '검색에 실패했습니다.'; }
    }
    state.listLoading = false;
    renderList();
  }

  function scheduleSearch(value) {
    cancelTimer();
    state.timer = setTimeout(() => { state.timer = null; runSearch(value); }, DEBOUNCE_MS);
  }

  function patchListRow(item) {
    if (!Array.isArray(state.list) || !item) return;
    const row = state.list.find(r => r.code === item.code);
    if (!row) return;
    row.name = item.name;
    row.location = item.location;
    row.item_status = item.item_status;
    row.stock_status = item.stock_status;
    if (item.stock) {
      row.stock_qty = item.stock.total;
      row.rack_qty = item.stock.rack_total;
    }
    renderList();
  }

  /* ---------- detail (view) ---------- */
  function setPane(pane) {
    state.pane = pane;
    const layout = $('.ti-layout');
    if (layout) layout.classList.toggle('is-detail', pane === 'detail');
  }

  function requestButtonHtml(kind, item) {
    const def = REQUESTS[kind];
    const requested = !!(item.open_requests && item.open_requests[def.flag]);
    return `<button type="button" class="btn-ghost${requested ? ' is-requested' : ''}" data-act="req-${kind}">
      ${requested ? `${esc(def.label.replace(' 요청', ''))} 요청됨 · 내용 추가` : esc(def.label)}</button>`;
  }

  function noteFormHtml(kind, item) {
    const def = REQUESTS[kind];
    const requested = !!(item.open_requests && item.open_requests[def.flag]);
    return `
      <form class="ti-note" data-form="note" data-kind="${kind}" novalidate>
        <p class="ti-note-title">${esc(def.title)}${requested ? ' (요청 내용 추가)' : ''}</p>
        <div class="field">
          <label for="tiNoteInput" class="ti-hint">${esc(def.help)}</label>
          <input id="tiNoteInput" name="note" type="text" maxlength="200" autocomplete="off" placeholder="${esc(def.placeholder)}" />
        </div>
        <div class="ti-note-btns">
          <button type="button" class="btn-ghost" data-act="note-cancel">취소</button>
          <button type="submit" class="btn-primary" data-act="note-send">요청 보내기</button>
        </div>
      </form>`;
  }

  function viewHtml(item) {
    const pk = item.packaging || {};
    const st = item.stock || {};
    const packed = hasPackaging(item);
    const loc = isNoLocation(item.location) ? `${item.location || '00'} (미지정)` : item.location;
    const updated = UI.fmtDateTime(item.status_updated_at);
    return `
      <div class="ti-card">
        <div class="ti-card-head">
          <div class="wl-code">SKU코드 <strong>${esc(item.code)}</strong></div>
          <div class="wl-name">${esc(item.name)}</div>
        </div>
        <dl class="ti-info">
          <div><dt>로케이션번호</dt><dd>${esc(loc)}</dd></div>
          <div><dt>재고상태</dt><dd>${stockChip(item.stock_status)}</dd></div>
          <div><dt>입고사이즈 (W×L×H)</dt><dd>${esc(sizeText(item.inbound))}</dd></div>
          <div><dt>출고사이즈 (W×L×H)</dt><dd>${esc(sizeText(item.outbound))}</dd></div>
          <div><dt>판매등급</dt><dd>${gradeChip(item.item_status)}</dd></div>
          <div><dt>상태 변경일</dt><dd>${esc(updated || '-')}</dd></div>
          <div><dt>단품 포장타입</dt><dd>${packed && pk.boxtype ? esc(pk.boxtype) : '미지정'}</dd></div>
          <div><dt>단품 운반상자 타입</dt><dd>${packed ? esc(carrierLabel(pk.carrier_type)) : '미지정'}</dd></div>
        </dl>
        <div class="ti-section">
          <h3>재고정보</h3>
          <div class="ti-stock">
            <span>총 재고<b>${esc(UI.num(st.total))}</b></span>
            <span>스토리지렉 합계<b>${esc(UI.num(st.rack_total))}</b></span>
          </div>
          <div class="ti-racks">${UI.rackChips(st.racks)}</div>
        </div>
        <div class="ti-actions">
          ${requestButtonHtml('stock', item)}
          ${requestButtonHtml('display', item)}
          <button type="button" class="btn-primary is-wide" data-act="edit">수정</button>
        </div>
        ${state.noteFor ? noteFormHtml(state.noteFor, item) : ''}
        <button type="button" class="ti-link" data-act="logs">이 상품 작업로그 보기</button>
      </div>`;
  }

  /* ---------- detail (edit) ---------- */
  function optionsHtml(values, current, labelOf) {
    return values.map(v => {
      const label = labelOf ? labelOf(v) : v;
      return `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }

  function sizeInputsHtml(prefix, dim) {
    return `<div class="ti-size">${SIZE_KEYS.map(k => `
      <label>${SIZE_LABELS[k]}
        <input name="${prefix}_${k}" type="text" inputmode="decimal" autocomplete="off" value="${esc(fmtSize(dim && dim[k]))}" />
      </label>`).join('')}</div>`;
  }

  function editHtml(item) {
    const opts = state.options || {};
    const pk = item.packaging || {};
    const packed = hasPackaging(item);
    const curStatus = item.stock_status || '';
    const curBox = packed ? (pk.boxtype || '') : '';
    const curCarrier = packed ? (pk.carrier_type || '') : '';

    const statuses = (opts.stock_statuses || []).slice();
    if (!statuses.includes(curStatus)) statuses.unshift(curStatus);   // '' 또는 목록에 없는 현재값

    // 포장타입: 지금 값이 없을 때만 '미지정', 목록에 없는 현재값(예: 합포)은 현재값으로만 둔다.
    const boxtypes = (opts.boxtypes || []).filter(v => v !== '');
    if (curBox === '') boxtypes.unshift('');
    else if (!boxtypes.includes(curBox)) boxtypes.unshift(curBox);

    const carriers = (opts.carrier_types || ['']).slice();
    if (!carriers.includes('')) carriers.unshift('');
    if (!carriers.includes(curCarrier)) carriers.push(curCarrier);
    // 이미 규칙대로 들어가 있을 때만 처음부터 잠근다(어긋난 기존 값을 몰래 바꾸지 않는다).
    const lockCarrier = Object.prototype.hasOwnProperty.call(FORCED_CARRIER, curBox) && FORCED_CARRIER[curBox] === curCarrier;

    return `
      <form class="ti-card" data-form="edit" novalidate>
        <div class="ti-card-head">
          <div class="wl-code">SKU코드 <strong>${esc(item.code)}</strong></div>
          <div class="wl-name">상품 정보 수정</div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="tiLocation">로케이션번호</label>
            <input id="tiLocation" name="location" type="text" autocomplete="off" autocapitalize="characters" value="${esc(item.location)}" />
            <p class="ti-hint">비우면 미지정(00)으로 저장됩니다.</p>
          </div>
          <div class="field">
            <label for="tiName">상품명</label>
            <input id="tiName" name="name" type="text" autocomplete="off" value="${esc(item.name)}" />
            <p class="ti-err" data-err="name" hidden></p>
          </div>
          <div class="field">
            <span>입고사이즈 (W×L×H)</span>
            ${sizeInputsHtml('inbound', item.inbound)}
            <p class="ti-hint">비우면 출고사이즈와 동일하게 저장됩니다</p>
            <p class="ti-err" data-err="inbound" hidden></p>
          </div>
          <div class="field">
            <span>출고사이즈 (W×L×H)</span>
            ${sizeInputsHtml('outbound', item.outbound)}
            <p class="ti-err" data-err="outbound" hidden></p>
          </div>
          <div class="field">
            <label for="tiStockStatus">재고상태</label>
            <select id="tiStockStatus" name="stock_status">${optionsHtml(statuses, curStatus, v => v || '미지정')}</select>
            <p class="ti-hint">MOPS 자동 계산으로 이후 값이 바뀔 수 있습니다.</p>
          </div>
          <div class="field">
            <span>판매등급</span>
            <div class="ti-readonly">${gradeChip(item.item_status)}</div>
            <p class="ti-hint">판매등급은 MOPS에서 변경합니다</p>
          </div>
          <div class="field">
            <label for="tiBoxtype">단품 포장타입</label>
            <select id="tiBoxtype" name="boxtype">${optionsHtml(boxtypes, curBox, v => v || '미지정')}</select>
          </div>
          <div class="field">
            <label for="tiCarrier">단품 운반상자 타입</label>
            <select id="tiCarrier" name="carrier_type"${lockCarrier ? ' disabled' : ''}>${optionsHtml(carriers, curCarrier, carrierLabel)}</select>
            <p class="ti-hint" data-hint="carrier"${lockCarrier ? '' : ' hidden'}>포장타입에 따라 자동으로 정해집니다.</p>
          </div>
        </div>
        <div class="ti-edit-btns">
          <button type="button" class="btn-ghost" data-act="edit-cancel">취소</button>
          <button type="submit" class="btn-primary" data-act="save">저장</button>
        </div>
      </form>`;
  }

  // 포장타입을 바꿨을 때 운반상자를 서버 규칙대로 맞춘다.
  function applyCarrierRule(form) {
    const box = form.elements.boxtype.value;
    const carrier = form.elements.carrier_type;
    const hint = form.querySelector('[data-hint="carrier"]');
    const forced = Object.prototype.hasOwnProperty.call(FORCED_CARRIER, box);
    if (forced) {
      if (!carrier.disabled) carrier.dataset.prev = carrier.value;
      carrier.value = FORCED_CARRIER[box];
    } else if (carrier.disabled && carrier.dataset.prev !== undefined) {
      carrier.value = carrier.dataset.prev;
    }
    carrier.disabled = forced;
    if (hint) hint.hidden = !forced;
  }

  function parseSize(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return { blank: true, value: null };
    if (!/^\d+(\.\d+)?$/.test(raw)) return { blank: false, bad: true };
    return { blank: false, value: Number(raw) };
  }
  function sameNumber(a, b) {
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
    if (b === null || b === undefined || b === '') return false;
    return Math.abs(Number(a) - Number(b)) < 0.005;
  }

  // 폼 값 → {patch, errors}. patch에는 바뀐 항목만 담는다.
  function collectPatch(form, item) {
    const el = form.elements;
    const patch = {};
    const errors = {};
    const pk = item.packaging || {};
    const packed = hasPackaging(item);

    const name = el.name.value.trim();
    if (!name) errors.name = '상품명을 입력하세요.';
    else if (name !== String(item.name ?? '')) patch.name = name;

    const location = el.location.value.trim();
    if (normLocation(location) !== normLocation(item.location)) patch.location = location;

    const inbound = SIZE_KEYS.map(k => parseSize(el[`inbound_${k}`].value));
    const blanks = inbound.filter(p => p.blank).length;
    if (inbound.some(p => p.bad)) {
      errors.inbound = '입고사이즈는 숫자로 입력하세요. (예: 12.5)';
    } else if (blanks > 0 && blanks < 3) {
      errors.inbound = '입고사이즈는 세 칸을 모두 입력하거나 모두 비워 주세요.';
    } else if (blanks === 3) {
      // 전부 비움 = 출고사이즈 복사. 기존 값이 있었을 때만 세 칸을 함께 보낸다.
      const hadValue = SIZE_KEYS.some(k => !sameNumber(item.inbound && item.inbound[k], null));
      if (hadValue) SIZE_KEYS.forEach(k => { patch[`inbound_${k}`] = null; });
    } else {
      SIZE_KEYS.forEach((k, i) => {
        if (!sameNumber(inbound[i].value, item.inbound && item.inbound[k])) patch[`inbound_${k}`] = inbound[i].value;
      });
    }

    const outbound = SIZE_KEYS.map(k => parseSize(el[`outbound_${k}`].value));
    if (outbound.some(p => p.bad)) {
      errors.outbound = '출고사이즈는 숫자로 입력하세요. (예: 12.5)';
    } else if (outbound.some(p => p.blank)) {
      errors.outbound = '출고사이즈 세 칸을 모두 입력하세요.';
    } else {
      SIZE_KEYS.forEach((k, i) => {
        if (!sameNumber(outbound[i].value, item.outbound && item.outbound[k])) patch[`outbound_${k}`] = outbound[i].value;
      });
    }

    const status = el.stock_status.value;
    if (status !== (item.stock_status || '')) patch.stock_status = status;

    const box = el.boxtype.value;
    if (box !== (packed ? (pk.boxtype || '') : '')) patch.boxtype = box;

    const carrier = el.carrier_type.value;
    if (carrier !== (packed ? (pk.carrier_type || '') : '')) patch.carrier_type = carrier;

    return { patch, errors };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('[data-err]').forEach(p => {
      const msg = errors[p.dataset.err] || '';
      p.textContent = msg;
      p.hidden = !msg;
    });
    form.elements.name.classList.toggle('is-invalid', !!errors.name);
    for (const prefix of ['inbound', 'outbound']) {
      SIZE_KEYS.forEach(k => form.elements[`${prefix}_${k}`].classList.toggle('is-invalid', !!errors[prefix]));
    }
  }

  function isEditDirty() {
    if (state.mode !== 'edit' || !state.item) return false;
    const form = $('form[data-form="edit"]');
    if (!form) return false;
    const { patch, errors } = collectPatch(form, state.item);
    return Object.keys(patch).length > 0 || Object.keys(errors).length > 0;
  }

  /* ---------- detail render / load ---------- */
  function renderDetail() {
    const pane = $('.ti-detail-pane');
    if (!pane) return;
    const back = '<button type="button" class="btn-sm ti-back" data-act="back">← 목록</button>';
    let body;
    if (state.detailLoading) {
      body = '<p class="empty">상품 정보를 불러오는 중…</p>';
    } else if (state.detailError) {
      body = `<p class="empty">${esc(state.detailError)}</p>
        <div class="ti-actions"><button type="button" class="btn-ghost is-wide" data-act="reload">다시 시도</button></div>`;
    } else if (!state.item) {
      body = '<p class="empty">목록에서 상품을 선택하면 상세 정보가 표시됩니다.</p>';
    } else if (state.mode === 'edit') {
      body = editHtml(state.item);
    } else {
      body = viewHtml(state.item);
    }
    pane.innerHTML = back + body;
  }

  function markSelectedRow() {
    state.root.querySelectorAll('.ti-row').forEach(row => {
      row.classList.toggle('is-selected', row.dataset.code === state.code);
    });
  }

  // silent: 지금 보이는 카드를 그대로 둔 채 값만 새로 받아 온다(요청 후 갱신용).
  async function loadDetail(code, { silent = false } = {}) {
    const seq = ++state.detailSeq;
    state.code = code;
    state.detailError = '';
    if (!silent) {
      state.item = null;
      state.mode = 'view';
      state.noteFor = null;
      state.detailLoading = true;
      renderDetail();
    }
    markSelectedRow();
    try {
      const data = await UI.api.get('/item', { code });
      if (seq !== state.detailSeq) return;
      if (!data || !data.item) throw new Error('상품 정보를 찾을 수 없습니다.');
      state.item = data.item;
      state.code = data.item.code || code;
      pushRecent(state.item);
      if (state.list === null && !state.listLoading && !state.listError) renderList();   // 첫 화면의 최근 목록 갱신
    } catch (err) {
      if (seq !== state.detailSeq) return;
      if (silent) return;   // 기존 카드 유지
      state.detailError = err && err.code === 'AUTH_REQUIRED'
        ? '로그인이 필요합니다.'
        : (err?.message || '상품 정보를 불러오지 못했습니다.');
    }
    state.detailLoading = false;
    if (silent && state.mode === 'edit') return;   // 수정 중인 폼은 덮어쓰지 않는다
    renderDetail();
    patchListRow(state.item);
    markSelectedRow();
  }

  async function openCode(code) {
    const target = String(code || '').trim();
    if (!target) return;
    if (state.mode === 'edit' && state.item) {
      if (target === state.code) { setPane('detail'); return; }   // 수정 중인 상품이면 폼 그대로
      if (isEditDirty() && !(await UI.confirm('수정 중인 내용이 있습니다. 저장하지 않고 이동할까요?'))) return;
    }
    setPane('detail');
    window.scrollTo(0, 0);
    await loadDetail(target);
  }

  function loadOptions() {
    if (state.options) return Promise.resolve(state.options);
    if (!state.optionsPromise) {
      state.optionsPromise = UI.api.get('/item_options').then(data => {
        state.options = {
          stock_statuses: Array.isArray(data && data.stock_statuses) ? data.stock_statuses : [],
          boxtypes: Array.isArray(data && data.boxtypes) ? data.boxtypes : [],
          carrier_types: Array.isArray(data && data.carrier_types) ? data.carrier_types.map(v => v ?? '') : [''],
        };
        return state.options;
      }).finally(() => { state.optionsPromise = null; });
    }
    return state.optionsPromise;
  }

  /* ---------- actions ---------- */
  function startEdit(button) {
    return UI.busy(button, async () => {
      const code = state.code;
      await loadOptions();
      if (state.code !== code || !state.item) return;
      state.mode = 'edit';
      state.noteFor = null;
      renderDetail();
    });
  }

  function saveEdit(form) {
    const button = form.querySelector('[data-act="save"]');
    return UI.busy(button, async () => {
      const item = state.item;
      if (!item) return;
      const { patch, errors } = collectPatch(form, item);
      showErrors(form, errors);
      if (Object.keys(errors).length) {
        const first = form.querySelector('.is-invalid');
        if (first) first.focus();
        return;
      }
      if (!Object.keys(patch).length) { UI.toast('변경된 내용이 없습니다'); return; }
      if ('name' in patch) {
        const ok = await UI.confirm('상품명을 바꾸면 신규입고 엑셀 매칭에 영향을 줄 수 있습니다. 계속할까요?');
        if (!ok) return;
      }
      const res = await UI.api.post('/item/update', { item_code: item.code, patch });
      const changed = Array.isArray(res && res.changed) ? res.changed : [];
      UI.toast(changed.length ? `저장했습니다 (${changed.length}개 항목 변경)` : '변경된 내용이 없습니다', changed.length ? 'ok' : 'info');
      if (state.code !== item.code) return;   // 저장 중 다른 상품으로 넘어간 경우
      if (res && res.item) { state.item = res.item; pushRecent(res.item); }
      state.mode = 'view';
      renderDetail();
      patchListRow(state.item);
      if (!(res && res.item)) loadDetail(item.code, { silent: true });
    });
  }

  function openNote(kind) {
    state.noteFor = kind;
    renderDetail();
    const input = $('#tiNoteInput');
    if (input) {
      input.focus();
      try { input.scrollIntoView({ block: 'center' }); } catch (_) {}
    }
  }

  function sendRequest(form) {
    const kind = form.dataset.kind;
    const def = REQUESTS[kind];
    const button = form.querySelector('[data-act="note-send"]');
    if (!def || !state.item) return undefined;
    return UI.busy(button, async () => {
      const code = state.item.code;
      const note = form.elements.note.value.trim();
      const body = { item_code: code, source: 'item', date: today() };
      if (note) body.note = note;
      const res = await UI.api.post(def.path, body);
      UI.toast(res && res.created === false ? '이미 요청된 상품입니다 (요청 내용 추가됨)' : def.okToast, 'ok');
      Shell.refreshBadges();
      if (state.code !== code) return;
      state.noteFor = null;
      if (state.item && state.item.open_requests) state.item.open_requests[def.flag] = true;
      renderDetail();
      await loadDetail(code, { silent: true });
    });
  }

  async function backToList() {
    setPane('list');
    // 코드로 바로 들어온 경우 목록이 비어 있으므로 검색창 내용으로 채운다.
    const input = $('#tiQuery');
    const q = input ? input.value.trim() : '';
    if (state.list === null && !state.listLoading && q) runSearch(q);
  }

  /* ---------- events ---------- */
  function onClick(ev) {
    const actEl = ev.target.closest('[data-act]');
    if (actEl && state.root.contains(actEl)) {
      const act = actEl.dataset.act;
      if (actEl.type === 'submit') return;   // submit 이벤트에서 처리
      if (act === 'back') backToList();
      else if (act === 'reload') { if (state.code) loadDetail(state.code); }
      else if (act === 'edit') startEdit(actEl);
      else if (act === 'edit-cancel') { state.mode = 'view'; renderDetail(); }
      else if (act === 'req-stock') openNote('stock');
      else if (act === 'req-display') openNote('display');
      else if (act === 'note-cancel') { state.noteFor = null; renderDetail(); }
      else if (act === 'logs') { if (state.code) Shell.show('logs', { q: state.code }); }
      else if (act === 'scan') scanPhoto(actEl);
      else if (act === 'scan-pick') applyScan((state.scan || [])[Number(actEl.dataset.idx)]);
      else if (act === 'scan-close') clearScan();
      else if (act === 'todo') { const t = TODOS[Number(actEl.dataset.idx)]; if (t) Shell.show(t.tab, t.params); }
      else if (act === 'recent-clear') { writeRecent([]); renderList(); }
      return;
    }
    const row = ev.target.closest('.ti-row');
    if (row && state.root.contains(row)) openCode(row.dataset.code);
  }

  function onSubmit(ev) {
    const form = ev.target;
    if (!form || !state.root.contains(form)) return;
    ev.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'search') {
      setPane('list');
      runSearch($('#tiQuery').value);
    } else if (kind === 'edit') {
      saveEdit(form);
    } else if (kind === 'note') {
      sendRequest(form);
    }
  }

  function onInput(ev) {
    const target = ev.target;
    if (target.id === 'tiQuery') {
      if (state.mode !== 'edit') setPane('list');
      scheduleSearch(target.value);
      return;
    }
    if (target.classList && target.classList.contains('is-invalid')) {
      const form = target.closest('form[data-form="edit"]');
      if (form && state.item) showErrors(form, collectPatch(form, state.item).errors);
    }
  }

  function onChange(ev) {
    if (ev.target.name === 'boxtype') {
      const form = ev.target.closest('form[data-form="edit"]');
      if (form) applyCarrierRule(form);
    }
  }

  function onKeydown(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = ev.target.closest && ev.target.closest('.ti-row');
    if (row && ev.target === row) {
      ev.preventDefault();
      openCode(row.dataset.code);
    }
  }

  /* ---------- lifecycle ---------- */
  function mount(root) {
    state.root = root;
    injectStyle();
    root.classList.add('tab-items');
    root.innerHTML = `
      <div class="view-head"><h2>상품조회</h2></div>
      <form class="view-toolbar ti-search" data-form="search" role="search" novalidate>
        <input id="tiQuery" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="SKU코드 · 로케이션 · 상품명" aria-label="상품 검색" />
        <button type="button" class="btn-sm ti-scan-btn" data-act="scan" title="사진으로 코드 읽기" aria-label="사진으로 코드 읽기">📷</button>
        <button type="submit" class="btn-primary" data-act="search">검색</button>
      </form>
      <div class="ti-scan" hidden></div>
      <div class="view-body ti-layout">
        <div class="ti-list-pane"></div>
        <div class="ti-detail-pane"></div>
      </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKeydown);
    window.addEventListener('shell:counts', refreshTodo);
    renderList();
    renderDetail();
  }

  function onShow(params) {
    const p = params || {};
    const input = $('#tiQuery');
    const first = !state.shownOnce;
    state.shownOnce = true;

    if (p.code) {
      if (input) input.value = p.code;
      // 검색창 내용이 바뀌었으니 예전 목록 대신 "← 목록"에서 다시 검색하게 한다.
      if (state.q !== p.code) { cancelTimer(); state.searchSeq++; state.q = p.code; state.list = null; state.listLoading = false; state.listError = ''; renderList(); }
      openCode(p.code);
      return;
    }
    if (p.q) {
      if (input) input.value = p.q;
      if (state.mode !== 'edit') setPane('list');
      runSearch(p.q);
      return;
    }
    if (first && input) input.focus();
  }

  function onHide() {
    // 입력만 해 두고 떠난 검색은 바로 실행해 두어 돌아왔을 때 결과가 보이게 한다.
    if (state.timer) {
      const input = $('#tiQuery');
      runSearch(input ? input.value : '');
    }
  }

  Shell.register({ id: 'items', label: '상품조회', mount, onShow, onHide });
})();
