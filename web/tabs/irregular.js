// tabs/irregular.js — 이형포장 탭
// MOPS가 엑셀 출력 시 저장한 그날의 이형 묶음(주문 1건 = 카드 1장)을 포장 담당자가 위에서부터 처리한다.
// 작업 상태는 묶음에 한 번, 진열 요청은 묶음 안 상품마다 둔다.
(function () {
  'use strict';

  const STATUSES = ['대기', '작업중', '포장완료'];
  const STATUS_TONE = { '대기': 'muted', '작업중': 'warn', '포장완료': 'ok' };
  const FILTERS = [['all', '전체'], ['대기', '대기'], ['작업중', '작업중'], ['포장완료', '포장완료']];
  const REQUESTS = {
    display: {
      path: '/display_requests/request', key: 'display',
      label: '진열 요청', short: '진열요청', okMsg: '진열보충 리스트에 추가했습니다',
    },
  };
  const EMPTY_TEXT = '이 날짜에 저장된 이형 리스트가 없습니다. MOPS 물류관리에서 엑셀로 출력하면 자동으로 저장됩니다.';

  const state = {
    root: null,
    els: {},
    dateBar: null,
    date: '',
    followToday: true,   // 사용자가 다른 날짜를 고르지 않았으면 날짜가 바뀔 때 오늘을 따라간다
    bundles: [],
    loaded: false,       // 현재 날짜의 목록을 한 번이라도 받았는지
    error: '',
    filter: 'all',
    seq: 0,              // 늦게 도착한 응답 무시용
    note: null,          // 열려 있는 요청 메모칸 {id(묶음), line(상품 줄), kind, text}
    open: new Set(),     // 펼쳐 둔 합포장 묶음 id (합포장 2종 이상은 접힌 채로 시작한다)
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
  function findBundle(id) { return state.bundles.find(b => String(b.id) === String(id)); }
  function linesOf(b) { return Array.isArray(b && b.items) ? b.items : []; }
  function findLine(b, lineId) { return linesOf(b).find(l => String(l.id) === String(lineId)); }
  // 박스에 적을 번호. 서버가 묶음마다 한 번 붙여 저장한 값(box_no)이라 이후 바뀌지 않는다.
  // 하루 안에서 이어지고(오전·오후 수집분 누적), 첫 상품 로케이션의 숫자 순으로 붙는다.
  function boxNo(b) {
    const n = toInt(b && b.box_no);
    return n !== null && n > 0 ? n : null;
  }
  // 주문서(수집 회차) 목록: 박스 번호가 앞선 것부터. 이 순서로 번호 표시 색을 정한다(연파랑 → 연빨강 → 연노랑 …).
  const BATCH_TONES = 5;
  function batchKeys() {
    return Array.from(new Set(sortBundles(state.bundles).map(b => String(b.batch_key ?? ''))));
  }
  function batchTone(b) {
    const i = batchKeys().indexOf(String(b.batch_key ?? ''));
    return (i < 0 ? 0 : i) % BATCH_TONES;
  }
  function bundleLabel(b) {
    const n = boxNo(b);
    return n === null ? '-' : String(n).padStart(2, '0');
  }
  // 합포장(상품 2종 이상) 묶음만 접을 수 있다. 접힌 묶음은 '첫 로케이션 + 그 외 N종' 한 줄로 줄인다.
  function canFold(b) { return linesOf(b).length > 1; }
  function isFolded(b) {
    return canFold(b) && !state.open.has(String(b.id));
  }
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
  function lineIdOf(el) {
    const line = el && el.closest ? el.closest('.irr-line') : null;
    return line ? line.dataset.line : null;
  }
  function noteInput() {
    return state.els.body ? state.els.body.querySelector('input[data-role="note"]') : null;
  }
  function cmp(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true });
  }
  // 박스 번호 순. 포장완료도 제자리에 둔다(박스에 적힌 번호로 찾을 수 있게). 번호가 아직 없으면 맨 뒤.
  function sortBundles(list) {
    return list.slice().sort((a, b) => {
      const na = boxNo(a);
      const nb = boxNo(b);
      return (na === null) - (nb === null) || (na ?? 0) - (nb ?? 0) || cmp(a.batch_key, b.batch_key) || cmp(a.bundle_no, b.bundle_no);
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
.tab-irregular .irr-batch{ display:flex; align-items:center; gap:6px; margin:14px 0 6px; font-size:13px; font-weight:700; color:#475569; word-break:break-all; }
.tab-irregular .irr-batch:first-child{ margin-top:0; }
.tab-irregular .irr-batch-dot{ flex:0 0 auto; width:12px; height:12px; border-radius:50%; background:var(--tone); }
/* 수집 회차별 색: 파랑 → 빨강(코랄) → 노랑(앰버) → 초록 → 보라 */
.tab-irregular .irr-tone-0{ --tone:#3b82f6; }
.tab-irregular .irr-tone-1{ --tone:#f43f5e; }
.tab-irregular .irr-tone-2{ --tone:#f59e0b; }
.tab-irregular .irr-tone-3{ --tone:#10b981; }
.tab-irregular .irr-tone-4{ --tone:#8b5cf6; }
.tab-irregular .irr-head{ display:flex; flex-wrap:nowrap; align-items:center; gap:6px; }
.tab-irregular .irr-head > *{ flex:0 0 auto; white-space:nowrap; }
.tab-irregular .irr-title{
  display:inline-flex; align-items:baseline; gap:5px; padding:5px 12px; border-radius:10px;
  background:var(--tone, #3b82f6); color:#fff;
  font-size:22px; font-weight:800; line-height:1.1; letter-spacing:.5px; font-variant-numeric:tabular-nums;
}
.tab-irregular .irr-title small{ font-size:11px; font-weight:700; letter-spacing:1px; opacity:.9; }
.tab-irregular .irr-lines{ margin:8px 0 0; padding:0; list-style:none; }
.tab-irregular .irr-line{ padding:10px 0; border-top:1px solid #e2e8f0; }
.tab-irregular .irr-line-body{ display:flex; align-items:flex-start; gap:10px; }
.tab-irregular .irr-info{ flex:1 1 auto; min-width:0; }
.tab-irregular .irr-side{ flex:0 0 auto; display:flex; flex-direction:column; align-items:stretch; gap:6px; width:88px; }
.tab-irregular .irr-side .irr-qty{ text-align:right; }
.tab-irregular .irr-reqs{ display:flex; gap:4px; }
.tab-irregular .irr-side .irr-req{ flex:1 1 0; min-width:0; min-height:32px; padding:0 2px; font-size:12px; white-space:nowrap; }
.tab-irregular .irr-bundle-actions{ padding-top:10px; border-top:1px solid #e2e8f0; }
.tab-irregular .irr-loc{ font-size:20px; font-weight:800; line-height:1.25; color:#0f172a; word-break:break-all; }
.tab-irregular .irr-name{ appearance:none; display:block; width:100%; min-height:32px; padding:4px 0; border:0; background:none; font-family:inherit; text-align:left; cursor:pointer; }
.tab-irregular .irr-head .irr-fold{ margin-left:auto; min-height:34px; padding:0 10px; font-size:13px; }
.tab-irregular .irr-more{ padding:10px 0; border-top:1px solid #e2e8f0; }
.tab-irregular .irr-more-btn{ appearance:none; display:flex; align-items:baseline; gap:10px; width:100%; min-height:36px; padding:0; border:0; background:none; font-family:inherit; text-align:left; cursor:pointer; }
.tab-irregular .irr-more-loc{ font-size:20px; font-weight:800; line-height:1.25; color:#0f172a; word-break:break-all; }
.tab-irregular .irr-more-rest{ flex:0 0 auto; font-size:14px; font-weight:700; color:#64748b; white-space:nowrap; }
.tab-irregular .irr-qty{ font-size:20px; font-weight:800; color:#0f172a; white-space:nowrap; }
.tab-irregular .wl-row.is-done{ opacity:1; }
.tab-irregular .wl-row{ display:block; }
.tab-irregular .wl-row.is-done .irr-head, .tab-irregular .wl-row.is-done .irr-lines{ opacity:.55; }
.tab-irregular .btn-sm, .tab-irregular .btn-primary, .tab-irregular .btn-ghost{ min-height:40px; }
.tab-irregular .seg > button{ min-height:40px; }
.tab-irregular .irr-filter{ flex:1 1 260px; }
.tab-irregular .irr-status{ flex:1 1 220px; display:flex; }
.tab-irregular .irr-status > button{ font-size:14px; }
.tab-irregular .irr-status > button.is-active[data-value="대기"]{ background:#64748b; }
.tab-irregular .irr-status > button.is-active[data-value="작업중"]{ background:#d97706; }
.tab-irregular .irr-status > button.is-active[data-value="포장완료"]{ background:#16a34a; }
.tab-irregular .irr-req.is-requested{ background:#e0f2fe; border-color:#7dd3fc; color:#075985; }
.tab-irregular .irr-note{ display:flex; margin-top:8px; flex-wrap:wrap; align-items:center; gap:8px; padding-top:8px; border-top:1px dashed #e2e8f0; }
.tab-irregular .irr-note[hidden]{ display:none; }
.tab-irregular .irr-note label{ flex:1 0 100%; font-size:12px; font-weight:600; color:#475569; }
.tab-irregular .irr-note input{ flex:1 1 160px; min-width:0; height:40px; padding:0 10px; border:1px solid #cbd5e1; border-radius:10px; background:#fff; color:#0f172a; font:inherit; font-size:16px; }
.tab-irregular .irr-note input:focus{ outline:none; border-color:#38bdf8; box-shadow:0 0 0 3px rgba(56,189,248,.25); }
.tab-irregular .irr-error{ text-align:center; }
`;
    document.head.append(style);
  }

  /* ---------- html builders ---------- */
  function headHtml(b) {
    const status = STATUSES.includes(b.status) ? b.status : '대기';
    const changed = b.status_changed_at || b.status_changed_by_name
      ? `<div class="wl-meta">상태 변경: ${esc(b.status_changed_by_name || '-')}${b.status_changed_at ? ' · ' + esc(UI.fmtDateTime(b.status_changed_at)) : ''}</div>`
      : '';
    const folded = isFolded(b);
    const fold = canFold(b)
      ? `<button type="button" class="btn-sm irr-fold" data-act="fold" aria-expanded="${folded ? 'false' : 'true'}" aria-label="${folded ? '펼치기' : '접기'}" title="${folded ? '펼치기' : '접기'}">${folded ? '펼치기 ▾' : '접기 ▴'}</button>`
      : '';
    // 번호 · 상태 · 접기 버튼은 항상 한 줄에 둔다. 길어질 수 있는 '제외됨' 표시는 아랫줄로 내린다.
    return `
      <div class="irr-head">
        <span class="irr-title irr-tone-${batchTone(b)}" title="묶음 ${esc(String(b.bundle_no ?? '').trim() || '-')}"><small>NO.</small>${esc(bundleLabel(b))}</span>
        ${UI.chip(status, STATUS_TONE[status])}
        ${fold}
      </div>
      ${b.stale ? `<div class="wl-meta">${UI.chip('주문서에서 제외됨', 'danger')}</div>` : ''}
      ${changed}`;
  }

  function statusHtml(b) {
    return STATUSES.map(s =>
      `<button type="button" data-act="status" data-value="${esc(s)}"${b.status === s ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${esc(s)}</button>`
    ).join('');
  }

  function reqHtml(line) {
    const open = line.open_requests || {};
    return Object.keys(REQUESTS).map(kind => {
      const r = REQUESTS[kind];
      const on = !!open[r.key];
      const title = on ? `${r.label}됨` : r.label;
      // 요청된 상태는 색으로 구분한다.
      return `<button type="button" class="btn-sm irr-req${on ? ' is-requested' : ''}" data-act="req" data-kind="${kind}" title="${title}" aria-label="${title}">${r.short}</button>`;
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

  function lineHtml(b, line) {
    const note = state.note && String(state.note.id) === String(b.id) && String(state.note.line) === String(line.id) ? state.note : null;
    return `
      <li class="irr-line" data-line="${esc(line.id)}">
        <div class="irr-line-body">
          <div class="irr-info">
            <div class="irr-loc">${esc(locText(line.location_code))}</div>
            <button type="button" class="wl-name irr-name" data-act="open-item" title="상품검색에서 보기">${esc(line.item_name || line.item_code)}</button>
            <div class="wl-meta"><span>재고 ${esc(UI.num(line.stock_today))}</span> ${UI.rackChips(line.racks)}</div>
          </div>
          <div class="irr-side">
            <div class="irr-qty">${esc(UI.num(line.qty))}개</div>
            <div class="irr-reqs">${reqHtml(line)}</div>
          </div>
        </div>
        <div class="irr-note"${note ? '' : ' hidden'}>${note ? noteHtml(note) : ''}</div>
      </li>`;
  }

  function linesHtml(b) {
    const lines = linesOf(b);
    if (!isFolded(b)) return lines.map(line => lineHtml(b, line)).join('');
    // 접힌 묶음: 첫 로케이션과 나머지 종 수만 한 줄로 보여 준다(단품 묶음처럼 보이지 않게). 누르면 펼쳐진다.
    return `<li class="irr-more"><button type="button" class="irr-more-btn" data-act="fold" title="펼치기">
        <span class="irr-more-loc">${esc(locText(lines[0].location_code))}</span>
        <span class="irr-more-rest">그 외 ${esc(UI.num(lines.length - 1))}종</span>
      </button></li>`;
  }

  function rowHtml(b) {
    return `
      <li class="wl-row${b.status === '포장완료' ? ' is-done' : ''}${isFolded(b) ? ' is-folded' : ''}" data-id="${esc(b.id)}">
        <div data-part="head">${headHtml(b)}</div>
        <ul class="irr-lines" data-part="lines">${linesHtml(b)}</ul>
        <div class="wl-actions irr-bundle-actions">
          <div class="seg irr-status" data-part="status" role="group" aria-label="묶음 작업 상태">${statusHtml(b)}</div>
        </div>
      </li>`;
  }

  /* ---------- render ---------- */
  function renderSummary() {
    const el = state.els.summary;
    if (!el) return;
    if (!state.loaded || !state.bundles.length) { el.hidden = true; el.innerHTML = ''; return; }
    const count = { '대기': 0, '작업중': 0, '포장완료': 0 };
    for (const b of state.bundles) {
      if (count[b.status] !== undefined) count[b.status] += 1;
    }
    el.hidden = false;
    el.innerHTML =
      `총 <b>${esc(UI.num(state.bundles.length))}</b>묶음 · ` +
      `대기 <b>${count['대기']}</b> / 작업중 <b>${count['작업중']}</b> / 포장완료 <b>${count['포장완료']}</b>`;
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
    if (!state.bundles.length) return `<p class="empty">${esc(EMPTY_TEXT)}</p>`;

    const shown = state.filter === 'all' ? state.bundles : state.bundles.filter(b => b.status === state.filter);
    if (!shown.length) return `<p class="empty">'${esc(state.filter)}' 상태인 묶음이 없습니다.</p>`;

    // 주문서(수집 회차)가 여러 개면 번호가 앞선 주문서부터 나눠 보여 준다. 번호 표시 색도 주문서마다 다르다.
    const batches = batchKeys();
    if (batches.length <= 1) {
      return `<ul class="wl-list">${sortBundles(shown).map(rowHtml).join('')}</ul>`;
    }
    return batches.map((key, i) => {
      const rows = sortBundles(shown.filter(b => String(b.batch_key ?? '') === key));
      if (!rows.length) return '';
      return `<h3 class="irr-batch"><span class="irr-batch-dot irr-tone-${i % BATCH_TONES}" aria-hidden="true"></span>${esc(key || '(주문서 이름 없음)')} · ${rows.length}묶음</h3>
        <ul class="wl-list">${rows.map(rowHtml).join('')}</ul>`;
    }).join('');
  }

  // 목록 전체를 다시 그린다. 입력 중이던 메모는 가능한 한 되살린다.
  function renderList() {
    const body = state.els.body;
    if (!body) return;
    const active = document.activeElement;
    const noteFocused = !!(active && body.contains(active) && active.matches('input[data-role="note"]'));
    const prevNote = noteInput();
    if (state.note && prevNote) state.note.text = prevNote.value;

    body.innerHTML = listHtml();

    if (state.note && !noteInput()) state.note = null;
    if (noteFocused) {
      const input = noteInput();
      if (input) { try { input.focus({ preventScroll: true }); } catch (_) {} }
    }
  }

  function renderAll() {
    renderFilter();
    renderSummary();
    renderList();
  }

  // 한 묶음만 제자리에서 갱신한다.
  function patchRow(b) {
    const li = rowEl(b.id);
    if (!li) return;
    const prevNote = li.querySelector('input[data-role="note"]');
    if (state.note && prevNote) state.note.text = prevNote.value;
    li.classList.toggle('is-done', b.status === '포장완료');
    li.classList.toggle('is-folded', isFolded(b));
    const set = (part, html) => {
      const el = li.querySelector(`[data-part="${part}"]`);
      if (el) el.innerHTML = html;
    };
    set('head', headHtml(b));
    set('lines', linesHtml(b));
    set('status', statusHtml(b));
  }

  // 메모칸이 열리거나 닫힌 묶음의 상품 줄을 다시 그린다.
  function renderNote(prevId) {
    const ids = new Set([prevId, state.note && state.note.id].filter(v => v !== null && v !== undefined).map(String));
    for (const id of ids) {
      const b = findBundle(id);
      const li = rowEl(id);
      const el = li && li.querySelector('[data-part="lines"]');
      if (b && el) el.innerHTML = linesHtml(b);
    }
    const input = noteInput();
    if (input) { try { input.focus({ preventScroll: true }); } catch (_) {} }
  }

  /* ---------- data ---------- */
  async function load() {
    const seq = ++state.seq;
    const date = state.date;
    if (!state.loaded) { state.error = ''; renderAll(); }
    try {
      const res = await UI.api.get('/irregular_items', { date });
      if (seq !== state.seq) return;
      state.bundles = Array.isArray(res && res.bundles) ? res.bundles : [];
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
    state.bundles = [];
    state.loaded = false;
    state.error = '';
    state.note = null;
  }

  // 서버가 돌려준 묶음으로 교체(없으면 보낸 값만 반영)하고 그 카드·요약·뱃지를 갱신한다.
  function applyBundle(id, serverBundle, fallback) {
    const idx = state.bundles.findIndex(b => String(b.id) === String(id));
    if (idx < 0) return;
    const merged = Object.assign({}, state.bundles[idx], serverBundle && typeof serverBundle === 'object' ? serverBundle : fallback);
    state.bundles[idx] = merged;
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
    const b = findBundle(id);
    if (!b || !STATUSES.includes(value) || b.status === value) return;
    await UI.busy(btn, async () => {
      const res = await postInOrder('/irregular_items/update', { id: b.id, status: value });
      applyBundle(id, res && res.bundle, { status: value });
    });
  }

  function toggleNote(id, lineId, kind) {
    const b = findBundle(id);
    if (!REQUESTS[kind] || !b || !findLine(b, lineId)) return;
    const prevId = state.note ? state.note.id : null;
    const same = state.note && String(state.note.id) === String(id)
      && String(state.note.line) === String(lineId) && state.note.kind === kind;
    state.note = same ? null : { id, line: lineId, kind, text: '' };
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
    const b = findBundle(note.id);
    const line = b && findLine(b, note.line);
    const r = REQUESTS[note.kind];
    if (!line || !r) { closeNote(); return; }
    const input = noteInput();
    const text = input ? input.value.trim() : '';
    await UI.busy(btn, async () => {
      const res = await UI.api.post(r.path, {
        item_code: line.item_code,
        source: 'irregular',
        note: text || undefined,
      });
      if (res && res.created === false) UI.toast('이미 요청된 상품입니다 (요청 내용 추가됨)', 'info');
      else UI.toast(r.okMsg, 'ok');
      if (state.note === note) state.note = null;
      // 같은 상품이 다른 묶음에도 있으면 그 줄들도 '요청됨'으로 바꾼다.
      for (const other of state.bundles) {
        let touched = false;
        for (const l of linesOf(other)) {
          if (l.item_code !== line.item_code) continue;
          l.open_requests = Object.assign({}, l.open_requests, { [r.key]: true });
          touched = true;
        }
        if (touched) patchRow(other);
      }
      Shell.refreshBadges();
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
    if (act === 'fold') {
      const b = findBundle(id);
      if (!b) return;
      if (isFolded(b)) state.open.add(String(id)); else state.open.delete(String(id));
      patchRow(b);
    } else if (act === 'open-item') {
      const b = findBundle(id);
      const line = b && findLine(b, lineIdOf(btn));
      if (line) Shell.show('items', { code: line.item_code });
    } else if (act === 'status') {
      setStatus(btn, id, btn.dataset.value);
    } else if (act === 'req') {
      toggleNote(id, lineIdOf(btn), btn.dataset.kind);
    } else if (act === 'note-submit') {
      submitNote(btn);
    } else if (act === 'note-cancel') {
      closeNote();
    }
  }

  function onKeyDown(ev) {
    const input = ev.target;
    if (!input || !input.matches || ev.isComposing) return;
    if (input.matches('input[data-role="note"]')) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const line = input.closest('.irr-line');
        submitNote(line && line.querySelector('[data-act="note-submit"]'));
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

  // 다른 곳에서 바뀐 내용 반영. 요청 내용을 적는 중이면 미룬다.
  function onRemoteChange() {
    if (state.note) return false;
    if (state.loaded) load();
    return true;
  }

  Shell.register({ id: 'irregular', label: '이형포장', mount, onShow, onHide() {}, onRemoteChange });
})();
