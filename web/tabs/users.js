// tabs/users.js — 권한설정 탭(관리자 전용): 계정 목록을 보고 계정마다 직원/매니저/관리자를 지정한다.
(function () {
  'use strict';

  const ROLES = [
    { id: 'staff', label: '직원', help: '상품조회 · 이형포장 · 작업로그' },
    { id: 'manager', label: '매니저', help: '직원 + 재고확인 · 진열보충' },
    { id: 'admin', label: '관리자', help: '모든 탭 + 권한설정' },
  ];
  const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };

  const state = {
    root: null,
    users: [],
    me: '',
    bootstrap: false,
    q: '',
    phase: 'idle',      // 'idle' | 'loading' | 'ready' | 'error'
    errorMsg: '',
    seq: 0,
  };

  const esc = v => UI.esc(v);
  const $ = sel => state.root.querySelector(sel);

  function injectStyle() {
    if (document.getElementById('tab-users-style')) return;
    const style = document.createElement('style');
    style.id = 'tab-users-style';
    style.textContent = `
.tab-users [hidden]{ display: none !important; }
.tab-users .us-notice{ margin: 0 0 10px; padding: 10px 12px; border: 1px solid #fde68a; border-radius: 12px; background: #fffbeb; font-size: 13px; line-height: 1.5; color: #92400e; }
.tab-users .us-notice b{ color: #78350f; }
.tab-users .us-notice button{ margin-top: 8px; }
.tab-users .us-legend{ margin: 0 0 10px; padding: 0; list-style: none; display: grid; gap: 2px; font-size: 12px; color: #64748b; }
.tab-users .us-legend b{ display: inline-block; min-width: 3.5em; color: #334155; }
.tab-users .us-q{ flex: 1 1 auto; height: 40px; }
.tab-users .us-count{ margin: 0 0 8px; font-size: 12px; color: #64748b; }
.tab-users .us-row{ flex-wrap: wrap; }
.tab-users .us-row .wl-name{ font-size: 15px; }
.tab-users .us-email{ font-size: 12px; color: #64748b; word-break: break-all; }
.tab-users .us-side{ flex: 0 0 auto; }
.tab-users .us-role > button{ min-width: 58px; }
.tab-users .us-role > button.is-active[data-value="manager"]{ background: #d97706; }
.tab-users .us-role > button.is-active[data-value="admin"]{ background: #dc2626; }
@media (max-width: 520px){
  .tab-users .us-side{ flex: 1 0 100%; }
  .tab-users .us-role{ display: flex; width: 100%; }
  .tab-users .us-role > button{ flex: 1 1 0; }
}`;
    document.head.append(style);
  }

  function visibleUsers() {
    const q = state.q.trim().toLowerCase();
    const list = q
      ? state.users.filter(u => `${u.name} ${u.email}`.toLowerCase().includes(q))
      : state.users.slice();
    // 권한 높은 순 → 이름순
    return list.sort((a, b) => (ROLE_RANK[b.role] - ROLE_RANK[a.role]) || String(a.name).localeCompare(String(b.name), 'ko'));
  }

  function rowHtml(u) {
    const isMe = u.id === state.me;
    const login = UI.fmtDateTime(u.last_sign_in_at);
    const changed = u.role_assigned
      ? [u.role_updated_by, UI.fmtDateTime(u.role_updated_at)].filter(Boolean).join(' · ')
      : '';
    return `
      <li class="wl-row us-row" data-id="${esc(u.id)}">
        <div class="wl-main">
          <div class="wl-name">${esc(u.name || u.email)}${isMe ? ' ' + UI.chip('나', 'info') : ''}${u.role_assigned ? '' : ' ' + UI.chip('미지정', 'muted')}</div>
          <div class="us-email">${esc(u.email)}</div>
          <div class="wl-meta">${esc(login ? `최근 로그인 ${login}` : '로그인 기록 없음')}${changed ? esc(` · 권한 변경 ${changed}`) : ''}</div>
        </div>
        <div class="wl-side us-side">
          <div class="seg us-role" role="group" aria-label="권한">
            ${ROLES.map(r => `<button type="button" data-act="role" data-value="${r.id}"${u.role === r.id ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${esc(r.label)}</button>`).join('')}
          </div>
        </div>
      </li>`;
  }

  function noticeHtml() {
    if (!state.bootstrap) return '';
    const mine = state.users.find(u => u.id === state.me);
    return `
      <div class="us-notice">
        <b>아직 관리자가 지정되지 않았습니다.</b> 지금은 모든 계정이 관리자처럼 모든 탭을 볼 수 있습니다.<br>
        매니저로 둘 계정을 먼저 지정한 뒤, 마지막에 관리자를 지정하세요.
        관리자가 지정되는 순간부터 권한이 적용되고, 지정하지 않은 계정은 모두 <b>직원</b>이 됩니다.
        ${mine ? '<br><button type="button" class="btn-sm" data-act="make-me-admin">내 계정을 관리자로 지정</button>' : ''}
      </div>`;
  }

  function render() {
    const body = $('.view-body');
    if (!body) return;
    if (state.phase === 'loading' || state.phase === 'idle') {
      body.innerHTML = '<p class="empty">계정 목록을 불러오는 중…</p>';
      return;
    }
    if (state.phase === 'error') {
      body.innerHTML = `<p class="empty">${esc(state.errorMsg || '계정 목록을 불러오지 못했습니다.')}</p>
        <p class="empty"><button type="button" class="btn-sm" data-act="reload">다시 시도</button></p>`;
      return;
    }
    const list = visibleUsers();
    body.innerHTML = `
      ${noticeHtml()}
      <ul class="us-legend">${ROLES.map(r => `<li><b>${esc(r.label)}</b>${esc(r.help)}</li>`).join('')}</ul>
      <p class="us-count">계정 ${esc(UI.num(list.length))}개${state.q.trim() ? ` (전체 ${esc(UI.num(state.users.length))}개)` : ''}</p>
      ${list.length
        ? `<ul class="wl-list">${list.map(rowHtml).join('')}</ul>`
        : '<p class="empty">조건에 맞는 계정이 없습니다.</p>'}`;
  }

  async function load() {
    const seq = ++state.seq;
    if (state.phase !== 'ready') { state.phase = 'loading'; render(); }
    try {
      const res = await UI.api.get('/users');
      if (seq !== state.seq) return;
      state.users = Array.isArray(res && res.users) ? res.users : [];
      state.me = (res && res.me) || '';
      state.bootstrap = !!(res && res.bootstrap);
      state.phase = 'ready';
    } catch (err) {
      if (seq !== state.seq) return;
      if (err && err.code === 'AUTH_REQUIRED') { state.phase = 'idle'; return; }
      state.phase = 'error';
      state.errorMsg = (err && err.message) || '';
    }
    render();
  }

  function roleLabel(id) { return (ROLES.find(r => r.id === id) || {}).label || id; }
  function roleTo(id) { return roleLabel(id) + (id === 'staff' ? '으로' : '로'); }   // 직원으로 / 매니저로 / 관리자로

  async function setRole(button, userId, role) {
    const user = state.users.find(u => u.id === userId);
    if (!user) return;
    if (user.role === role && user.role_assigned) return;
    const isMe = user.id === state.me;
    const who = user.name || user.email;

    if (state.bootstrap && role === 'admin') {
      const ok = await UI.confirm(isMe
        ? '내 계정을 관리자로 지정할까요? 지금부터 권한이 적용되고, 지정하지 않은 계정은 모두 직원이 됩니다.'
        : `${who} 계정을 첫 관리자로 지정할까요? 지금부터 권한이 적용되어, 내 계정을 포함해 지정하지 않은 계정은 모두 직원이 됩니다.`);
      if (!ok) return;
    } else if (isMe && !state.bootstrap && user.role === 'admin' && role !== 'admin') {
      const ok = await UI.confirm(`내 권한을 ${roleTo(role)} 낮출까요? 낮추면 이 화면을 더 이상 열 수 없습니다.`);
      if (!ok) return;
    }

    await UI.busy(button, async () => {
      const res = await UI.api.post('/users/role', { user_id: user.id, role });
      UI.toast(res && res.changed === false
        ? '이미 같은 권한입니다'
        : `${who}: ${roleTo(role)} 변경했습니다`, 'ok');
      // 내 권한이 바뀌었을 수 있으니(직접 변경·첫 관리자 지정) 탭 구성을 다시 받아 온다.
      await Shell.refreshBadges();
      if (Shell.current() === 'users') await load();
    });
  }

  function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !state.root.contains(btn)) return;
    const act = btn.dataset.act;
    if (act === 'reload') { load(); return; }
    if (act === 'make-me-admin') { setRole(btn, state.me, 'admin'); return; }
    if (act === 'role') {
      const row = btn.closest('.us-row');
      if (row) setRole(btn, row.dataset.id, btn.dataset.value);
    }
  }

  function onInput(ev) {
    if (ev.target.classList && ev.target.classList.contains('us-q')) {
      state.q = ev.target.value;
      if (state.phase === 'ready') render();
    }
  }

  function mount(root) {
    state.root = root;
    injectStyle();
    root.classList.add('tab-users');
    root.innerHTML = `
      <div class="view-head"><h2>권한설정</h2><button type="button" class="btn-sm" data-act="reload">새로고침</button></div>
      <div class="view-toolbar">
        <input type="search" class="us-q" placeholder="이름 · 이메일" aria-label="계정 검색" autocomplete="off" />
      </div>
      <div class="view-body"></div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
  }

  function onShow() { load(); }
  function onHide() { state.seq++; }

  Shell.register({ id: 'users', label: '권한설정', mount, onShow, onHide });
})();
