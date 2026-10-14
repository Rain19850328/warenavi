// tabs/soldout.js — 품절처리 탭
// 재고실사·진열보충에서 품절로 올린 상품을 관리자가 보고 완료 / 보류 / 미반영으로 판단한다(실사반영 탭과 같은 배치).
// 판단은 표시만 남긴다. 재고상태는 바꾸지 않는다.
(function () {
  'use strict';

  const FILTERS = [['all', '전체'], ['wait', '대기'], ['held', '보류'], ['done', '완료'], ['rejected', '미반영']];
  // 판단 버튼. 완료·미반영은 판단을 마친 것(연하게), 보류는 판단 전으로 남는다.
  const DECISIONS = {
    '완료': { tone: 'ok', bucket: 'done' },
    '보류': { tone: 'warn', bucket: 'held' },
    '미반영': { tone: 'muted', bucket: 'rejected' },
  };
  // 줄이 어느 탭에 속하는지: 대기(wait) | 보류(held) | 완료(done) | 미반영(rejected)
  function bucketOf(it) {
    const h = String((it && it.handled_as) ?? '');
    if (!h) return 'wait';
    return (DECISIONS[h] || { bucket: 'done' }).bucket;
  }
  const SOURCE_LABEL = { stock_check: '재고실사', display: '진열보충', review: '실사반영' };
  const EMPTY_TEXT = "등록된 품절 상품이 없습니다. 재고실사에서 '일치'로 센 재고나 실사반영에서 '반영'한 재고가 10개 미만이면 여기에 자동으로 표시됩니다.";
  const HINT_TEXT = '재고상태는 MOPS 자동 계산으로 이후 값이 바뀔 수 있습니다.';

  const state = {
    root: null,
    els: {},
    dateBar: null,
    date: '',            // '' = 날짜 전체(기본), 'YYYY-MM-DD' = 그 날짜만
    items: [],
    loaded: false,
    error: '',
    filter: 'all',
    seq: 0,              // 늦게 도착한 응답 무시용
  };

  const esc = v => UI.esc(v);

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
    // 영어(A~Z) 다음에 한글(가나다) 순(재고실사·진열보충 탭과 같은 규칙).
    return String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
  }
  // 재고실사 탭과 같은 순서: 로케이션 코드 순, 위치 미지정은 맨 뒤. 판단한 줄도 따로 뒤로 보내지 않는다.
  function sortItems(list) {
    const none = it => (locText(it.location_code) === '위치 미지정' ? 1 : 0);
    return list.slice().sort((a, b) =>
      none(a) - none(b) || cmp(a.location_code, b.location_code) || cmp(a.item_code, b.item_code)
      || cmp(a.soldout_date, b.soldout_date));
  }

  /* ---------- styles ---------- */
  function injectStyle() {
    if (document.getElementById('tab-soldout-style')) return;
    const style = document.createElement('style');
    style.id = 'tab-soldout-style';
    style.textContent = `
.tab-soldout .so-summary{ margin:0 0 10px; padding:8px 10px; border-radius:10px; background:#f1f5f9; font-size:13px; line-height:1.6; color:#334155; }
.tab-soldout .so-summary b{ color:#0f172a; }
.tab-soldout .so-top{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.tab-soldout .so-loc{ margin-right:2px; font-size:16px; font-weight:800; color:#0f172a; }
.tab-soldout .so-name{ appearance:none; display:block; width:100%; margin-top:6px; padding:0; border:0; background:none; cursor:pointer; text-align:left; font-family:inherit; }
.tab-soldout .so-stock{ display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px; margin-top:8px; font-size:13px; color:#64748b; }
.tab-soldout .so-stock__title{ font-weight:700; color:#334155; }
.tab-soldout .so-stock b{ margin-left:4px; font-size:16px; color:#0f172a; }
.tab-soldout .so-racks{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:6px; }
.tab-soldout .so-rack{ display:inline-flex; align-items:center; gap:6px; min-height:36px; padding:0 10px; border:1px solid #bae6fd; border-radius:10px; background:#e0f2fe; color:#075985; font-size:13px; font-weight:600; }
.tab-soldout .so-rack b{ font-size:14px; color:#0369a1; }
.tab-soldout .so-total{ display:flex; flex-direction:column; align-items:flex-end; min-width:64px; line-height:1.1; }
.tab-soldout .so-total__label{ font-size:12px; font-weight:600; color:#64748b; }
.tab-soldout .so-total__num{ font-size:30px; font-weight:800; color:#0f172a; }
.tab-soldout .so-total__num.is-zero{ color:#b91c1c; }
.tab-soldout .wl-row.is-done{ opacity:1; }
.tab-soldout .wl-row.is-done .wl-main{ opacity:.55; }
.tab-soldout .btn-sm, .tab-soldout .btn-primary, .tab-soldout .btn-ghost{ min-height:40px; }
.tab-soldout .seg > button{ min-height:40px; padding:0 4px; }
.tab-soldout .so-filter{ flex:1 1 100%; }
.tab-soldout .so-cnt{ margin-left:3px; font-weight:500; opacity:.75; }
.tab-soldout .so-status{ display:flex; align-items:center; gap:8px; margin-top:8px; font-size:13px; }
.tab-soldout .so-status__title{ font-weight:700; color:#334155; }
.tab-soldout .so-status__val{ padding:4px 12px; border-radius:10px; font-size:16px; font-weight:800; background:#f1f5f9; color:#334155; }
.tab-soldout .so-status--ok{ background:#dcfce7; color:#166534; }
.tab-soldout .so-status--warn{ background:#fef3c7; color:#92400e; }
.tab-soldout .so-status--info{ background:#e0f2fe; color:#075985; }
.tab-soldout .so-status--danger{ background:#fee2e2; color:#b91c1c; }
.tab-soldout .so-foot{ padding-top:8px; border-top:1px dashed #e2e8f0; }
.tab-soldout .so-foot .so-act{ flex:1 1 88px; min-height:44px; font-size:15px; }
.tab-soldout .so-revert{ min-height:36px; margin-left:auto; font-size:13px; font-weight:600; }
.tab-soldout .so-hint{ margin:12px 2px 0; font-size:12px; line-height:1.5; color:#64748b; }
.tab-soldout .so-error{ text-align:center; }
`;
    document.head.append(style);
  }

  /* ---------- html builders ---------- */
  function rowHtml(it) {
    const cur = String(it.stock_status ?? '');
    const sources = (Array.isArray(it.sources) && it.sources.length ? it.sources : [it.source]).filter(Boolean);
    const sourceChips = sources.map(s => UI.chip(SOURCE_LABEL[s] || s, 'muted')).join('');
    const handled = String(it.handled_as ?? '');
    const held = handled === '보류';
    const handledChip = handled ? UI.chip(handled, (DECISIONS[handled] || { tone: 'ok' }).tone) : UI.chip('대기', 'warn');
    const handledLine = handled
      ? `<div class="wl-meta">${esc(handled)}: ${esc(it.handled_by_name || '-')}${it.handled_at ? ' · ' + esc(UI.fmtDateTime(it.handled_at)) : ''}</div>`
      : '';
    // 판단을 마친 줄은 '판단 취소'만, 그 밖에는 세 버튼(보류 중이면 가운데가 '보류 해제').
    const actions = handled && !held
      ? '<button type="button" class="btn-ghost btn-sm so-revert" data-act="revert">판단 취소</button>'
      : `<button type="button" class="btn-primary so-act" data-act="decide" data-value="완료">완료</button>
          ${held
            ? '<button type="button" class="btn-ghost so-act" data-act="revert">보류 해제</button>'
            : '<button type="button" class="btn-sm so-act" data-act="decide" data-value="보류">보류</button>'}
          <button type="button" class="btn-danger so-act" data-act="decide" data-value="미반영">미반영</button>`;
    const added = `등록: ${esc(it.added_by_name || '-')}${it.created_at ? ' · ' + esc(UI.fmtDateTime(it.created_at)) : ''}`;
    const last = it.last_set_status || it.last_set_at
      ? `<div class="wl-meta">최근 변경: ${esc(it.last_set_status || '-')} · ${esc(it.last_set_by_name || '-')}${it.last_set_at ? ' · ' + esc(UI.fmtDateTime(it.last_set_at)) : ''}</div>`
      : '';
    // 진열보충·재고실사 탭과 같은 재고정보 표기: SR1은 수량(없으면 '없음'), SR2는 있음/없음.
    const racks = (Array.isArray(it.racks) ? it.racks : []).filter(x => x && x.rack_code);
    const rowQty = row => racks
      .filter(x => String(x.rack_code).toUpperCase().startsWith(`${row}-`))
      .reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
    const sr1 = rowQty('SR1');
    const sr3 = rowQty('SR3');
    const rackBoxes = racks.map(x =>
      `<span class="so-rack">${esc(x.rack_code)}<b>${UI.isPresenceRack(x.rack_code) ? '있음' : `${esc(UI.num(x.qty))}개`}</b></span>`).join('');
    const totalNum = it.stock_today === null || it.stock_today === undefined || it.stock_today === '' ? null : Number(it.stock_today);
    const total = `<div class="so-total"><span class="so-total__label">총 재고</span><span class="so-total__num${totalNum === 0 ? ' is-zero' : ''}">${esc(UI.num(totalNum))}</span></div>`;
    return `
      <li class="wl-row${it.disabled ? ' is-done' : ''}" data-id="${esc(it.id)}">
        <div class="wl-main">
          <div class="so-top">
            <span class="so-loc">${esc(locText(it.location_code))}</span>
            ${sourceChips}
            ${it.item_status ? UI.chip(`판매등급 ${it.item_status}`, 'muted') : ''}
          </div>
          <button type="button" class="wl-name so-name" data-act="open-item" title="상품검색에서 보기">${esc(it.item_name || it.item_code)}</button>
          <div class="so-stock"><span class="so-stock__title">재고정보</span>
            <span>SR1:<b>${sr1 > 0 ? esc(UI.num(sr1)) : '없음'}</b></span>
            <span>SR2:<b>${racks.some(x => UI.isPresenceRack(x.rack_code)) ? '있음' : '없음'}</b></span>
            ${sr3 > 0 ? `<span>SR3:<b>${esc(UI.num(sr3))}</b></span>` : ''}</div>
          <div class="so-racks">${rackBoxes || UI.chip('스토리지렉 재고 없음', 'muted')}</div>
          <div class="so-status"><span class="so-status__title">재고상태</span><b class="so-status__val so-status--${statusTone(cur)}">${esc(cur || '상태 없음')}</b></div>
          <div class="wl-meta"><span>${added}</span></div>
          ${last}
          ${handledLine}
        </div>
        <div class="wl-side">${total}${handledChip}</div>
        <div class="wl-actions so-foot">
          ${actions}
        </div>
      </li>`;
  }

  /* ---------- render ---------- */
  function bucketCounts() {
    const c = { all: state.items.length, wait: 0, held: 0, done: 0, rejected: 0 };
    for (const it of state.items) c[bucketOf(it)]++;
    return c;
  }

  function renderFilter() {
    const el = state.els.filter;
    if (!el) return;
    const counts = bucketCounts();
    el.querySelectorAll('button').forEach(btn => {
      const on = btn.dataset.filter === state.filter;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const cnt = btn.querySelector('[data-cnt]');
      if (cnt) cnt.textContent = state.loaded ? String(counts[btn.dataset.filter] ?? 0) : '';
    });
  }

  function renderSummary() {
    const el = state.els.summary;
    if (!el) return;
    if (!state.loaded || !state.items.length) { el.hidden = true; el.innerHTML = ''; return; }
    const c = bucketCounts();
    el.hidden = false;
    el.innerHTML = `총 <b>${esc(UI.num(c.all))}</b>건 · 대기 <b>${esc(UI.num(c.wait))}</b> · 보류 <b>${esc(UI.num(c.held))}</b> · 완료 <b>${esc(UI.num(c.done))}</b> · 미반영 <b>${esc(UI.num(c.rejected))}</b>`;
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
      body.innerHTML = `<p class="empty">${esc(state.date ? `${state.date} 에 ${EMPTY_TEXT}` : EMPTY_TEXT)}</p>`;
      return;
    }
    const shown = state.items.filter(it => state.filter === 'all' || bucketOf(it) === state.filter);
    const list = shown.length
      ? `<ul class="wl-list">${sortItems(shown).map(rowHtml).join('')}</ul>`
      : '<p class="empty">해당하는 상품이 없습니다.</p>';
    body.innerHTML = `${list}<p class="so-hint">${esc(HINT_TEXT)}</p>`;
  }

  function renderAll() {
    renderFilter();
    renderSummary();
    renderList();
  }

  /* ---------- data ---------- */
  async function load() {
    const seq = ++state.seq;
    const date = state.date;
    if (!state.loaded) { state.error = ''; renderAll(); }
    try {
      const res = await UI.api.get('/soldout_items', date ? { date } : { all: 1 });
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
  // 판단 버튼(완료 · 보류 · 미반영). 재고상태는 그대로 두고 판단 표시만 남긴다.
  async function decide(btn, id, value) {
    const it = findItem(id);
    if (!it || !DECISIONS[value] || value === String(it.handled_as ?? '')) return;
    await UI.busy(btn, async () => {
      await UI.api.post('/soldout_items/decide', { id: it.id, decision: value });
      UI.toast({ '완료': '완료로 표시했습니다', '보류': '보류로 표시했습니다', '미반영': '미반영으로 표시했습니다' }[value], value === '완료' ? 'ok' : 'info');
      await load();
      Shell.refreshBadges();
    });
  }

  // 판단 취소 / 보류 해제: 판단 전으로 되돌린다.
  async function revertStatus(btn, id) {
    const it = findItem(id);
    if (!it || !it.handled_as) return;
    await UI.busy(btn, async () => {
      await UI.api.post('/soldout_items/revert', { id: it.id });
      UI.toast('대기 상태로 되돌렸습니다', 'info');
      await load();
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
    } else if (act === 'decide') {
      decide(btn, id, btn.dataset.value);
    } else if (act === 'revert') {
      revertStatus(btn, id);
    }
  }

  /* ---------- lifecycle ---------- */
  function mount(root) {
    injectStyle();
    state.root = root;
    root.classList.add('tab-soldout');
    root.innerHTML = `
      <div class="view-head"><h2>품절처리</h2><div data-role="datebar"></div></div>
      <div class="view-toolbar">
        <div class="seg so-filter" data-role="filter" role="group" aria-label="목록 필터">
          ${FILTERS.map(([key, label]) => `<button type="button" data-act="filter" data-filter="${key}">${label}<span class="so-cnt" data-cnt="${key}"></span></button>`).join('')}
        </div>
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
      allowAll: true,
      onChange: ymd => {
        setDate(ymd);
        load();
      },
    });
    root.addEventListener('click', onClick);
    renderAll();
  }

  function onShow(params) {
    // 날짜를 지정해서 들어온 경우에만 그 날짜로 바꾼다. 그 밖에는 보던 범위(기본: 전체)를 유지한다.
    if (params && isYmd(params.date) && params.date !== state.date) {
      setDate(params.date);
      state.dateBar.set(params.date);
    }
    load();
  }

  function onRemoteChange() {
    if (state.loaded) load();
    return true;
  }

  Shell.register({ id: 'soldout', label: '품절처리', mount, onShow, onHide() {}, onRemoteChange });
})();
