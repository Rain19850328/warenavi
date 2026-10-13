// tabs/review.js — 확인요청 탭(관리자 전용)
// 재고확인에서 불일치로 기록된 건을 모아 보여 주고, 관리자가 반영 / 보류 / 미반영을 판단한다.
// 반영하면 서버가 실재고를 플레이오토로 보낸다. 못 보낸 건은 '전송 대기 / 실패'로 남아 다시 보낼 수 있다.
(function () {
  'use strict';

  const STYLE_ID = 'tab-review-style';
  const CSS = `
.tab-review .rv-toolbar .seg{ flex: 1 1 100%; }
.tab-review .rv-cnt{ margin-left: 3px; font-weight: 500; opacity: .75; }
.tab-review .rv-summary{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-review .rv-row{ border-left: 4px solid #ef4444; }
.tab-review .rv-row--held{ border-left-color: #f59e0b; }
.tab-review .rv-row--applied{ border-left-color: #22c55e; }
.tab-review .rv-row--rejected{ border-left-color: #94a3b8; }
.tab-review .rv-name{
  appearance: none; display: block; width: 100%; padding: 0;
  border: 0; background: none; cursor: pointer; text-align: left; font-family: inherit;
}
.tab-review .rv-loc{ font-size: 14px; font-weight: 700; color: #0f172a; }
.tab-review .rv-qty{ display: flex; align-items: flex-end; gap: 10px; }
.tab-review .rv-qty__box{ display: flex; flex-direction: column; align-items: flex-end; min-width: 52px; line-height: 1.1; }
.tab-review .rv-qty__label{ font-size: 12px; font-weight: 600; color: #64748b; }
.tab-review .rv-qty__num{ font-size: 26px; font-weight: 800; color: #0f172a; }
.tab-review .rv-qty__num--old{ color: #64748b; }
.tab-review .rv-qty__arrow{ padding-bottom: 4px; font-size: 18px; color: #94a3b8; }
.tab-review .rv-diff{ font-size: 13px; font-weight: 700; }
.tab-review .rv-diff--minus{ color: #b91c1c; }
.tab-review .rv-diff--plus{ color: #1d4ed8; }
.tab-review .rv-sub{ font-size: 11px; color: #64748b; }
.tab-review .rv-note{
  margin-top: 6px; padding: 6px 8px; border-radius: 8px;
  background: #f1f5f9; font-size: 13px; line-height: 1.4; color: #334155; word-break: break-word;
}
.tab-review .rv-note--reason{ background: #fef2f2; color: #991b1b; }
.tab-review .rv-memo{ flex: 1 0 100%; }
.tab-review .wl-actions .rv-act{ flex: 1 1 88px; min-height: 44px; font-size: 15px; }
.tab-review .rv-state{ display: grid; justify-items: center; gap: 4px; padding-bottom: 20px; }
@media (min-width: 640px){
  .tab-review .rv-toolbar .seg{ flex: 0 1 auto; }
}`;

  const SCOPES = [['open', '판단 대기'], ['done', '판단 완료']];
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
    scope: 'open',
    items: [],
    index: new Map(),      // String(id) -> row
    loadedScope: null,     // 지금 items가 어느 조회의 결과인지
    phase: 'idle',         // loading | error | ready
    errorMsg: '',
    seq: 0,
    sticky: new Set(),     // 방금 판단한 줄: 목록 조건에서 벗어나도 제자리에 둔다
    memos: new Map(),      // String(id) -> 입력 중인 메모
  };

  const esc = v => UI.esc(v);

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

  /* ---------- rendering ---------- */
  function sideHtml(r) {
    const db = dbStock(r);
    const counted = numOrNull(r.counted_qty);
    const parts = [`
      <div class="rv-qty">
        <div class="rv-qty__box"><span class="rv-qty__label">DB 재고</span><span class="rv-qty__num rv-qty__num--old">${esc(UI.num(db))}</span></div>
        <span class="rv-qty__arrow" aria-hidden="true">→</span>
        <div class="rv-qty__box"><span class="rv-qty__label">실재고</span><span class="rv-qty__num">${esc(UI.num(counted))}</span></div>
      </div>`];
    if (db !== null && counted !== null && counted !== db) {
      const d = counted - db;
      parts.push(`<span class="rv-diff ${d < 0 ? 'rv-diff--minus' : 'rv-diff--plus'}">${d > 0 ? '+' : ''}${esc(UI.num(d))}</span>`);
    }
    const atCheck = numOrNull(r.db_stock);
    if (atCheck !== null && db !== null && atCheck !== db) {
      parts.push(`<span class="rv-sub">확인 당시 DB ${esc(UI.num(atCheck))}</span>`);
    }
    return parts.join('');
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
    const cls = ['wl-row', 'rv-row'];
    if (decision) cls.push(`rv-row--${r.review_status}`);
    if (isDecided(r)) cls.push('is-done');

    const chips = [];
    if (r.check_date) chips.push(UI.chip(r.check_date, 'muted'));
    if (decision) chips.push(UI.chip(decision.label, decision.tone));
    const pa = PLAYAUTO[r.playauto_status];
    if (pa) chips.push(UI.chip(pa[0], pa[1]));
    if (r.stock_status) chips.push(UI.chip(r.stock_status, 'muted'));

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
          <button type="button" class="wl-name rv-name" data-act="open-item" title="상품조회에서 보기">${esc(r.item_name || r.item_code)}</button>
          <div class="wl-code">${esc(r.item_code)}</div>
          <div class="wl-meta"><span class="rv-loc">${esc(locText(r.location_code))}</span></div>
          <div class="wl-meta">${chips.join('')}</div>
          ${notes.join('')}
          ${checked ? `<div class="wl-meta">불일치 기록: ${esc(checked)}</div>` : ''}
        </div>
        <div class="wl-side">${sideHtml(r)}</div>
        <div class="wl-actions">${actionsHtml(r)}</div>
      </li>`;
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
      body.innerHTML = stateHtml(state.scope === 'open'
        ? '판단을 기다리는 불일치 건이 없습니다.'
        : '판단을 마친 건이 없습니다.');
      return;
    }
    const held = state.items.filter(r => r.review_status === 'held').length;
    const summary = state.scope === 'open'
      ? `대기 ${UI.num(state.items.length)}건${held ? ` (보류 ${UI.num(held)}건 포함)` : ''}`
      : `최근 ${UI.num(state.items.length)}건`;
    body.innerHTML =
      `<p class="rv-summary">${esc(summary)}</p>` +
      `<ul class="wl-list">${state.items.map(rowHtml).join('')}</ul>`;
  }

  function syncToolbar() {
    state.root.querySelectorAll('[data-act="scope"]').forEach(b => {
      const on = b.dataset.val === state.scope;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const cnt = state.root.querySelector('[data-cnt="open"]');
    const counts = Shell.counts();
    if (cnt) cnt.textContent = counts && Number(counts.review_open) > 0 ? String(Number(counts.review_open)) : '';
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
    const scope = state.scope;
    const seq = ++state.seq;
    if (!keep) state.sticky.clear();
    // 같은 목록을 다시 불러올 때는 화면을 비우지 않는다(스크롤 유지)
    if (!(state.phase === 'ready' && state.loadedScope === scope)) {
      state.phase = 'loading';
      state.items = [];
      state.index = new Map();
      state.loadedScope = null;
      renderBody();
    }
    try {
      const res = await UI.api.get('/stock_reviews', { scope });
      if (seq !== state.seq) return;
      const fresh = Array.isArray(res && res.items) ? res.items : [];
      const freshIds = new Set(fresh.map(r => String(r.id)));
      // 방금 판단한 줄은 목록 조건에서 빠졌더라도 제자리에 남긴다.
      const kept = keep ? state.items.filter(r => state.sticky.has(String(r.id)) && !freshIds.has(String(r.id))) : [];
      state.items = fresh.concat(kept);
      state.index = new Map(state.items.map(r => [String(r.id), r]));
      state.loadedScope = scope;
      state.phase = 'ready';
    } catch (err) {
      if (seq !== state.seq) return;
      state.items = [];
      state.index = new Map();
      state.loadedScope = null;
      state.phase = 'error';
      state.errorMsg = (err && err.message) || '';
    }
    renderBody();
    syncToolbar();
  }

  function confirmText(r, decision) {
    const db = dbStock(r);
    const counted = numOrNull(r.counted_qty);
    const head = `${r.item_name || r.item_code}\nDB 재고 ${UI.num(db)} → 실재고 ${UI.num(counted)}`;
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
    if (decision === 'applied') toastPlayauto(item);
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
    return item;
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

    if (act === 'scope') {
      if (state.scope === btn.dataset.val) return;
      state.scope = btn.dataset.val;
      state.memos.clear();
      syncToolbar();
      load();
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
      <div class="view-head"><h2>확인요청</h2></div>
      <div class="view-toolbar rv-toolbar">
        <div class="seg" role="group" aria-label="목록 구분">
          ${SCOPES.map(([val, label]) =>
            `<button type="button" data-act="scope" data-val="${val}">${label}${val === 'open' ? '<span class="rv-cnt" data-cnt="open"></span>' : ''}</button>`).join('')}
        </div>
        <button type="button" class="btn-sm" data-act="reload">새로고침</button>
      </div>
      <div class="view-body"></div>`;
    state.bodyEl = root.querySelector('.view-body');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    window.addEventListener('shell:counts', () => { if (state.root) syncToolbar(); });
    syncToolbar();
  }

  function onShow() {
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

  Shell.register({ id: 'review', label: '확인요청', mount, onShow, onHide, onRemoteChange });
})();
