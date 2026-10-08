// shell.js — 하단 탭바 + 화면 전환(해시 라우팅) (window.Shell)
// app.js 전역(NEW_INBOUND, MOVE, openNewInboundDialog, applyFooterSafePadding …)은 호출 시점에 찾는다.
(function () {
  'use strict';

  // 탭바 순서: 자주 쓰는 순(직원 → 매니저 → 관리자). 휴대폰에서는 앞의 4~5칸이 먼저 보인다.
  // min = 이 탭을 볼 수 있는 가장 낮은 권한. 권한이 모자란 탭은 탭바에 나오지 않는다.
  const TABS = [
    { id: 'items', label: '상품조회', min: 'staff' },
    { id: 'irregular', label: '이형포장', min: 'staff' },
    { id: 'stockcheck', label: '재고확인', min: 'manager' },
    { id: 'display', label: '진열보충', min: 'manager' },
    { id: 'newinbound', label: '신규입고', min: 'admin' },
    { id: 'map', label: '창고맵', min: 'admin' },
    { id: 'soldout', label: '품절관리', min: 'admin' },
    { id: 'logs', label: '작업로그', min: 'staff' },
    { id: 'users', label: '권한설정', min: 'admin' },
  ];
  const VIEW_IDS = TABS.map(t => t.id);
  const DEFAULT_ID = 'items';   // 주소에 화면 지정이 없을 때 여는 첫 화면(모든 권한이 볼 수 있어야 한다)

  const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };
  const ROLE_LABELS = { staff: '직원', manager: '매니저', admin: '관리자' };
  const ROLE_KEY = 'warenavi.role';   // 마지막으로 확인한 내 권한(다음에 열 때 탭이 바로 보이도록)

  function readCachedRole() {
    try {
      const role = localStorage.getItem(ROLE_KEY);
      return Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? role : null;
    } catch (_) { return null; }
  }

  const state = {
    started: false,
    current: null,      // 지금 보이는 화면 id
    role: readCachedRole() || 'staff',   // 서버 답이 오기 전에는 저장해 둔 권한, 없으면 가장 낮은 권한
    bootstrap: false,   // 관리자가 아직 지정되지 않은 상태(모두 관리자로 동작)
    activeKey: null,    // 지금 화면의 정규화된 해시(중복 onShow 방지용)
    registry: {},       // id -> {def, mounted}
    badges: {},         // id -> count
    scroll: {},         // id -> window.scrollY
    barEl: null,
    badgePromise: null,
    badgeAgain: false,
  };

  /* ---------- helpers ---------- */
  function viewEl(id) { return document.getElementById(`view-${id}`); }
  function isView(id) { return VIEW_IDS.includes(id); }
  function can(id) {
    const tab = TABS.find(t => t.id === id);
    return !!tab && ROLE_RANK[state.role] >= ROLE_RANK[tab.min];
  }

  function notify(message, tone) {
    if (window.UI && typeof window.UI.toast === 'function') window.UI.toast(message, tone);
    else console.warn(message);
  }

  // 창고맵에서 랙 셀을 고르는 중인지(신규입고 위치선택 / 이동 대상 선택)
  function isPicking() {
    try { if (typeof NEW_INBOUND !== 'undefined' && NEW_INBOUND && NEW_INBOUND.picking) return true; } catch (_) {}
    try { if (typeof MOVE !== 'undefined' && MOVE && MOVE.reopenAfterPick) return true; } catch (_) {}
    return false;
  }

  function cleanParams(params) {
    const out = {};
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === '') continue;
        out[key] = String(value);
      }
    }
    return out;
  }

  function buildHash(id, params) {
    const qs = new URLSearchParams(cleanParams(params));
    qs.sort();
    const query = qs.toString();
    return `#/${id}${query ? '?' + query : ''}`;
  }

  function parseHash(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const cut = raw.indexOf('?');
    let id = cut >= 0 ? raw.slice(0, cut) : raw;
    try { id = decodeURIComponent(id); } catch (_) {}
    id = id.replace(/\/+$/, '');
    const params = {};
    if (cut >= 0) {
      for (const [key, value] of new URLSearchParams(raw.slice(cut + 1))) params[key] = value;
    }
    if (!isView(id) || !can(id)) return { id: DEFAULT_ID, params: {} };
    return { id, params };
  }

  function callHook(id, name, arg) {
    const entry = state.registry[id];
    if (!entry || typeof entry.def[name] !== 'function') return;
    try {
      const out = entry.def[name](arg);
      if (out && typeof out.catch === 'function') out.catch(err => console.error(`[Shell] ${id}.${name} failed`, err));
    } catch (err) {
      console.error(`[Shell] ${id}.${name} failed`, err);
    }
  }

  function ensureMounted(id) {
    const entry = state.registry[id];
    const root = viewEl(id);
    if (!entry || entry.mounted || !root) return;
    entry.mounted = true;
    callHook(id, 'mount', root);
  }

  /* ---------- tab bar ---------- */
  function renderBar() {
    const bar = state.barEl;
    if (!bar) return;
    bar.querySelectorAll('.tabbar__tab').forEach(btn => {
      const id = btn.dataset.tab;
      const active = id === state.current;
      btn.classList.toggle('is-active', active);
      if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
      const badge = btn.querySelector('.tabbar__badge');
      const count = Number(state.badges[id] || 0);
      if (badge) {
        badge.hidden = !(count > 0);
        badge.textContent = count > 99 ? '99+' : String(count);
      }
    });
  }

  function revealActiveTab() {
    const btn = state.barEl && state.barEl.querySelector('.tabbar__tab.is-active');
    if (!btn) return;
    try { btn.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (_) {}
  }

  // 내 권한으로 볼 수 있는 탭만 그린다(권한이 바뀌면 다시 그린다).
  function buildBar() {
    const bar = state.barEl;
    if (!bar) return;
    bar.innerHTML = TABS.filter(tab => can(tab.id)).map(tab => `
      <button type="button" class="tabbar__tab" data-tab="${tab.id}">
        <span class="tabbar__label">${tab.label}</span>
        <span class="tabbar__badge" hidden></span>
      </button>`).join('');
    renderBar();
  }

  function mountTabBar(barEl) {
    if (!barEl) return;
    state.barEl = barEl;
    barEl.classList.add('tabbar');
    barEl.setAttribute('role', 'navigation');
    barEl.setAttribute('aria-label', '화면 이동');
    buildBar();
    barEl.addEventListener('click', ev => {
      const btn = ev.target.closest('.tabbar__tab');
      if (!btn || !barEl.contains(btn)) return;
      show(btn.dataset.tab);
    });
  }

  // 서버가 알려준 내 권한을 반영한다. 볼 수 없게 된 화면에 있으면 첫 화면으로 돌려보낸다.
  function setRole(role, bootstrap) {
    const next = Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? role : 'staff';
    const boot = bootstrap === true;
    if (next === state.role && boot === state.bootstrap) return;
    state.role = next;
    state.bootstrap = boot;
    try { localStorage.setItem(ROLE_KEY, next); } catch (_) {}
    buildBar();
    if (state.started) {
      // 주소에 적힌 화면을 이제 볼 수 있으면 그리로, 볼 수 없으면 첫 화면으로 맞춘다.
      const route = parseHash(location.hash);
      const key = buildHash(route.id, route.params);
      if (route.id !== state.current) activate(route.id, route.params);
      const raw = String(location.hash || '');
      if (raw && raw !== key) { try { history.replaceState(null, '', key); } catch (_) {} }
      revealActiveTab();
    }
    try { window.dispatchEvent(new CustomEvent('shell:role')); } catch (_) {}
  }

  /* ---------- view switching ---------- */
  function activate(id, params) {
    const prev = state.current;
    const changed = prev !== id;

    if (changed) {
      if (prev) {
        state.scroll[prev] = window.scrollY || 0;
        callHook(prev, 'onHide');
      }
      for (const viewId of VIEW_IDS) {
        const el = viewEl(viewId);
        if (el) el.hidden = viewId !== id;
      }
      state.current = id;
      state.changePending = false;   // 새로 여는 화면은 어차피 최신 내용을 받아 온다
    }
    state.activeKey = buildHash(id, params);
    renderBar();

    if (id === 'map') {
      // 숨겨진 동안 계산된 치수(0px)를 다시 잡는다.
      try { if (typeof syncHeaderSizes === 'function') syncHeaderSizes(); } catch (_) {}
      try { if (typeof applyFooterSafePadding === 'function') applyFooterSafePadding(); } catch (_) {}
    } else {
      ensureMounted(id);
      callHook(id, 'onShow', cleanParams(params));
    }

    if (changed) {
      window.scrollTo(0, state.scroll[id] || 0);
      revealActiveTab();
    }
    refreshBadges();
  }

  function show(id, params) {
    if (!isView(id)) id = DEFAULT_ID;
    if (!can(id)) {
      notify('이 화면을 볼 권한이 없습니다', 'error');
      return false;
    }

    if (state.current === 'map' && id !== 'map' && isPicking()) {
      notify('위치 선택 중에는 이동할 수 없습니다', 'error');
      return false;
    }

    const hash = buildHash(id, params);
    // activeKey를 먼저 맞춰 두면 뒤따르는 hashchange가 같은 화면을 다시 띄우지 않는다.
    activate(id, params);
    const now = parseHash(location.hash);
    if (state.started && buildHash(now.id, now.params) !== hash) {
      location.hash = hash;
    }
    return true;
  }

  function onHashChange() {
    const route = parseHash(location.hash);
    const key = buildHash(route.id, route.params);
    if (key === state.activeKey) {
      // 볼 수 없는 화면 주소를 직접 친 경우: 화면은 그대로 두고 주소만 바로잡는다.
      if (String(location.hash || '') !== key) { try { history.replaceState(null, '', key); } catch (_) {} }
      return;
    }
    if (state.current === 'map' && route.id !== 'map' && isPicking()) {
      notify('위치 선택 중에는 이동할 수 없습니다', 'error');
      try { history.replaceState(null, '', state.activeKey || '#/map'); } catch (_) {}
      return;
    }
    activate(route.id, route.params);
    // 볼 수 없는 화면 주소였으면 첫 화면으로 왔으므로 주소도 맞춘다.
    if (String(location.hash || '') !== key) { try { history.replaceState(null, '', key); } catch (_) {} }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    window.addEventListener('hashchange', onHashChange);
    const route = parseHash(location.hash);
    activate(route.id, route.params);
    startWatch();
  }

  function register(def) {
    if (!def || !isView(def.id) || def.id === 'map') {
      console.warn('[Shell] register: 알 수 없는 탭', def && def.id);
      return;
    }
    state.registry[def.id] = { def, mounted: false };
    // start() 이후에 등록된 탭이 이미 열려 있는 화면이면 바로 채운다.
    if (state.started && state.current === def.id) {
      ensureMounted(def.id);
      callHook(def.id, 'onShow', parseHash(location.hash).params);
    }
  }

  /* ---------- badges ---------- */
  function setBadge(id, count) {
    const n = Number(count);
    state.badges[id] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    renderBar();
  }

  // watch = 주기 확인에서 부른 경우. 그때만 '다른 곳에서 바뀜'으로 보고 지금 화면을 새로 고친다.
  // (탭을 옮기거나 내가 방금 저장해서 부른 경우는 화면이 이미 최신이라 표시만 맞춰 둔다.)
  async function fetchBadges(watch) {
    try {
      if (!window.UI || !window.UI.api) return;
      let date;
      try { if (typeof todayYmd === 'function') date = todayYmd(); } catch (_) {}
      const viewAtStart = state.current;
      const c = (await window.UI.api.get('/tab_counts', { date })) || {};
      state.lastFetchAt = Date.now();
      const n = v => Number(v) || 0;
      state.counts = c;
      if (typeof c.change_stamp === 'string') {
        if (watch && state.stamp && c.change_stamp !== state.stamp && state.current === viewAtStart) state.changePending = true;
        state.stamp = c.change_stamp;
      }
      // 권한을 내려주지 않는 예전 서버에서는 지금까지처럼 모든 탭을 보여준다.
      if (typeof c.role === 'string') setRole(c.role, c.role_bootstrap);
      else setRole('admin', false);
      // 상품조회 첫 화면의 '오늘 할 일' 카드가 같은 숫자를 쓴다.
      try { window.dispatchEvent(new CustomEvent('shell:counts')); } catch (_) {}
      setBadge('stockcheck', n(c.stock_check_pending) + n(c.mismatch_open));
      setBadge('display', n(c.display_open));
      setBadge('irregular', n(c.irregular_open));
      // 뱃지가 처음 붙으면 탭 폭이 늘어나 끝쪽 활성 탭이 화면 밖으로 밀린다 → 한 번만 다시 맞춘다.
      if (!state.badgeRevealed) { state.badgeRevealed = true; revealActiveTab(); }
    } catch (_) {
      // 백엔드 미배포·네트워크 오류는 조용히 무시한다.
    }
  }

  function refreshBadges(watch) {
    // 조회 중에 또 불리면(방금 저장한 내용이 빠졌을 수 있으므로) 끝난 뒤 한 번 더 조회한다.
    if (state.badgePromise) { if (!watch) state.badgeAgain = true; return state.badgePromise; }
    state.badgePromise = (async () => {
      try {
        let watching = watch === true;
        do {
          state.badgeAgain = false;
          await fetchBadges(watching);
          watching = false;
        } while (state.badgeAgain);
      } finally {
        state.badgePromise = null;
      }
    })();
    return state.badgePromise;
  }

  /* ---------- 다른 곳에서 바뀐 내용 자동 반영 ---------- */
  const WATCH_MS = 25000;        // 화면이 켜져 있는 동안 변경 여부를 확인하는 간격
  const WATCH_MIN_GAP_MS = 5000; // 화면으로 돌아왔을 때 방금 확인했으면 다시 묻지 않는다

  // 사용자가 무언가 입력·선택하는 중이면 화면을 바꾸지 않는다(다음 확인 때 다시 시도).
  function isUserBusy() {
    if (document.querySelector('dialog[open]')) return true;
    if (isPicking()) return true;
    const el = document.activeElement;
    const view = viewEl(state.current);
    if (!el || !view || !view.contains(el)) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    // 검색창·날짜는 계속 포커스가 남아 있는 칸이라 입력 중으로 보지 않는다.
    return el.tagName === 'INPUT' && !['search', 'date', 'checkbox', 'radio', 'button', 'submit'].includes(el.type);
  }

  function deliverChange() {
    if (!state.changePending || isUserBusy()) return;
    const id = state.current;
    if (id === 'map') {
      state.changePending = false;
      try {
        if (typeof loadCells === 'function') Promise.resolve(loadCells()).catch(() => {});
        if (typeof loadMovements === 'function') Promise.resolve(loadMovements()).catch(() => {});
      } catch (_) {}
      return;
    }
    const entry = state.registry[id];
    if (!entry || !entry.mounted || typeof entry.def.onRemoteChange !== 'function') { state.changePending = false; return; }
    try {
      // 탭이 false 를 돌려주면(작성 중인 칸이 있는 등) 다음 확인 때 다시 시도한다.
      if (entry.def.onRemoteChange() !== false) state.changePending = false;
    } catch (err) {
      state.changePending = false;
      console.error(`[Shell] ${id}.onRemoteChange failed`, err);
    }
  }

  async function watchTick() {
    if (!state.started || document.visibilityState !== 'visible') return;
    await refreshBadges(true);
    deliverChange();
  }

  function startWatch() {
    setInterval(watchTick, WATCH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - (state.lastFetchAt || 0) >= WATCH_MIN_GAP_MS) watchTick();
    });
  }

  // 첫 화면이 창고맵이 아니면, app.js 준비가 끝나기 전에 창고맵이 잠깐 비치지 않도록 미리 가려 둔다.
  (function hideOtherViewsEarly() {
    const first = parseHash(location.hash).id;
    for (const viewId of VIEW_IDS) {
      const el = viewEl(viewId);
      if (el) el.hidden = viewId !== first;
    }
  })();

  window.Shell = {
    register,
    start,
    mountTabBar,
    show,
    current: () => state.current || DEFAULT_ID,
    setBadge,
    refreshBadges: () => refreshBadges(false),
    counts: () => state.counts || null,   // 마지막으로 받은 /tab_counts 응답(아직 없으면 null)
    can,                                  // 내 권한으로 이 탭을 볼 수 있는지
    role: () => state.role,
    roleLabel: role => ROLE_LABELS[role || state.role] || '',
    isBootstrap: () => state.bootstrap,
    checkNow: watchTick,                  // 다른 곳에서 바뀐 내용이 있는지 지금 확인
  };
})();
