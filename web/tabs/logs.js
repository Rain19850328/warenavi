// tabs/logs.js — 작업로그 탭: 앱에서 일어난 모든 작업 기록 조회 (SKU코드 · 상품명 · 로케이션코드 검색)
(function () {
  'use strict';

  const PAGE_SIZE = 100;
  const SEARCH_DEBOUNCE_MS = 300;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  // 분류 필터(클라이언트 측). 'all'은 전부.
  const CATEGORIES = [
    { id: 'all', label: '전체' },
    { id: 'item', label: '상품수정' },
    { id: 'stockcheck', label: '재고확인' },
    { id: 'display', label: '진열보충' },
    { id: 'irregular', label: '이형포장' },
    { id: 'soldout', label: '품절관리' },
    { id: 'movement', label: '랙 입출고' },
  ];

  const FIELD_LABELS = {
    name: '상품명',
    location: '로케이션',
    inbound_w: '입고 가로', inbound_l: '입고 세로', inbound_h: '입고 높이',
    outbound_w: '출고 가로', outbound_l: '출고 세로', outbound_h: '출고 높이',
    stock_status: '재고상태',
    boxtype: '포장타입',
    carrier_type: '운반상자',
  };

  const SOURCE_LABELS = {
    item: '상품조회',
    irregular: '이형포장',
    auto_low_stock: '자동',
    stock_check: '재고확인',
    display: '진열보충',
  };

  // app.js formatMovementType 과 같은 표기
  const MOVEMENT_LABELS = {
    inbound: ['입고', 'ok'],
    outbound: ['출고', 'warn'],
    move: ['이동', 'info'],
    set_location: ['위치변경', 'muted'],
    new_inbound_display: ['신규입고 진열', 'info'],
  };

  /* ---------- 요약 문구 ---------- */
  function isBlank(v) { return v === null || v === undefined || v === ''; }
  function text(v) {
    if (isBlank(v)) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return ''; } }
    return String(v);
  }
  function val(v, emptyLabel) { return text(v) || emptyLabel || '없음'; }
  function count(v) {
    if (isBlank(v)) return '-';
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
  }
  function joinParts(parts) { return parts.map(text).filter(Boolean).join(' · '); }
  function sourceLabel(v) {
    const key = text(v);
    return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, key) ? SOURCE_LABELS[key] : key;
  }
  function withSource(head, source) {
    const label = sourceLabel(source);
    return label ? `${head} (${label})` : head;
  }
  function detailOf(log) {
    let d = log ? log.detail : null;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  }

  const ACTIONS = {
    item_update: d => {
      const changes = Array.isArray(d.changes) ? d.changes.filter(c => c && typeof c === 'object') : [];
      return ['상품수정', 'info', 'item', changes.map(c => {
        const key = text(c.field);
        const label = Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) ? FIELD_LABELS[key] : (key || '항목');
        return `${label}: ${val(c.old)} → ${val(c.new)}`;
      }).join(' · ')];
    },
    stock_status_change: d => {
      const viaSoldout = d.via === 'soldout';
      return ['재고상태', 'warn', viaSoldout ? 'soldout' : 'item',
        `재고상태: ${val(d.old)} → ${val(d.new)}${viaSoldout ? ' (품절관리)' : ''}`];
    },
    stock_check_auto: d => ['재고확인', 'muted', 'stockcheck', `자동 대상 ${count(d.count)}건 추가`],
    stock_check_request: d => ['재고확인', 'info', 'stockcheck', joinParts([withSource('요청', d.source), d.note])],
    stock_check_match: d => ['재고확인', 'ok', 'stockcheck', `일치 (재고 ${count(d.db_stock)})`],
    stock_check_mismatch: d => ['재고확인', 'danger', 'stockcheck',
      joinParts([`불일치: DB ${count(d.db_stock)} / 실재고 ${count(d.counted_qty)}`, d.reason])],
    stock_check_reset: () => ['재고확인', 'muted', 'stockcheck', '확인 취소'],
    stock_check_resolve: d => ['재고확인', 'ok', 'stockcheck', joinParts(['처리완료', d.note])],
    stock_check_reopen: () => ['재고확인', 'warn', 'stockcheck', '처리 취소'],
    display_request: d => ['진열보충', 'info', 'display', joinParts(['진열 요청', d.note])],
    display_done: () => ['진열보충', 'ok', 'display', '진열 완료'],
    display_reopen: () => ['진열보충', 'warn', 'display', '완료 취소'],
    irregular_import: d => {
      const skipped = Array.isArray(d.skipped) ? d.skipped.map(text).filter(Boolean) : [];
      let skippedText = '';
      if (skipped.length) {
        const shown = skipped.slice(0, 5).join(', ');
        skippedText = `상품 DB에 없는 코드: ${shown}${skipped.length > 5 ? ` 외 ${skipped.length - 5}건` : ''}`;
      }
      return ['이형포장', 'muted', 'irregular', joinParts([
        `MOPS 이형리스트 저장: 묶음 신규 ${count(d.inserted)} / 갱신 ${count(d.updated)} / 제외표시 ${count(d.stale)} / 삭제 ${count(d.deleted)}`,
        skippedText,
      ])];
    },
    irregular_status: d => ['이형포장', 'info', 'irregular', joinParts([`상태: ${val(d.old)} → ${val(d.new)}`, d.bundle_no ? `묶음 ${text(d.bundle_no)}` : ''])],
    irregular_box_count: d => ['이형포장', 'muted', 'irregular',
      joinParts([`예상박스: ${val(d.old, '미입력')} → ${val(d.new, '미입력')}`, d.bundle_no ? `묶음 ${text(d.bundle_no)}` : ''])],
    soldout_add: d => ['품절관리', 'danger', 'soldout', withSource('품절관리 등록', d.source)],
    soldout_remove: () => ['품절관리', 'muted', 'soldout', '품절관리에서 제거'],
  };

  function describeMovement(log, d) {
    const action = text(log.action);
    const known = Object.prototype.hasOwnProperty.call(MOVEMENT_LABELS, action) ? MOVEMENT_LABELS[action] : null;
    let label = known ? known[0] : (action || '-');
    const payloadSource = d.source || (d.payload && typeof d.payload === 'object' ? d.payload.source : '');
    if (action === 'inbound' && payloadSource === 'new_inbound') label = '신규입고 입고';
    const qty = action === 'set_location' || isBlank(log.quantity) ? '' : `수량 ${count(log.quantity)}`;
    return { label, tone: known ? known[1] : 'muted', cat: 'movement', text: joinParts([log.rack_text, qty]) };
  }

  // 어떤 detail이 와도 던지지 않는다. 모르는 action은 이름만 보여준다.
  function describe(log) {
    const action = log && !isBlank(log.action) ? text(log.action) : '';
    const fallback = { label: action || '-', tone: 'muted', cat: '', text: '' };
    try {
      if (!log || typeof log !== 'object') return fallback;
      const d = detailOf(log);
      if (log.kind === 'movement') return describeMovement(log, d);
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return fallback;
      const [label, tone, cat, summary] = ACTIONS[action](d);
      return { label, tone, cat, text: text(summary) };
    } catch (_) {
      return fallback;
    }
  }

  /* ---------- 날짜 ---------- */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function localYmd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    return localYmd(new Date());
  }
  function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function shiftYmd(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    return localYmd(new Date(y, m - 1, d + days));
  }
  // created_at(UTC ISO) → 브라우저 현지 시각 기준 {day:'YYYY-MM-DD', time:'HH:MM'}
  function localParts(iso) {
    const d = isBlank(iso) ? null : new Date(iso);
    if (!d || Number.isNaN(d.getTime())) return { day: '', time: '--:--' };
    return { day: localYmd(d), time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
  }
  function dayHeading(day) {
    if (!day) return '날짜 없음';
    const [y, m, d] = day.split('-').map(Number);
    return `${day} (${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
  }

  /* ---------- 상태 ---------- */
  const st = {
    q: '',
    from: '',
    to: '',
    cat: 'all',
    items: [],          // 지금까지 받은 LOG (최신순)
    ids: new Set(),
    next: null,         // next_before
    seq: 0,             // 조회 세대(늦게 도착한 응답 버리기)
    loading: false,
    loadingMore: false,
    error: '',
    moreError: '',
    loaded: false,
  };
  const els = {};
  let searchTimer = null;

  function setRange(kind) {
    const t = today();
    if (kind === 'today') { st.from = t; st.to = t; }
    else if (kind === '7d') { st.from = shiftYmd(t, -6); st.to = t; }
    else { st.from = ''; st.to = ''; }
  }
  function rangeKind() {
    const t = today();
    if (!st.from && !st.to) return 'all';
    if (st.from === t && st.to === t) return 'today';
    if (st.from === shiftYmd(t, -6) && st.to === t) return '7d';
    return '';
  }
  function matchesCat(log) { return st.cat === 'all' || describe(log).cat === st.cat; }
  function visibleCount() {
    if (st.cat === 'all') return st.items.length;
    let n = 0;
    for (const log of st.items) if (matchesCat(log)) n++;
    return n;
  }

  /* ---------- 렌더 ---------- */
  const CSS = `
.tab-logs .lg-headside{ display:flex; align-items:center; gap:8px; }
.tab-logs .lg-count{ font-size:13px; color:#64748b; }
.tab-logs .lg-search{ flex-wrap:nowrap; }
.tab-logs .lg-searchbox{ position:relative; flex:1 1 auto; min-width:0; display:flex; }
.tab-logs .lg-searchbox input{ flex:1 1 auto; width:100%; padding-right:40px; }
.tab-logs .lg-clear{
  appearance:none; position:absolute; right:2px; top:2px; width:36px; height:36px; padding:0;
  border:0; border-radius:8px; background:transparent; color:#64748b; font-size:15px; cursor:pointer;
}
.tab-logs .lg-clear[hidden]{ display:none; }
.tab-logs .lg-range input[type="date"]{ flex:1 1 120px; padding:0 6px; }
.tab-logs .lg-range .lg-tilde{ flex:0 0 auto; color:#64748b; }
.tab-logs .lg-cats{ margin-bottom:10px; overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
.tab-logs .lg-cats::-webkit-scrollbar{ display:none; }
.tab-logs .lg-cats .seg{ max-width:none; }
.tab-logs .lg-cats .seg > button{ padding:0 10px; }
.tab-logs .lg-banner{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  margin-bottom:10px; padding:6px 6px 6px 12px;
  border:1px solid #bae6fd; border-radius:10px; background:#f0f9ff;
  font-size:14px; line-height:1.4; color:#075985;
}
.tab-logs .lg-banner[hidden]{ display:none; }
.tab-logs .lg-banner__text{ min-width:0; word-break:break-all; }
.tab-logs .lg-banner .btn-sm{ flex:0 0 auto; min-height:32px; }
.tab-logs .lg-list.is-loading{ opacity:.5; pointer-events:none; }
.tab-logs .lg-day{ margin-bottom:10px; border:1px solid #e2e8f0; border-radius:12px; background:#fff; }
.tab-logs .lg-day__head{
  position:sticky; top:0; z-index:2;
  margin:0; padding:6px 12px;
  border-bottom:1px solid #e2e8f0; border-radius:11px 11px 0 0; background:#f1f5f9;
  font-size:13px; font-weight:700; line-height:1.4; color:#334155;
}
.tab-logs .lg-day .wl-list{ gap:0; grid-template-columns:minmax(0, 1fr); }
.tab-logs .lg-row{
  flex-wrap:nowrap; gap:8px; min-width:0; padding:8px 12px;
  border:0; border-top:1px solid #f1f5f9; border-radius:0; background:transparent;
}
.tab-logs .lg-row:first-child{ border-top:0; }
.tab-logs .lg-time{
  flex:0 0 auto; width:38px; padding-top:3px;
  font-size:12px; line-height:1.5; font-variant-numeric:tabular-nums; color:#64748b;
}
.tab-logs .lg-top{ display:flex; align-items:flex-start; gap:6px; min-width:0; }
.tab-logs .lg-top .chip{ flex:0 0 auto; }
.tab-logs .lg-sum{ flex:1 1 auto; min-width:0; padding-top:1px; font-size:14px; line-height:1.5; color:#0f172a; word-break:keep-all; overflow-wrap:anywhere; }
.tab-logs .lg-row .wl-meta{ flex-wrap:nowrap; min-width:0; gap:6px; }
.tab-logs .lg-code{
  appearance:none; flex:0 0 auto; min-width:0; max-width:55%;
  margin:-6px 0; padding:6px 0; border:0; background:none;
  font:inherit; font-size:12px; font-weight:700; color:#0369a1; text-decoration:underline;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;
}
.tab-logs .lg-name{ flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tab-logs .lg-loc{
  flex:0 0 auto; padding:0 6px;
  border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc; color:#475569; white-space:nowrap;
}
.tab-logs .lg-actor{
  flex:0 0 auto; max-width:40%; margin-left:auto;
  display:inline-flex; align-items:center; gap:4px; color:#475569; white-space:nowrap;
}
.tab-logs .lg-actor .chip{ padding:0 6px; font-size:11px; }
.tab-logs .lg-foot{ display:grid; justify-items:center; gap:6px; padding:4px 0 12px; font-size:13px; color:#64748b; }
.tab-logs .lg-foot .btn-sm{ min-width:160px; }
.tab-logs .lg-errmsg{ display:block; margin:4px 0 12px; font-size:12px; color:#94a3b8; word-break:break-word; }
@media (min-width: 640px){
  .tab-logs .lg-time{ width:44px; font-size:13px; }
  .tab-logs .lg-search{ max-width:560px; }
}
`;

  function rowHtml(log) {
    const d = describe(log);
    const when = localParts(log.created_at);
    const code = text(log.item_code);
    const name = text(log.item_name);
    const loc = text(log.location_code);
    const actor = text(log.actor_name);
    const srcChip = log.source === 'mops' ? UI.chip('MOPS', 'info')
      : log.source === 'system' ? UI.chip('자동', 'muted') : '';
    const meta = [
      code ? `<button type="button" class="lg-code" data-act="item" data-code="${UI.esc(code)}" title="상품조회에서 열기">${UI.esc(code)}</button>` : '',
      name ? `<span class="lg-name">${UI.esc(name)}</span>` : '',
      loc ? `<span class="lg-loc" title="로케이션">${UI.esc(loc)}</span>` : '',
      actor || srcChip ? `<span class="lg-actor">${UI.esc(actor)}${srcChip}</span>` : '',
    ].join('');
    return `<li class="wl-row lg-row" data-id="${UI.esc(log.id)}">
      <time class="lg-time" datetime="${UI.esc(log.created_at)}">${UI.esc(when.time)}</time>
      <div class="wl-main">
        <div class="lg-top">${UI.chip(d.label, d.tone)}<span class="lg-sum">${UI.esc(d.text)}</span></div>
        ${meta ? `<div class="wl-meta">${meta}</div>` : ''}
      </div>
    </li>`;
  }

  // 이미 그려진 행은 건드리지 않고 뒤에만 붙인다(같은 날짜면 마지막 묶음에 이어 붙임).
  function appendRows(logs) {
    let section = els.list.lastElementChild;
    let day = section ? section.dataset.day : null;
    let ul = section ? section.querySelector('ul') : null;
    let buf = [];
    const flush = () => {
      if (ul && buf.length) ul.insertAdjacentHTML('beforeend', buf.join(''));
      buf = [];
    };
    for (const log of logs) {
      const key = localParts(log.created_at).day;
      if (ul === null || key !== day) {
        flush();
        section = document.createElement('section');
        section.className = 'lg-day';
        section.dataset.day = key;
        const isToday = key && key === today();
        section.innerHTML = `<h3 class="lg-day__head">${UI.esc(dayHeading(key))}${isToday ? ' · 오늘' : ''}</h3><ul class="wl-list"></ul>`;
        els.list.append(section);
        ul = section.querySelector('ul');
        day = key;
      }
      buf.push(rowHtml(log));
    }
    flush();
  }

  function renderControls() {
    if (els.input.value.trim() !== st.q) els.input.value = st.q;
    els.clear.hidden = !els.input.value;
    els.from.value = st.from;
    els.to.value = st.to;
    const kind = rangeKind();
    els.quick.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.range === kind);
    });
    els.cats.querySelectorAll('button').forEach(btn => {
      const active = btn.dataset.cat === st.cat;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // 목록 바깥(배너 · 건수 · 빈 상태 · 더 보기)만 다시 그린다.
  function renderStatus() {
    const shown = visibleCount();
    const more = !!st.next;

    els.count.textContent = st.loading || st.error || !st.loaded ? '' : `${shown.toLocaleString('ko-KR')}건${more ? '+' : ''}`;

    if (st.q) {
      let msg;
      if (st.loading) msg = `'${st.q}' 검색 중…`;
      else if (st.error) msg = `'${st.q}' 검색`;
      else msg = `'${st.q}' 검색 결과 ${shown.toLocaleString('ko-KR')}건${more ? ' · 더 있음' : ''}`;
      els.banner.innerHTML = `<span class="lg-banner__text">${UI.esc(msg)}</span>
        <button type="button" class="btn-sm btn-ghost" data-act="clear">검색 해제</button>`;
      els.banner.hidden = false;
    } else {
      els.banner.hidden = true;
      els.banner.innerHTML = '';
    }

    els.list.classList.toggle('is-loading', st.loading);

    let note = '';
    if (st.error) {
      note = `<div class="empty">불러오지 못했습니다
        <span class="lg-errmsg">${UI.esc(st.error)}</span>
        <button type="button" class="btn-sm" data-act="reload">다시 시도</button></div>`;
    } else if (st.loading) {
      if (!st.items.length) note = '<p class="empty">불러오는 중…</p>';
    } else if (st.loaded && !shown) {
      let msg;
      if (st.items.length) msg = more ? '불러온 기록 중 이 분류에 해당하는 기록이 없습니다' : '이 분류에 해당하는 기록이 없습니다';
      else msg = st.q ? `'${st.q}'에 해당하는 기록이 없습니다` : '기록이 없습니다';
      note = `<p class="empty">${UI.esc(msg)}</p>`;
    }
    els.note.innerHTML = note;

    let foot = '';
    if (!st.loading && !st.error && st.loaded) {
      if (st.moreError) {
        foot = `<span>불러오지 못했습니다 · ${UI.esc(st.moreError)}</span>
          <button type="button" class="btn-sm" data-act="more">다시 시도</button>`;
      } else if (more) {
        foot = `<button type="button" class="btn-sm" data-act="more"${st.loadingMore ? ' disabled' : ''}>${st.loadingMore ? '불러오는 중…' : '더 보기'}</button>`;
      } else if (st.items.length > PAGE_SIZE) {
        foot = '<span>마지막 기록입니다</span>';
      }
    }
    els.foot.innerHTML = foot;
  }

  function renderList() {
    els.list.innerHTML = '';
    appendRows(st.cat === 'all' ? st.items : st.items.filter(matchesCat));
  }

  /* ---------- 조회 ---------- */
  function query(extra) {
    return Object.assign({ q: st.q, from: st.from, to: st.to, limit: PAGE_SIZE }, extra);
  }
  function takeNew(list) {
    const fresh = [];
    for (const log of Array.isArray(list) ? list : []) {
      if (!log || typeof log !== 'object') continue;
      const id = text(log.id);
      if (id) {
        if (st.ids.has(id)) continue;
        st.ids.add(id);
      }
      fresh.push(log);
    }
    return fresh;
  }

  async function load() {
    const seq = ++st.seq;
    st.loading = true;
    st.loadingMore = false;
    st.error = '';
    st.moreError = '';
    renderStatus();
    try {
      const data = (await UI.api.get('/action_logs', query())) || {};
      if (seq !== st.seq) return;
      st.ids = new Set();
      st.items = takeNew(data.items);
      st.next = data.next_before || null;
    } catch (err) {
      if (seq !== st.seq) return;
      st.ids = new Set();
      st.items = [];
      st.next = null;
      st.error = (err && err.message) || '요청에 실패했습니다.';
    }
    st.loading = false;
    st.loaded = true;
    renderList();
    renderStatus();
  }

  async function loadMore() {
    if (st.loading || st.loadingMore || !st.next) return;
    const seq = st.seq;
    const before = st.next;
    st.loadingMore = true;
    st.moreError = '';
    renderStatus();
    try {
      const data = (await UI.api.get('/action_logs', query({ before }))) || {};
      if (seq !== st.seq) return;
      const fresh = takeNew(data.items);
      st.items.push(...fresh);
      const next = data.next_before || null;
      // 같은 커서가 되돌아오고 새 행도 없으면 끝난 것으로 본다(무한 반복 방지).
      st.next = next === before && !fresh.length ? null : next;
      appendRows(st.cat === 'all' ? fresh : fresh.filter(matchesCat));
    } catch (err) {
      if (seq !== st.seq) return;
      st.moreError = (err && err.message) || '요청에 실패했습니다.';
    }
    st.loadingMore = false;
    renderStatus();
  }

  /* ---------- 동작 ---------- */
  function cancelSearchTimer() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  }
  function applySearch(force) {
    cancelSearchTimer();
    const q = els.input.value.trim();
    if (!force && q === st.q) return;
    st.q = q;
    load();
  }
  function clearSearch() {
    cancelSearchTimer();
    els.input.value = '';
    els.clear.hidden = true;
    const had = !!st.q;
    st.q = '';
    if (had) load(); else renderStatus();
  }

  function onClick(ev) {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    const rangeBtn = target.closest('[data-range]');
    if (rangeBtn) {
      setRange(rangeBtn.dataset.range);
      renderControls();
      load();
      return;
    }
    const catBtn = target.closest('[data-cat]');
    if (catBtn) {
      if (catBtn.dataset.cat === st.cat) return;
      st.cat = catBtn.dataset.cat;
      renderControls();
      renderList();
      renderStatus();
      return;
    }
    const actBtn = target.closest('[data-act]');
    if (!actBtn) return;
    switch (actBtn.dataset.act) {
      case 'item':
        if (actBtn.dataset.code) Shell.show('items', { code: actBtn.dataset.code });
        break;
      case 'clear':
        clearSearch();
        if (actBtn === els.clear) els.input.focus();
        break;
      case 'reload': load(); break;
      case 'more': loadMore(); break;
      default: break;
    }
  }

  function onDateChange() {
    let from = isYmd(els.from.value) ? els.from.value : '';
    let to = isYmd(els.to.value) ? els.to.value : '';
    if (from && to && from > to) { const tmp = from; from = to; to = tmp; }
    if (from === st.from && to === st.to) return;
    st.from = from;
    st.to = to;
    renderControls();
    load();
  }

  function mount(root) {
    if (!document.getElementById('tab-logs-style')) {
      const style = document.createElement('style');
      style.id = 'tab-logs-style';
      style.textContent = CSS;
      document.head.append(style);
    }
    root.classList.add('tab-logs');
    root.innerHTML = `
      <div class="view-head">
        <h2>작업로그</h2>
        <div class="lg-headside">
          <span class="lg-count" data-role="count" aria-live="polite"></span>
          <button type="button" class="btn-sm btn-ghost" data-act="reload">새로고침</button>
        </div>
      </div>
      <form class="view-toolbar lg-search" data-role="search" role="search" autocomplete="off">
        <div class="lg-searchbox">
          <input type="text" data-role="q" inputmode="search" enterkeyhint="search" maxlength="100"
                 placeholder="SKU코드 · 상품명 · 로케이션코드" aria-label="작업로그 검색" />
          <button type="button" class="lg-clear" data-act="clear" aria-label="검색어 지우기" hidden>✕</button>
        </div>
        <button type="submit" class="btn-primary">검색</button>
      </form>
      <div class="view-toolbar lg-range">
        <input type="date" data-role="from" aria-label="시작일" />
        <span class="lg-tilde">~</span>
        <input type="date" data-role="to" aria-label="종료일" />
        <div class="seg" data-role="quick" role="group" aria-label="기간">
          <button type="button" data-range="today">오늘</button>
          <button type="button" data-range="7d">7일</button>
          <button type="button" data-range="all">전체</button>
        </div>
      </div>
      <div class="lg-cats">
        <div class="seg" data-role="cats" role="group" aria-label="분류">
          ${CATEGORIES.map(c => `<button type="button" data-cat="${c.id}">${c.label}</button>`).join('')}
        </div>
      </div>
      <div class="lg-banner" data-role="banner" hidden></div>
      <div class="view-body">
        <div class="lg-list" data-role="list"></div>
        <div data-role="note"></div>
        <div class="lg-foot" data-role="foot"></div>
      </div>`;

    const pick = role => root.querySelector(`[data-role="${role}"]`);
    els.root = root;
    els.count = pick('count');
    els.form = pick('search');
    els.input = pick('q');
    els.clear = root.querySelector('.lg-clear');
    els.from = pick('from');
    els.to = pick('to');
    els.quick = pick('quick');
    els.cats = pick('cats');
    els.banner = pick('banner');
    els.list = pick('list');
    els.note = pick('note');
    els.foot = pick('foot');

    setRange('7d');

    root.addEventListener('click', onClick);
    els.form.addEventListener('submit', ev => { ev.preventDefault(); applySearch(true); });
    els.input.addEventListener('input', () => {
      els.clear.hidden = !els.input.value;
      cancelSearchTimer();
      searchTimer = setTimeout(() => applySearch(false), SEARCH_DEBOUNCE_MS);
    });
    els.from.addEventListener('change', onDateChange);
    els.to.addEventListener('change', onDateChange);
  }

  // params.q 가 오면(다른 탭에서 넘어온 상품별 이력) 검색어를 채우고 기간·분류를 전체로 넓힌다.
  function onShow(params) {
    if (!els.root) return;
    const p = params && typeof params === 'object' ? params : {};
    cancelSearchTimer();
    if (typeof p.q === 'string') {
      st.q = p.q.trim();
      els.input.value = st.q;
      st.cat = 'all';
      setRange('all');
    } else {
      // 입력만 해 두고 아직 조회되지 않은 검색어도 반영한다.
      st.q = els.input.value.trim();
    }
    if (isYmd(p.from)) st.from = p.from;
    if (isYmd(p.to)) st.to = p.to;
    if (st.from && st.to && st.from > st.to) { const tmp = st.from; st.from = st.to; st.to = tmp; }
    renderControls();
    return load();
  }

  function onHide() {
    cancelSearchTimer();
  }

  Shell.register({ id: 'logs', label: '작업로그', mount, onShow, onHide, _describe: describe });
})();
