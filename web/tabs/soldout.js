// tabs/soldout.js — 품절관리 탭
// 재고확인·진열보충에서 품절로 올린 상품의 재고상태를 담당자가 정리한다.
(function () {
  'use strict';

  const FILTERS = [['all', '전체'], ['open', '처리 필요'], ['closed', '주문완료·단종']];
  const QUICK = ['주문필요', '주문완료'];
  const SOURCE_LABEL = { stock_check: '재고확인', display: '진열보충' };
  const EMPTY_TEXT = "이 날짜에 등록된 품절 상품이 없습니다. 재고확인·진열보충에서 '품절관리에 추가'를 누르면 여기에 표시됩니다.";
  const HINT_TEXT = '재고상태는 MOPS 자동 계산으로 이후 값이 바뀔 수 있습니다.';

  const state = {
    root: null,
    els: {},
    dateBar: null,
    date: '',
    followToday: true,   // 사용자가 다른 날짜를 고르지 않았으면 날짜가 바뀔 때 오늘을 따라간다
    items: [],
    loaded: false,
    error: '',
    filter: 'all',
    seq: 0,              // 늦게 도착한 응답 무시용
    statuses: [],        // /item_options 의 stock_statuses (한 번만 조회)
    optionsPromise: null,
  };

  const esc = v => UI.esc(v);

  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function locText(v) {
    const s = String(v ?? '').trim();
    return !s || s === '00' ? '위치 미지정' : s;
  }
  function statusTone(status) {
    const s = String(status ?? '');
    if (s === '안정') return 'ok';
    if (s === '주문필요') return 'warn';
    if (s === '주문완료') return 'info';
    if (s === '품절') return 'danger';
    if (s === '단종') return 'muted';
    if (s.includes('보류')) return 'warn';
    return 'muted';
  }
  function findItem(id) { return state.items.find(it => String(it.id) === String(id)); }
  function rowIdOf(el) {
    const li = el && el.closest ? el.closest('.wl-row') : null;
    return li ? li.dataset.id : null;
  }
  function cmp(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true });
  }
  function sortItems(list) {
    return list.slice().sort((a, b) =>
      (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code));
  }

  /* ---------- styles ---------- */
  function injectStyle() {
    if (document.getElementById('tab-soldout-style')) return;
    const style = document.createElement('style');
    style.id = 'tab-soldout-style';
    style.textContent = `
.tab-soldout .so-summary{ margin:0 0 10px; padding:8px 10px; border-radius:10px; background:#f1f5f9; font-size:13px; line-height:1.6; color:#334155; }
.tab-soldout .so-summary b{ color:#0f172a; }
.tab-soldout .so-code{ appearance:none; display:inline-block; min-height:32px; padding:4px 0; border:0; background:none; color:#0369a1; font:inherit; font-size:13px; text-decoration:underline; text-align:left; cursor:pointer; }
.tab-soldout .so-loc{ font-weight:700; color:#0f172a; }
.tab-soldout .wl-row.is-done{ opacity:1; }
.tab-soldout .wl-row.is-done .wl-main{ opacity:.55; }
.tab-soldout .btn-sm, .tab-soldout .btn-primary, .tab-soldout .btn-ghost{ min-height:44px; }
.tab-soldout .seg > button{ min-height:44px; }
.tab-soldout .so-filter{ flex:1 1 260px; }
.tab-soldout .so-control{ padding-top:8px; border-top:1px dashed #e2e8f0; }
.tab-soldout .so-control-label{ flex:1 0 100%; font-size:12px; font-weight:600; color:#475569; }
.tab-soldout .so-pick{ flex:1 1 200px; display:flex; gap:8px; min-width:0; }
.tab-soldout .so-pick select{ flex:1 1 auto; min-width:0; height:44px; padding:0 8px; border:1px solid #cbd5e1; border-radius:10px; background:#fff; color:#0f172a; font:inherit; font-size:16px; }
.tab-soldout .so-pick select:focus{ outline:none; border-color:#38bdf8; box-shadow:0 0 0 3px rgba(56,189,248,.25); }
.tab-soldout .so-foot{ justify-content:flex-end; }
.tab-soldout .so-remove{ min-height:36px; font-size:12px; font-weight:500; color:#64748b; }
.tab-soldout .so-hint{ margin:12px 2px 0; font-size:12px; line-height:1.5; color:#64748b; }
.tab-soldout .so-error{ text-align:center; }
`;
    document.head.append(style);
  }

  /* ---------- html builders ---------- */
  function controlHtml(it) {
    const cur = String(it.stock_status ?? '');
    const quick = QUICK.map(v =>
      `<button type="button" class="btn-sm" data-act="quick" data-value="${esc(v)}"${v === cur ? ' disabled' : ''}>${esc(v)}</button>`
    ).join('');
    let pick = '';
    if (state.statuses.length) {
      const options = state.statuses.includes(cur) || !cur ? state.statuses : [cur].concat(state.statuses);
      pick = `
        <div class="so-pick">
          <select data-role="status-select" aria-label="재고상태 선택">
            ${cur ? '' : '<option value="" selected>상태 선택</option>'}
            ${options.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <button type="button" class="btn-primary" data-act="apply">변경</button>
        </div>`;
    }
    return `<div class="wl-actions so-control"><span class="so-control-label">재고상태 변경</span>${quick}${pick}</div>`;
  }

  function rowHtml(it) {
    const cur = String(it.stock_status ?? '');
    const sources = (Array.isArray(it.sources) && it.sources.length ? it.sources : [it.source]).filter(Boolean);
    const sourceChips = sources.map(s => UI.chip(SOURCE_LABEL[s] || s, 'muted')).join('');
    let statusChip;
    if (it.disabled) {
      statusChip = cur === '주문완료' ? UI.chip('주문완료 · 입고 대기', 'info') : UI.chip(cur || '변경 불가', statusTone(cur));
    } else {
      statusChip = UI.chip(cur || '상태 없음', statusTone(cur));
    }
    const added = `등록: ${esc(it.added_by_name || '-')}${it.created_at ? ' · ' + esc(UI.fmtDateTime(it.created_at)) : ''}`;
    const last = it.last_set_status || it.last_set_at
      ? `<div class="wl-meta">최근 변경: ${esc(it.last_set_status || '-')} · ${esc(it.last_set_by_name || '-')}${it.last_set_at ? ' · ' + esc(UI.fmtDateTime(it.last_set_at)) : ''}</div>`
      : '';
    return `
      <li class="wl-row${it.disabled ? ' is-done' : ''}" data-id="${esc(it.id)}">
        <div class="wl-main">
          <button type="button" class="wl-code so-code" data-act="open-item">${esc(it.item_code)}</button>
          <div class="wl-name">${esc(it.item_name)}</div>
          <div class="wl-meta">
            <span class="so-loc">${esc(locText(it.location_code))}</span>
            <span>재고 ${esc(UI.num(it.stock_today))}</span>
            ${it.item_status ? UI.chip(`판매등급 ${it.item_status}`, 'muted') : ''}
            ${sourceChips}
          </div>
          <div class="wl-meta"><span>등록 시 상태: ${esc(it.status_at_add || '-')}</span><span>${added}</span></div>
          ${last}
        </div>
        <div class="wl-side">${statusChip}</div>
        ${it.disabled ? '' : controlHtml(it)}
        <div class="wl-actions so-foot">
          <button type="button" class="btn-ghost btn-sm so-remove" data-act="remove">목록에서 제거</button>
        </div>
      </li>`;
  }

  /* ---------- render ---------- */
  function renderFilter() {
    const el = state.els.filter;
    if (!el) return;
    el.querySelectorAll('button').forEach(btn => {
      const on = btn.dataset.filter === state.filter;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderSummary() {
    const el = state.els.summary;
    if (!el) return;
    if (!state.loaded || !state.items.length) { el.hidden = true; el.innerHTML = ''; return; }
    const closed = state.items.filter(it => it.disabled).length;
    el.hidden = false;
    el.innerHTML = `총 <b>${esc(UI.num(state.items.length))}</b>건 · 처리 필요 <b>${esc(UI.num(state.items.length - closed))}</b> · 주문완료·단종 <b>${esc(UI.num(closed))}</b>`;
  }

  function renderList() {
    const body = state.els.body;
    if (!body) return;
    if (!state.loaded) {
      body.innerHTML = state.error
        ? `<div class="so-error"><p class="empty">불러오지 못했습니다<br>${esc(state.error)}</p>
            <button type="button" class="btn-primary" data-act="reload">다시 시도</button></div>`
        : '<p class="empty">불러오는 중…</p>';
      return;
    }
    if (!state.items.length) {
      body.innerHTML = `<p class="empty">${esc(EMPTY_TEXT)}</p>`;
      return;
    }
    const shown = state.items.filter(it =>
      state.filter === 'open' ? !it.disabled : state.filter === 'closed' ? !!it.disabled : true);
    const list = shown.length
      ? `<ul class="wl-list">${sortItems(shown).map(rowHtml).join('')}</ul>`
      : `<p class="empty">${state.filter === 'open' ? '처리가 필요한 상품이 없습니다.' : '주문완료·단종 상태인 상품이 없습니다.'}</p>`;
    body.innerHTML = `${list}<p class="so-hint">${esc(HINT_TEXT)}</p>`;
  }

  function renderAll() {
    renderFilter();
    renderSummary();
    renderList();
  }

  /* ---------- data ---------- */
  // 선택지는 한 번만 받아 둔다. 실패하면 다음 조회 때 다시 시도하고, 그동안은 빠른 버튼만 보인다.
  function loadOptions() {
    if (state.statuses.length) return Promise.resolve();
    if (!state.optionsPromise) {
      state.optionsPromise = UI.api.get('/item_options')
        .then(res => {
          const list = Array.isArray(res && res.stock_statuses) ? res.stock_statuses : [];
          state.statuses = list.map(v => String(v ?? '')).filter(Boolean);
        })
        .catch(() => {})
        .then(() => { state.optionsPromise = null; });
    }
    return state.optionsPromise;
  }

  async function load() {
    const seq = ++state.seq;
    const date = state.date;
    if (!state.loaded) { state.error = ''; renderAll(); }
    try {
      const [res] = await Promise.all([UI.api.get('/soldout_items', { date }), loadOptions()]);
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
  }

  /* ---------- actions ---------- */
  async function changeStatus(btn, id, value) {
    const it = findItem(id);
    if (!it || it.disabled) return;
    if (!value) { UI.toast('변경할 재고상태를 선택해 주세요', 'info'); return; }
    if (value === String(it.stock_status ?? '')) { UI.toast(`이미 '${value}' 상태입니다`, 'info'); return; }
    if (value === '단종') {
      const ok = await UI.confirm('단종으로 변경할까요? 이후 이 화면에서는 상태를 바꿀 수 없습니다.');
      if (!ok) return;
    }
    await UI.busy(btn, async () => {
      const res = await UI.api.post('/stock_status', { item_code: it.item_code, value, soldout_id: it.id });
      UI.toast(`재고상태를 '${(res && res.new) || value}'(으)로 변경했습니다`, 'ok');
      // 실제 상태와 비활성 여부는 서버 값으로 다시 받는다.
      await load();
      Shell.refreshBadges();
    });
  }

  async function removeItem(btn, id) {
    const it = findItem(id);
    if (!it) return;
    const ok = await UI.confirm(`'${it.item_name || it.item_code}'을(를) 품절 목록에서 제거할까요?\n재고상태는 바뀌지 않습니다.`);
    if (!ok) return;
    await UI.busy(btn, async () => {
      await UI.api.post('/soldout_items/remove', { id: it.id });
      UI.toast('목록에서 제거했습니다', 'ok');
      state.items = state.items.filter(row => String(row.id) !== String(id));
      renderSummary();
      renderList();
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
    if (act === 'open-item') {
      const it = findItem(id);
      if (it) Shell.show('items', { code: it.item_code });
    } else if (act === 'quick') {
      changeStatus(btn, id, btn.dataset.value);
    } else if (act === 'apply') {
      const select = btn.closest('.wl-row').querySelector('[data-role="status-select"]');
      changeStatus(btn, id, select ? select.value : '');
    } else if (act === 'remove') {
      removeItem(btn, id);
    }
  }

  /* ---------- lifecycle ---------- */
  function mount(root) {
    injectStyle();
    state.root = root;
    state.date = today();
    root.classList.add('tab-soldout');
    root.innerHTML = `
      <div class="view-head"><h2>품절관리</h2><div data-role="datebar"></div></div>
      <div class="view-toolbar">
        <div class="seg so-filter" data-role="filter" role="group" aria-label="목록 필터">
          ${FILTERS.map(([key, label]) => `<button type="button" data-act="filter" data-filter="${key}">${label}</button>`).join('')}
        </div>
        <button type="button" class="btn-sm" data-act="reload">새로고침</button>
      </div>
      <p class="so-summary" data-role="summary" hidden></p>
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

  Shell.register({ id: 'soldout', label: '품절관리', mount, onShow, onHide() {} });
})();
