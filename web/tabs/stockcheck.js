// tabs/stockcheck.js — 재고실사 탭
// 날짜별 재고실사 대상(자동 + 요청)을 보여 주고 일치/불일치를 기록한다. 총 재고(MOPS가 넣는 값)는 바꾸지 않는다.
// 카드의 렉 상자에서는 상품검색 탭처럼 스토리지렉 재고를 바로 출고·입고할 수 있다.
(function () {
  'use strict';

  const STYLE_ID = 'tab-stockcheck-style';
  const CSS = `
.tab-stockcheck .sc-toolbar{ align-items: stretch; }
.tab-stockcheck .sc-toolbar .seg{ flex: 1 1 100%; }
.tab-stockcheck .sc-toolbar .seg > button{ padding: 0 6px; }
.tab-stockcheck .sc-cnt{ margin-left: 3px; font-weight: 500; opacity: .75; }
.tab-stockcheck .sc-toggle[aria-pressed="true"]{ background: #0ea5e9; border-color: #0284c7; color: #fff; }
.tab-stockcheck .sc-q{ flex: 1 1 160px; }
.tab-stockcheck.is-open-mode .sc-datebar,
.tab-stockcheck.is-open-mode .sc-seg-status{ display: none; }
.tab-stockcheck .sc-summary{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-stockcheck .sc-row--req{ border-left: 4px solid #0ea5e9; }
.tab-stockcheck .sc-row--mismatch{ border-left: 4px solid #ef4444; }
.tab-stockcheck .sc-row--match{ border-left: 4px solid #22c55e; }
.tab-stockcheck .sc-top{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tab-stockcheck .sc-loc{ margin-right: 2px; font-size: 16px; font-weight: 800; color: #0f172a; }
.tab-stockcheck .sc-name{
  appearance: none; display: block; width: 100%; margin-top: 6px; padding: 0;
  border: 0; background: none; cursor: pointer; text-align: left; font-family: inherit;
}
.tab-stockcheck .sc-stock{ display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-top: 8px; font-size: 13px; color: #64748b; }
.tab-stockcheck .sc-stock__title{ font-weight: 700; color: #334155; }
.tab-stockcheck .sc-stock b{ margin-left: 4px; font-size: 16px; color: #0f172a; }
.tab-stockcheck .sc-racks{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tab-stockcheck .sc-rack{
  appearance: none; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px;
  border: 1px solid #bae6fd; border-radius: 10px; background: #e0f2fe; color: #075985;
  font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.tab-stockcheck .sc-rack b{ font-size: 14px; color: #0369a1; }
.tab-stockcheck .sc-rack.is-active{ background: #0ea5e9; border-color: #0284c7; color: #fff; }
.tab-stockcheck .sc-rack.is-active b{ color: #fff; }
.tab-stockcheck .sc-rack-in{ min-height: 36px; }
.tab-stockcheck .sc-rackform{
  margin-top: 8px; padding: 12px;
  border: 1px solid #bae6fd; border-radius: 12px; background: #f0f9ff;
}
.tab-stockcheck .sc-rackform [hidden]{ display: none; }
.tab-stockcheck .sc-rackform .sc-hint{ margin: 0; font-size: 12px; line-height: 1.4; color: #64748b; }
.tab-stockcheck .sc-rack-code{ display: flex; gap: 6px; }
.tab-stockcheck .sc-rack-code input{ flex: 1 1 auto; min-width: 0; }
.tab-stockcheck .sc-rack-code select{ flex: 0 0 auto; width: auto; }
.tab-stockcheck .sc-rackform [data-role="rack-qty"], .tab-stockcheck .sc-rackform [data-role="rack-presence"]{ margin-top: 16px; }
.tab-stockcheck .sc-rackform-btns{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.tab-stockcheck .sc-rackform-btns button{ min-height: 40px; }
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
  .tab-stockcheck .sc-toolbar .seg{ flex: 0 1 auto; }
  .tab-stockcheck .sc-toolbar .seg > button{ padding: 0 12px; }
  .tab-stockcheck .sc-form{ grid-template-columns: 160px minmax(0, 1fr) auto; align-items: end; }
}`;

  const STATUS_OPTS = [['all', '전체'], ['pending', '미확인'], ['match', '일치'], ['mismatch', '불일치']];
  const SOURCE_LABEL = {
    auto_low_stock: ['자동', 'muted'],
    item: ['상품검색 요청', 'info'],
    irregular: ['이형포장 요청', 'info'],
    display: ['진열보충 요청', 'info'],
  };

  const state = {
    root: null,
    bodyEl: null,
    dateBar: null,
    date: '',
    openMode: false,          // 미처리 불일치만 보기(전 날짜). 상품검색 첫 화면의 바로가기로만 켜진다
    items: [],
    index: new Map(),         // String(id) -> row
    loadedKey: null,          // 지금 items가 어느 조회의 결과인지
    phase: 'idle',            // loading | error | ready
    errorMsg: '',
    seq: 0,
    filter: { status: 'pending', hideDisc: false, q: '' },
    sticky: new Set(),        // 이번 화면에서 방금 처리한 행: 필터에 안 맞아도 제자리에 둔다
    form: null,               // {id, kind:'mismatch'|'resolve'}
    rackForm: null,           // 열려 있는 렉 입출고 칸: {id, kind:'out', rack} | {id, kind:'in'}
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
    // 영어(A~Z) 다음에 한글(가나다) 순. 'ko' 규칙은 한글을 앞에 두므로 'en' 규칙으로 비교한다.
    const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
    return rows.slice().sort((a, b) => {
      if (state.openMode) {
        const d = cmp(b.check_date, a.check_date);
        if (d) return d;
      }
      // 로케이션 코드 순(알파벳 → 숫자). 요청 건을 따로 앞세우지 않는다. 위치 미지정은 맨 뒤.
      const na = locText(a.location_code) === '위치 미지정' ? 1 : 0;
      const nb = locText(b.location_code) === '위치 미지정' ? 1 : 0;
      if (na !== nb) return na - nb;
      return cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code);
    });
  }

  /* ---------- filters ---------- */
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
    return passStatus(r) && passDisc(r) && passText(r);
  }

  function updateCounts() {
    const st = { all: 0, pending: 0, match: 0, mismatch: 0 };
    for (const r of state.items) {
      if (!passDisc(r) || !passText(r)) continue;
      st.all++;
      if (st[r.status] !== undefined) st[r.status]++;
    }
    state.root.querySelectorAll('[data-cnt]').forEach(el => {
      const n = st[el.dataset.cnt.split(':')[1]];
      el.textContent = state.phase === 'ready' ? String(n ?? 0) : '';
    });
  }

  function syncToolbar() {
    const root = state.root;
    root.classList.toggle('is-open-mode', state.openMode);
    root.querySelectorAll('[data-act="f-status"]').forEach(b => b.classList.toggle('is-active', b.dataset.val === state.filter.status));
    root.querySelector('[data-act="toggle-disc"]').setAttribute('aria-pressed', String(state.filter.hideDisc));
    updateCounts();
  }

  /* ---------- rendering ---------- */
  function soldoutHtml(r) {
    if (r.in_soldout) return UI.chip('품절처리 등록됨', 'muted');
    const urgent = numOrNull(r.counted_qty) === 0 || numOrNull(r.stock_today) === 0;
    return `<button type="button" class="${urgent ? 'btn-danger' : 'btn-ghost btn-sm'}" data-act="soldout">품절처리에 추가</button>`;
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
      // 관리자가 실사반영 탭에서 내린 판단
      const review = { applied: ['반영', 'ok'], held: ['보류', 'warn'], rejected: ['미반영', 'muted'] }[r.review_status];
      if (r.status === 'mismatch' && review) parts.push(UI.chip(review[0], review[1]));
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

  function rackListOf(r) {
    return (Array.isArray(r && r.racks) ? r.racks : []).filter(x => x && x.rack_code);
  }

  // 상품검색 탭의 재고정보와 같은 표기: SR1은 수량(없으면 '없음'), SR2는 있음/없음.
  function stockInfoHtml(r) {
    const racks = rackListOf(r);
    const rowQty = row => racks
      .filter(x => String(x.rack_code).toUpperCase().startsWith(`${row}-`))
      .reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
    const sr1 = rowQty('SR1');
    const sr3 = rowQty('SR3');
    const sr2 = racks.some(x => UI.isPresenceRack(x.rack_code)) ? '있음' : '없음';
    return `<div class="sc-stock"><span class="sc-stock__title">재고정보</span>
            <span>SR1:<b>${sr1 > 0 ? esc(UI.num(sr1)) : '없음'}</b></span>
            <span>SR2:<b>${esc(sr2)}</b></span>
            ${sr3 > 0 ? `<span>SR3:<b>${esc(UI.num(sr3))}</b></span>` : ''}</div>`;
  }

  // 렉 위치별 수량 상자. 누르면 그 위치에서 출고, '+ 입고'로 입고(상품검색 탭과 같은 동작).
  function racksHtml(r, rackForm) {
    const active = rackForm && rackForm.kind === 'out' ? String(rackForm.rack) : '';
    const buttons = rackListOf(r).map(x => {
      const on = active === String(x.rack_code);
      return `<button type="button" class="sc-rack${on ? ' is-active' : ''}" data-act="rack-out" data-rack="${esc(x.rack_code)}" aria-pressed="${on ? 'true' : 'false'}" title="이 위치에서 출고">${esc(x.rack_code)}<b>${
        UI.isPresenceRack(x.rack_code) ? '있음' : `${esc(UI.num(x.qty))}개`}</b></button>`;
    }).join('');
    return `<div class="sc-racks">${buttons || UI.chip('스토리지렉 재고 없음', 'muted')}
            <button type="button" class="btn-sm sc-rack-in" data-act="rack-in">+ 입고</button></div>`;
  }

  // 입고 칸: 고른 구역이 SR2면 수량 칸을 숨긴다. (렉 코드 입력 규칙은 UI.rackCode — 상품검색 탭과 같다)
  function syncRackForm(form) {
    const presence = UI.isPresenceRack(form.elements.zone.value + '-');
    const qty = form.querySelector('[data-role="rack-qty"]');
    const hint = form.querySelector('[data-role="rack-presence"]');
    if (qty) qty.hidden = presence;
    if (hint) hint.hidden = !presence;
  }

  function rackFormHtml(r, rackForm) {
    const btns = label => `
          <div class="sc-rackform-btns">
            <button type="button" class="btn-ghost" data-act="rack-cancel">취소</button>
            <button type="submit" class="btn-primary">${label}</button>
          </div>`;
    if (rackForm.kind === 'out') {
      const hit = rackListOf(r).find(x => String(x.rack_code) === String(rackForm.rack));
      if (!hit) return '';
      const max = Number(hit.qty) || 0;
      return `
        <form class="sc-rackform" data-kind="out" novalidate>
          ${UI.isPresenceRack(hit.rack_code)
            ? '<p class="sc-hint">SR2는 수량을 세지 않습니다. 이 위치에서 상품을 뺍니다.</p>'
            : `<label class="field"><span>출고 수량</span>
            <input name="qty" type="number" inputmode="numeric" min="1" max="${esc(max)}" step="1" value="${esc(max)}" autocomplete="off" /></label>`}
          ${btns('출고')}
        </form>`;
    }
    return `
        <form class="sc-rackform" data-kind="in" novalidate>
          <div class="field"><span>입고할 위치 (렉 코드)</span>
            <div class="sc-rack-code">
              <select name="zone" aria-label="렉 구역">${UI.rackCode.zones.map(z => `<option value="${z}">${z}</option>`).join('')}</select>
              <input class="sc-rack-code-input" name="rack" type="text" inputmode="numeric" autocomplete="off" placeholder="예: 05-02" aria-label="렉 번호" />
              <button type="button" class="btn-sm" data-scan-for=".sc-rack-code-input" title="사진으로 렉 코드 읽기" aria-label="사진으로 렉 코드 읽기">📷</button>
            </div>
          </div>
          <label class="field" data-role="rack-qty"><span>입고 수량</span>
            <input name="qty" type="number" inputmode="numeric" min="1" step="1" autocomplete="off" /></label>
          <p class="sc-hint" data-role="rack-presence" hidden>SR2는 수량 없이 '있음'으로 저장합니다.</p>
          ${btns('입고')}
        </form>`;
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
    } else if (r.playauto_status === 'sent') {
      // 플레이오토로 보낸 재고는 되돌릴 수 없다(처리취소·수정·다시 확인 모두 막힘).
      out.push(UI.chip('플레이오토 전송 완료', 'ok'));
    } else if (r.resolved) {
      // 실사반영에서 판단이 끝난 건. 판단은 실사반영 탭에서만 바꾼다.
    } else {
      // 불일치는 실사반영 탭에서 관리자가 판단한다(여기서 닫는 '처리완료'는 두지 않는다).
      out.push(`<button type="button" class="btn-ghost btn-sm" data-act="open-mismatch"${formKind === 'mismatch' ? ' disabled' : ''}>수량·사유 수정</button>`);
      out.push('<button type="button" class="btn-ghost btn-sm" data-act="reset">다시 확인</button>');
    }
    // 품절처리 추가는 일치·불일치를 기록한 뒤에만 보인다.
    if (r.status !== 'pending') out.push(soldoutHtml(r));
    return out.join('');
  }

  function rowHtml(r) {
    const id = String(r.id);
    const requested = isRequested(r);
    const formKind = state.form && state.form.id === id ? state.form.kind : null;
    const rackForm = state.rackForm && state.rackForm.id === id ? state.rackForm : null;
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
          <div class="sc-top"><span class="sc-loc">${esc(locText(r.location_code))}</span>${chips.join('')}</div>
          <button type="button" class="wl-name sc-name" data-act="open-item" title="상품검색에서 보기">${esc(r.item_name || r.item_code)}</button>
          ${stockInfoHtml(r)}
          ${racksHtml(r, rackForm)}
          ${rackForm ? rackFormHtml(r, rackForm) : ''}
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
      body.innerHTML = stateHtml(state.openMode ? '미처리 불일치가 없습니다.' : `${state.date} 에는 재고실사 대상이 없습니다.`);
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

  // keep: 다른 곳에서 바뀐 내용을 반영할 때. 방금 처리해 화면에 남겨 둔 줄(sticky)을 지우지 않는다.
  async function load({ keep = false } = {}) {
    const key = currentKey();
    const seq = ++state.seq;
    if (!keep) {
      state.form = null;
      state.rackForm = null;
      state.sticky.clear();
    }
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

  // 일치로 확인한 재고가 기준 미만이면 품절처리에 자동으로 올린다.
  const AUTO_SOLDOUT_BELOW = 10;
  async function autoSoldout(id) {
    const r = state.index.get(String(id));
    if (!r || r.status !== 'match' || r.in_soldout) return;
    if (isDisc(r)) return;   // 단종 상품은 다시 들여오지 않으므로 자동 등록하지 않는다(버튼으로는 직접 추가 가능)
    const qty = numOrNull(r.counted_qty) ?? totalStock(r);
    if (qty === null || qty >= AUTO_SOLDOUT_BELOW) return;
    try {
      const res = await UI.api.post('/soldout_items/add', { item_code: r.item_code, source: 'stock_check', source_id: r.id });
      const cur = state.index.get(String(id));
      if (cur) { cur.in_soldout = true; replaceRow(id); }
      UI.toast(res && res.created === false
        ? `재고 ${UI.num(qty)}개 · 이미 품절처리에 있는 상품입니다`
        : `재고 ${UI.num(qty)}개 · 품절처리에 자동으로 추가했습니다`, 'info');
      Shell.refreshBadges();
    } catch (err) {
      if (!err || err.code !== 'AUTH_REQUIRED') {
        UI.toast(`품절처리 자동 추가 실패: ${(err && err.message) || '요청에 실패했습니다.'}`, 'error');
      }
    }
  }

  function openForm(id, kind) {
    const prev = state.form;
    const prevRack = state.rackForm;
    state.rackForm = null;
    state.form = { id: String(id), kind };
    if (prev && prev.id !== String(id)) replaceRow(prev.id);
    if (prevRack && prevRack.id !== String(id) && !(prev && prev.id === prevRack.id)) replaceRow(prevRack.id);
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

  // 렉 상자(출고) / '+ 입고'를 눌렀을 때. 같은 것을 다시 누르면 닫는다.
  function openRackForm(id, form) {
    id = String(id);
    const cur = state.rackForm;
    const same = cur && cur.id === id && cur.kind === form.kind && String(cur.rack || '') === String(form.rack || '');
    const stale = new Set([cur && cur.id, state.form && state.form.id].filter(v => v && v !== id));
    state.form = null;
    state.rackForm = same ? null : { id, ...form };
    stale.forEach(replaceRow);
    const el = replaceRow(id);
    const input = el && state.rackForm && el.querySelector(form.kind === 'in' ? '.sc-rack-code-input' : '.sc-rackform input[name="qty"]');
    if (input) {
      try {
        input.focus();
        if (form.kind === 'out' && input.select) input.select();
        input.scrollIntoView({ block: 'center' });
      } catch (_) {}
    }
  }
  function closeRackForm() {
    const prev = state.rackForm;
    state.rackForm = null;
    if (prev) replaceRow(prev.id);
  }

  // 스토리지렉 재고가 바뀌었으면 창고네비도 최신으로 맞춘다(실패해도 이 탭에는 영향 없음).
  function refreshMap() {
    try {
      if (typeof loadCells === 'function') Promise.resolve(loadCells()).catch(() => {});
      if (typeof loadMovements === 'function') Promise.resolve(loadMovements()).catch(() => {});
    } catch (_) {}
  }

  async function sendRack(form, r) {
    const kind = form.dataset.kind;
    const id = String(r.id);
    let rack;
    let qty;
    if (kind === 'out') {
      const hit = rackListOf(r).find(x => String(x.rack_code) === String(state.rackForm && state.rackForm.rack));
      if (!hit) { UI.toast('이 위치에 재고가 없습니다', 'error'); return; }
      rack = String(hit.rack_code);
      const max = Number(hit.qty) || 0;
      if (UI.isPresenceRack(rack)) qty = max;   // SR2는 통째로 뺀다
      else {
        qty = Number(String(form.elements.qty.value).trim());
        if (!Number.isInteger(qty) || qty < 1 || qty > max) {
          UI.toast(`출고 수량을 1~${UI.num(max)} 사이로 입력해 주세요`, 'error');
          form.elements.qty.focus();
          return;
        }
      }
    } else {
      rack = UI.rackCode.read(form);
      if (!rack) {
        UI.toast('입고할 위치(렉 코드)를 끝까지 입력해 주세요 (예: 05-02)', 'error');
        form.elements.rack.focus();
        return;
      }
      if (UI.isPresenceRack(rack)) qty = 1;     // SR2는 '있음'으로만 남긴다
      else {
        qty = Number(String(form.elements.qty.value).trim());
        if (!Number.isInteger(qty) || qty < 1) {
          UI.toast('입고 수량을 1 이상의 숫자로 입력해 주세요', 'error');
          form.elements.qty.focus();
          return;
        }
      }
    }
    const res = await UI.busy(form.querySelector('button[type="submit"]'), async () => {
      await UI.api.post(kind === 'out' ? '/outbound' : '/inbound', { rack_code: rack, item_code: r.item_code, qty });
      return true;
    });
    if (res === undefined) return;
    const amount = UI.isPresenceRack(rack) ? '' : ` ${UI.num(qty)}개`;
    UI.toast(kind === 'out' ? `${rack}에서${amount} 출고했습니다` : `${rack}에${amount} 입고했습니다`, 'ok');
    refreshMap();
    if (state.rackForm && state.rackForm.id === id) state.rackForm = null;
    state.sticky.add(id);              // 다시 불러와도 이 줄은 제자리에 둔다
    await load({ keep: true });
  }

  function changeFilter(mutate) {
    mutate();
    state.sticky.clear();
    state.form = null;
    state.rackForm = null;
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
      case 'toggle-disc': changeFilter(() => { state.filter.hideDisc = !state.filter.hideDisc; }); return;
      case 'retry': load(); return;
      case 'reset-filters': {
        const q = state.root.querySelector('.sc-q');
        if (q) q.value = '';
        changeFilter(() => { state.filter = { status: 'all', hideDisc: false, q: '' }; });
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
      case 'rack-out': openRackForm(id, { kind: 'out', rack: btn.dataset.rack }); return;
      case 'rack-in': openRackForm(id, { kind: 'in' }); return;
      case 'rack-cancel': closeRackForm(); return;
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
        UI.toast(res && res.created === false ? '이미 품절처리에 있는 상품입니다' : '품절처리에 추가했습니다', res && res.created === false ? 'info' : 'ok');
        const cur = state.index.get(id);
        if (cur) { cur.in_soldout = true; replaceRow(id); }
        Shell.refreshBadges();
        return;
      }
      default:
    }
  }

  async function onSubmit(ev) {
    const rackFormEl = ev.target.closest('form.sc-rackform');
    if (rackFormEl) {
      ev.preventDefault();
      const rli = rackFormEl.closest('li.wl-row');
      const row = rli && state.index.get(rli.dataset.id);
      if (row) await sendRack(rackFormEl, row);
      return;
    }
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
    if (ev.target.classList && ev.target.classList.contains('sc-rack-code-input')) {   // 직접 입력했거나 사진으로 읽은 렉 코드
      const form = ev.target.closest('form');
      if (form) { UI.rackCode.apply(form, ev.target.value); syncRackForm(form); }
      return;
    }
    if (!ev.target.classList || !ev.target.classList.contains('sc-q')) return;
    const value = ev.target.value;
    clearTimeout(state.qTimer);
    state.qTimer = setTimeout(() => {
      const q = String(value).trim().toLowerCase();
      if (q === state.filter.q) return;
      changeFilter(() => { state.filter.q = q; });
    }, 150);
  }

  function onChange(ev) {
    const form = ev.target.name === 'zone' && ev.target.closest('form.sc-rackform');
    if (form) { syncRackForm(form); form.elements.rack.focus(); }
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
      <div class="view-head"><h2>재고실사</h2><div class="sc-datebar"></div></div>
      <div class="view-toolbar sc-toolbar">
        ${segHtml('status', 'f-status', STATUS_OPTS)}
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
    root.addEventListener('change', onChange);
    syncToolbar();
  }

  function onShow(params) {
    const p = params || {};
    if (isYmd(p.date)) {
      state.date = p.date;
      state.dateBar.set(p.date);
      state.openMode = false;
    } else {
      // 상품검색 첫 화면의 '불일치 미처리' 바로가기로 들어왔을 때만 켠다. 탭을 다시 누르면 평소 화면으로 돌아온다.
      state.openMode = String(p.open) === '1';
    }
    syncToolbar();
    load();
  }

  function onHide() {
    clearTimeout(state.qTimer);
    state.seq++;                 // 진행 중이던 조회 결과는 버린다
    if (state.phase === 'loading') state.phase = 'idle';
  }

  // 다른 곳에서 바뀐 내용 반영. 불일치·처리 내용을 적는 중이면 미룬다.
  function onRemoteChange() {
    if (state.form || state.rackForm) return false;
    if (state.phase === 'ready') load({ keep: true });
    return true;
  }

  Shell.register({ id: 'stockcheck', label: '재고실사', mount, onShow, onHide, onRemoteChange });
})();
