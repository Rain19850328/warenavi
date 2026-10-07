// shell.js — 하단 탭바 + 화면 전환(해시 라우팅) (window.Shell)
// app.js 전역(NEW_INBOUND, MOVE, openNewInboundDialog, applyFooterSafePadding …)은 호출 시점에 찾는다.
(function () {
  'use strict';

  // 탭바 순서. action 탭은 화면이 아니라 동작이다.
  const TABS = [
    { id: 'map', label: '창고맵' },
    { id: 'items', label: '상품조회' },
    { id: 'newinbound', label: '신규입고', action: true },
    { id: 'stockcheck', label: '재고확인' },
    { id: 'display', label: '진열보충' },
    { id: 'irregular', label: '이형포장' },
    { id: 'soldout', label: '품절관리' },
    { id: 'logs', label: '작업로그' },
  ];
  const VIEW_IDS = TABS.filter(t => !t.action).map(t => t.id);
  const DEFAULT_ID = 'map';

  const state = {
    started: false,
    current: null,      // 지금 보이는 화면 id
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
    if (!isView(id)) return { id: DEFAULT_ID, params: {} };
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

  function mountTabBar(barEl) {
    if (!barEl) return;
    state.barEl = barEl;
    barEl.classList.add('tabbar');
    barEl.setAttribute('role', 'navigation');
    barEl.setAttribute('aria-label', '화면 이동');
    barEl.innerHTML = TABS.map(tab => `
      <button type="button" class="tabbar__tab${tab.action ? ' tabbar__tab--action' : ''}" data-tab="${tab.id}">
        <span class="tabbar__label">${tab.label}</span>
        <span class="tabbar__badge" hidden></span>
      </button>`).join('');
    barEl.addEventListener('click', ev => {
      const btn = ev.target.closest('.tabbar__tab');
      if (!btn || !barEl.contains(btn)) return;
      show(btn.dataset.tab);
    });
    renderBar();
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

  function runNewInbound() {
    if (!show('map')) return;
    try {
      if (typeof openNewInboundDialog !== 'function') throw new Error('신규입고 화면을 불러오지 못했습니다.');
      Promise.resolve(openNewInboundDialog()).catch(err => alert('신규입고리스트 오류: ' + (err.message || err)));
    } catch (err) {
      alert('신규입고리스트 오류: ' + (err.message || err));
    }
  }

  function show(id, params) {
    if (id === 'newinbound') { runNewInbound(); return true; }
    if (!isView(id)) id = DEFAULT_ID;

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
    if (key === state.activeKey) return;
    if (state.current === 'map' && route.id !== 'map' && isPicking()) {
      notify('위치 선택 중에는 이동할 수 없습니다', 'error');
      try { history.replaceState(null, '', state.activeKey || '#/map'); } catch (_) {}
      return;
    }
    activate(route.id, route.params);
  }

  function start() {
    if (state.started) return;
    state.started = true;
    window.addEventListener('hashchange', onHashChange);
    const route = parseHash(location.hash);
    activate(route.id, route.params);
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

  async function fetchBadges() {
    try {
      if (!window.UI || !window.UI.api) return;
      let date;
      try { if (typeof todayYmd === 'function') date = todayYmd(); } catch (_) {}
      const c = (await window.UI.api.get('/tab_counts', { date })) || {};
      const n = v => Number(v) || 0;
      setBadge('stockcheck', n(c.stock_check_pending) + n(c.mismatch_open));
      setBadge('display', n(c.display_open));
      setBadge('irregular', n(c.irregular_open));
      // 뱃지가 처음 붙으면 탭 폭이 늘어나 끝쪽 활성 탭이 화면 밖으로 밀린다 → 한 번만 다시 맞춘다.
      if (!state.badgeRevealed) { state.badgeRevealed = true; revealActiveTab(); }
    } catch (_) {
      // 백엔드 미배포·네트워크 오류는 조용히 무시한다.
    }
  }

  function refreshBadges() {
    // 조회 중에 또 불리면(방금 저장한 내용이 빠졌을 수 있으므로) 끝난 뒤 한 번 더 조회한다.
    if (state.badgePromise) { state.badgeAgain = true; return state.badgePromise; }
    state.badgePromise = (async () => {
      try {
        do {
          state.badgeAgain = false;
          await fetchBadges();
        } while (state.badgeAgain);
      } finally {
        state.badgePromise = null;
      }
    })();
    return state.badgePromise;
  }

  window.Shell = {
    register,
    start,
    mountTabBar,
    show,
    current: () => state.current || DEFAULT_ID,
    setBadge,
    refreshBadges,
  };
})();
