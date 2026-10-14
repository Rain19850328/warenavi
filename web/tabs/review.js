// tabs/review.js — 실사반영 탭(관리자 전용)
// 재고실사에서 불일치로 기록된 건을 날짜별로 보여 주고, 관리자가 반영 / 보류 / 미반영을 판단한다(품절처리 탭과 같은 배치).
// 반영하면 서버가 실재고를 플레이오토로 보낸다. 못 보낸 건은 '전송 대기 / 실패'로 남아 다시 보낼 수 있다.
(function () {
  'use strict';

  const STYLE_ID = 'tab-review-style';
  const CSS = `
.tab-review .rv-toolbar .seg{ flex: 1 1 100%; }
.tab-review .rv-cnt{ margin-left: 3px; font-weight: 500; opacity: .75; }
.tab-review .rv-summary{ margin: 0 0 10px; padding: 8px 10px; border-radius: 10px; background: #f1f5f9; font-size: 13px; line-height: 1.6; color: #334155; }
.tab-review .seg > button{ min-height: 40px; padding: 0 4px; }
.tab-review .wl-row.is-done{ opacity: 1; }
.tab-review .wl-row.is-done .wl-main{ opacity: .55; }
.tab-review .wl-actions{ padding-top: 8px; border-top: 1px dashed #e2e8f0; }
.tab-review .wl-actions:empty{ display: none; }
.tab-review .rv-top{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tab-review .rv-loc{ margin-right: 2px; font-size: 16px; font-weight: 800; color: #0f172a; }
.tab-review .rv-name{
  appearance: none; display: block; width: 100%; margin-top: 6px; padding: 0;
  border: 0; background: none; cursor: pointer; text-align: left; font-family: inherit;
}
.tab-review .rv-top .rv-state-chip{ margin-left: auto; }
.tab-review .rv-compare{
  display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 6px;
  margin-top: 10px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc;
}
.tab-review .rv-compare__box{ display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; line-height: 1.1; }
.tab-review .rv-compare__label{ font-size: 12px; font-weight: 700; color: #64748b; }
.tab-review .rv-compare__num{ font-size: 30px; font-weight: 800; color: #0f172a; }
.tab-review .rv-compare__num--db{ color: #64748b; }
.tab-review .rv-compare__sign{ font-size: 18px; font-weight: 700; color: #94a3b8; }
.tab-review .rv-compare__num.rv-diff--zero{ color: #94a3b8; }

.tab-review .rv-diff--minus{ color: #b91c1c; }
.tab-review .rv-diff--plus{ color: #1d4ed8; }
.tab-review .rv-sub{ margin-top: 4px; font-size: 12px; color: #64748b; }
.tab-review .rv-note{
  margin-top: 6px; padding: 6px 8px; border-radius: 8px;
  background: #f1f5f9; font-size: 13px; line-height: 1.4; color: #334155; word-break: break-word;
}
.tab-review .rv-note--reason{ background: #fef2f2; color: #991b1b; }
.tab-review .rv-apply{
  margin-top: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid #bae6fd;
  background: #f0f9ff; font-size: 14px; font-weight: 600; line-height: 1.4; color: #075985;
}
.tab-review .rv-apply b{ font-size: 16px; font-weight: 800; color: #0f172a; }
.tab-review .rv-apply--done{ border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
.tab-review .rv-memo{ flex: 1 0 100%; min-width: 0; }
.tab-review .rv-memo input{ width: 100%; box-sizing: border-box; }
.tab-review .wl-actions .rv-act{ flex: 1 1 88px; min-height: 44px; font-size: 15px; }
.tab-review .rv-state{ display: grid; justify-items: center; gap: 4px; padding-bottom: 20px; }
@media (min-width: 640px){
  .tab-review .rv-toolbar .seg{ flex: 0 1 auto; }
}`;

  const FILTERS = [['all', '전체'], ['wait', '대기'], ['held', '보류'], ['done', '반영'], ['rejected', '미반영']];
  const DECISIONS = {
    applied: { label: '반영', tone: 'ok' },
    held: { label: '보류', tone: 'warn' },
    rejected: { label: '미반영', tone: 'muted' },
  };
  const PLAYAUTO = {
    pending: ['플레이오토 전송 대기', 'warn'],
    sent: ['플레이오토 전송 완료', 'ok'],
    failed: ['플레이오토 전송 실패', 'danger'],
  };

  const state = {
    root: null,
    bodyEl: null,
    dateBar: null,
    date: '',              // '' = 날짜 전체(기본), 'YYYY-MM-DD' = 그 날짜만
    filter: 'all',
    items: [],
    index: new Map(),      // String(id) -> row
    loadedDate: null,      // 지금 items가 어느 날짜의 결과인지
    phase: 'idle',         // loading | error | ready
    errorMsg: '',
    seq: 0,
    sticky: new Set(),     // 방금 판단한 줄: 목록 조건에서 벗어나도 제자리에 둔다
    memos: new Map(),      // String(id) -> 입력 중인 메모
  };

  const esc = v => UI.esc(v);

  function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function locText(code) {
    const s = String(code ?? '').trim();
    return !s || s === '00' ? '위치 미지정' : s;
  }
  // 판단 기준이 되는 DB 재고: 지금 재고를 쓰고, 없으면 확인 당시 값.
  function dbStock(r) {
    return numOrNull(r.stock_today) ?? numOrNull(r.db_stock);
  }
  function isDecided(r) { return r.review_status === 'applied' || r.review_status === 'rejected'; }
  // 재고실사 탭과 같은 순서: 로케이션 코드 영어(A~Z) → 한글(가나다), 숫자는 크기순, 위치 미지정은 맨 뒤.
  function sortRows(rows) {
    const cmp = (x, y) => String(x ?? '').localeCompare(String(y ?? ''), 'en', { numeric: true });
    const none = r => (locText(r.location_code) === '위치 미지정' ? 1 : 0);
    return rows.slice().sort((x, y) =>
      none(x) - none(y) || cmp(x.location_code, y.location_code) || cmp(x.item_code, y.item_code)
      || cmp(x.check_date, y.check_date));
  }
  // 줄이 어느 탭에 속하는지: 대기(wait) | 보류(held) | 반영(done) | 미반영(rejected)
  function bucketOf(r) {
    if (r.review_status === 'applied') return 'done';
    if (r.review_status === 'rejected') return 'rejected';
    return r.review_status === 'held' ? 'held' : 'wait';
  }
  function bucketCounts() {
    const c = { all: state.items.length, wait: 0, held: 0, done: 0, rejected: 0 };
    for (const r of state.items) c[bucketOf(r)]++;
    return c;
  }
  function isVisible(r) {
    if (state.filter === 'all' || state.sticky.has(String(r.id))) return true;
    return bucketOf(r) === state.filter;
  }

  /* ---------- rendering ---------- */
  // 이 탭의 중심: DB재고와 실제로 센 실재고, 그 차이. 반영하면 DB재고를 실재고 값으로 맞춘다.
  function compareHtml(r) {
    const db = dbStock(r);
    const counted = numOrNull(r.counted_qty);
    const d = db !== null && counted !== null ? counted - db : null;
    const diffCls = d === null || d === 0 ? 'rv-diff--zero' : d < 0 ? 'rv-diff--minus' : 'rv-diff--plus';
    const diffText = d === null ? '-' : `${d > 0 ? '+' : ''}${UI.num(d)}`;
    const atCheck = numOrNull(r.db_stock);
    const sub = atCheck !== null && db !== null && atCheck !== db
      ? `<div class="rv-sub">불일치를 기록할 때의 DB재고는 ${esc(UI.num(atCheck))}개였습니다.</div>` : '';
    const done = r.review_status === 'applied';
    const apply = r.review_status === 'rejected' || db === null || counted === null ? ''
      : `<div class="rv-apply${done ? ' rv-apply--done' : ''}">DB재고 <b>${esc(UI.num(done ? (atCheck ?? db) : db))}</b> &gt;&gt; 실재고 <b>${esc(UI.num(counted))}</b> ${done ? '반영했습니다.' : '반영한다.'}</div>`;
    return `
          <div class="rv-compare">
            <div class="rv-compare__box"><span class="rv-compare__label">DB재고</span><span class="rv-compare__num rv-compare__num--db">${esc(UI.num(db))}</span></div>
            <span class="rv-compare__sign" aria-hidden="true">→</span>
            <div class="rv-compare__box"><span class="rv-compare__label">실재고</span><span class="rv-compare__num">${esc(UI.num(counted))}</span></div>
            <span class="rv-compare__sign" aria-hidden="true">=</span>
            <div class="rv-compare__box"><span class="rv-compare__label">차이</span><span class="rv-compare__num ${diffCls}">${esc(diffText)}</span></div>
          </div>
          ${sub}${apply}`;
  }

  function actionsHtml(r) {
    const id = String(r.id);
    if (isDecided(r)) {
      if (r.playauto_status === 'sent') return '';   // 플레이오토에 들어간 재고는 여기서 되돌릴 수 없다
      const resend = r.review_status === 'applied'
        ? '<button type="button" class="btn-primary" data-act="send">플레이오토 다시 전송</button>'
        : '';
      return `${resend}<button type="button" class="btn-ghost btn-sm" data-act="decide" data-val="pending">판단 취소</button>`;
    }
    const held = r.review_status === 'held';
    return `
      <label class="field rv-memo"><span>메모 (선택)</span>
        <input type="text" data-role="memo" maxlength="200" autocomplete="off" placeholder="예: 파손 폐기, 재실사 예정"
               value="${esc(state.memos.has(id) ? state.memos.get(id) : (r.review_note || ''))}" /></label>
      <button type="button" class="btn-primary rv-act" data-act="decide" data-val="applied">반영</button>
      <button type="button" class="${held ? 'btn-ghost' : 'btn-sm'} rv-act" data-act="decide" data-val="${held ? 'pending' : 'held'}">${held ? '보류 해제' : '보류'}</button>
      <button type="button" class="btn-danger rv-act" data-act="decide" data-val="rejected">미반영</button>`;
  }

  function rowHtml(r) {
    const id = String(r.id);
    const decision = DECISIONS[r.review_status];
    const cls = ['wl-row'];
    if (isDecided(r)) cls.push('is-done');

    const chips = [];
    const pa = PLAYAUTO[r.playauto_status];
    if (pa) chips.push(UI.chip(pa[0], pa[1]));
    const stateChip = `<span class="rv-state-chip">${decision ? UI.chip(decision.label, decision.tone) : UI.chip('대기', 'warn')}</span>`;

    const notes = [];
    if (r.mismatch_reason) notes.push(`<div class="rv-note rv-note--reason">사유: ${esc(r.mismatch_reason)}</div>`);
    if (r.request_note) notes.push(`<div class="rv-note">요청 메모: ${esc(r.request_note)}</div>`);
    if (decision) {
      const who = [r.reviewed_by_name, UI.fmtDateTime(r.reviewed_at)].filter(Boolean).join(' · ');
      const text = [decision.label, who, isDecided(r) ? r.review_note : ''].filter(Boolean).join(' — ');
      notes.push(`<div class="rv-note">${esc(text)}</div>`);
    }
    if (r.playauto_status && r.playauto_message) {
      notes.push(`<div class="rv-note${r.playauto_status === 'sent' ? '' : ' rv-note--reason'}">플레이오토: ${esc(r.playauto_message)}</div>`);
    }
    const checked = [r.checked_by_name, UI.fmtDateTime(r.checked_at)].filter(Boolean).join(' · ');

    return `
      <li class="${cls.join(' ')}" data-id="${esc(id)}">
        <div class="wl-main">
          <div class="rv-top"><span class="rv-loc">${esc(locText(r.location_code))}</span>${chips.join('')}${stateChip}</div>
          <button type="button" class="wl-name rv-name" data-act="open-item" title="상품검색에서 보기">${esc(r.item_name || r.item_code)}</button>
          ${compareHtml(r)}
          ${notes.join('')}
          ${checked ? `<div class="wl-meta">불일치 기록: ${esc(checked)}</div>` : ''}
        </div>
        <div class="wl-actions">${actionsHtml(r)}</div>
      </li>`;
  }

  function summaryHtml() {
    const c = bucketCounts();
    return `총 <b>${esc(UI.num(c.all))}</b>건 · 대기 <b>${esc(UI.num(c.wait))}</b> · 보류 <b>${esc(UI.num(c.held))}</b> · 반영 <b>${esc(UI.num(c.done))}</b> · 미반영 <b>${esc(UI.num(c.rejected))}</b>`;
  }

  function stateHtml(text, sub, btnAct, btnLabel) {
    return `<div class="rv-state"><p class="empty">${esc(text)}${sub ? `<br><small>${esc(sub)}</small>` : ''}</p>${
      btnAct ? `<button type="button" class="btn-ghost" data-act="${btnAct}">${esc(btnLabel)}</button>` : ''}</div>`;
  }

  function renderBody() {
    const body = state.bodyEl;
    if (state.phase === 'loading') { body.innerHTML = stateHtml('불러오는 중…'); return; }
    if (state.phase === 'error') { body.innerHTML = stateHtml('불러오지 못했습니다', state.errorMsg, 'retry', '다시 시도'); return; }
    if (state.phase !== 'ready') { body.innerHTML = ''; return; }
    if (!state.items.length) {
      body.innerHTML = stateHtml(state.date ? `${state.date} 에는 불일치로 기록된 건이 없습니다.` : '불일치로 기록된 건이 없습니다.');
      return;
    }
    const summary = summaryHtml();
    const rows = sortRows(state.items.filter(isVisible));
    body.innerHTML =
      `<p class="rv-summary">${summary}</p>` +
      (rows.length
        ? `<ul class="wl-list">${rows.map(rowHtml).join('')}</ul>`
        : '<p class="empty">해당하는 건이 없습니다.</p>');
  }

  function syncToolbar() {
    state.root.querySelectorAll('[data-act="filter"]').forEach(b => {
      const on = b.dataset.val === state.filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const counts = bucketCounts();
    // 한 줄만 다시 그린 뒤에도(판단 직후) 요약 줄이 맞도록 함께 고친다.
    const summaryEl = state.bodyEl && state.bodyEl.querySelector('.rv-summary');
    if (summaryEl) summaryEl.innerHTML = summaryHtml();
    state.root.querySelectorAll('[data-cnt]').forEach(el => {
      el.textContent = state.phase === 'ready' ? String(counts[el.dataset.cnt] ?? 0) : '';
    });
  }

  function rowEl(id) {
    for (const li of state.bodyEl.querySelectorAll('li.wl-row')) {
      if (li.dataset.id === String(id)) return li;
    }
    return null;
  }

  // 한 행만 다시 그린다(스크롤 유지)
  function replaceRow(id) {
    const el = rowEl(id);
    const r = state.index.get(String(id));
    if (!el || !r) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = rowHtml(r).trim();
    el.replaceWith(tpl.content.firstElementChild);
  }

  /* ---------- data ---------- */
  // keep: 다른 곳에서 바뀐 내용을 반영할 때. 방금 판단해 화면에 남겨 둔 줄(sticky)을 지우지 않는다.
  async function load({ keep = false } = {}) {
    const date = state.date;
    const seq = ++state.seq;
    if (!keep) state.sticky.clear();
    // 같은 날짜를 다시 불러올 때는 화면을 비우지 않는다(스크롤 유지)
    if (!(state.phase === 'ready' && state.loadedDate === date)) {
      state.phase = 'loading';
      state.items = [];
      state.index = new Map();
      state.loadedDate = null;
      renderBody();
    }
    try {
      const res = await UI.api.get('/stock_reviews', date ? { date } : { all: 1 });
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
    syncToolbar();
  }

  function confirmText(r, decision) {
    const db = dbStock(r);
    const counted = numOrNull(r.counted_qty);
    const head = `${r.item_name || r.item_code}\n총 재고 ${UI.num(db)} → 실재고 ${UI.num(counted)}`;
    if (decision === 'applied') {
      return `${head}\n\n플레이오토 실재고를 ${UI.num(counted)}개로 바꿉니다. 반영할까요?`;
    }
    if (decision === 'rejected') return `${head}\n\n반영하지 않고 닫을까요?`;
    return '';
  }

  async function decide(btn, r, decision) {
    const id = String(r.id);
    const ask = decision === 'pending' && isDecided(r)
      ? `${r.item_name || r.item_code}\n판단을 취소하고 다시 대기 목록으로 돌릴까요?`
      : confirmText(r, decision);
    if (ask && !(await UI.confirm(ask))) return;

    const li = btn.closest('li.wl-row');
    const memoEl = li && li.querySelector('input[data-role="memo"]');
    const note = memoEl ? memoEl.value.trim() : '';
    const res = await UI.busy(btn, () => UI.api.post('/stock_reviews/decide', { id: r.id, decision, note }));
    if (res === undefined) return;

    state.memos.delete(id);
    const item = applyItem(id, res && res.item);
    if (decision === 'applied') { toastPlayauto(item); autoSoldout(item || r); }
    else if (decision === 'rejected') UI.toast('미반영으로 닫았습니다', 'info');
    else if (decision === 'held') UI.toast('보류로 표시했습니다', 'info');
    else UI.toast('대기 상태로 되돌렸습니다', 'info');
    Shell.refreshBadges();
  }

  // 서버가 돌려준 줄로 바꿔 그린다. 줄이 없으면 목록을 새로 받는다.
  function applyItem(id, item) {
    if (!item || !state.index.has(id)) { load(); return null; }
    const i = state.items.findIndex(x => String(x.id) === id);
    if (i >= 0) state.items[i] = item;
    state.index.set(id, item);
    state.sticky.add(id);
    replaceRow(id);
    syncToolbar();
    return item;
  }

  // 반영한 실재고가 기준 미만이면 품절처리에 자동으로 올린다(재고실사의 '일치'와 같은 기준).
  const AUTO_SOLDOUT_BELOW = 10;
  async function autoSoldout(r) {
    const qty = numOrNull(r.counted_qty);
    if (qty === null || qty >= AUTO_SOLDOUT_BELOW) return;
    if (r.stock_status === '단종' || r.item_status === '단종') return;   // 단종은 다시 들여오지 않는다
    try {
      const res = await UI.api.post('/soldout_items/add', { item_code: r.item_code, source: 'review', source_id: r.id });
      UI.toast(res && res.created === false
        ? `실재고 ${UI.num(qty)}개 · 이미 품절처리에 있는 상품입니다`
        : `실재고 ${UI.num(qty)}개 · 품절처리에 자동으로 추가했습니다`, 'info');
      Shell.refreshBadges();
    } catch (err) {
      if (!err || err.code !== 'AUTH_REQUIRED') {
        UI.toast(`품절처리 자동 추가 실패: ${(err && err.message) || '요청에 실패했습니다.'}`, 'error');
      }
    }
  }

  function toastPlayauto(item) {
    const status = item ? item.playauto_status : '';
    if (status === 'sent') UI.toast('반영했습니다 · 플레이오토 전송 완료', 'ok');
    else if (status === 'failed') UI.toast(`반영으로 기록했지만 플레이오토 전송에 실패했습니다: ${item.playauto_message || ''}`, 'error');
    else UI.toast(`반영으로 기록했습니다 · 플레이오토 전송 대기${item && item.playauto_message ? ` (${item.playauto_message})` : ''}`, 'info');
  }

  async function resend(btn, r) {
    const id = String(r.id);
    if (!(await UI.confirm(`${r.item_name || r.item_code}\n플레이오토 실재고를 ${UI.num(numOrNull(r.counted_qty))}개로 다시 전송할까요?`))) return;
    const res = await UI.busy(btn, () => UI.api.post('/stock_reviews/send', { id: r.id }));
    if (res === undefined) return;
    toastPlayauto(applyItem(id, res && res.item));
  }

  /* ---------- events ---------- */
  async function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !state.root.contains(btn)) return;
    const act = btn.dataset.act;

    if (act === 'filter') {
      if (state.filter === btn.dataset.val) return;
      state.filter = btn.dataset.val;
      state.sticky.clear();
      syncToolbar();
      renderBody();
      return;
    }
    if (act === 'retry' || act === 'reload') { load(); return; }

    const li = btn.closest('li.wl-row');
    const r = li && state.index.get(li.dataset.id);
    if (!r) return;
    if (act === 'open-item') { Shell.show('items', { code: r.item_code }); return; }
    if (act === 'decide') await decide(btn, r, btn.dataset.val);
    else if (act === 'send') await resend(btn, r);
  }

  function onInput(ev) {
    const input = ev.target;
    if (!input || !input.matches || !input.matches('input[data-role="memo"]')) return;
    const li = input.closest('li.wl-row');
    if (li) state.memos.set(li.dataset.id, input.value);
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
    root.classList.add('tab-review');
    root.innerHTML = `
      <div class="view-head"><h2>실사반영</h2><div class="rv-datebar"></div></div>
      <div class="view-toolbar rv-toolbar">
        <div class="seg" role="group" aria-label="목록 구분">
          ${FILTERS.map(([val, label]) =>
            `<button type="button" data-act="filter" data-val="${val}">${label}<span class="rv-cnt" data-cnt="${val}"></span></button>`).join('')}
        </div>
      </div>
      <div class="view-body"></div>`;
    state.bodyEl = root.querySelector('.view-body');
    state.dateBar = UI.dateBar(root.querySelector('.rv-datebar'), {
      value: state.date,
      allowAll: true,
      onChange: ymd => {
        state.date = ymd;
        state.memos.clear();
        load();
      },
    });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    syncToolbar();
  }

  function onShow(params) {
    // 날짜를 지정해서 들어온 경우에만 그 날짜로 바꾼다. 그 밖에는 보던 범위(기본: 전체)를 유지한다.
    if (params && isYmd(params.date) && params.date !== state.date) {
      state.date = params.date;
      state.dateBar.set(params.date);
      state.memos.clear();
    }
    syncToolbar();
    load();
  }

  function onHide() {
    state.seq++;                 // 진행 중이던 조회 결과는 버린다
    if (state.phase === 'loading') state.phase = 'idle';
  }

  // 다른 곳에서 바뀐 내용 반영. 메모를 적는 중이면 미룬다.
  function onRemoteChange() {
    const active = document.activeElement;
    if (active && state.root && state.root.contains(active) && active.matches('input[data-role="memo"]')) return false;
    if (state.phase === 'ready') load({ keep: true });
    return true;
  }

  Shell.register({ id: 'review', label: '실사반영', mount, onShow, onHide, onRemoteChange });
})();
