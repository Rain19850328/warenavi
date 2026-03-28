// app.js — stable build with autocomplete & results list (v20250825-06)
const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '/api';
const sel = s => document.querySelector(s);
const fmtM3 = cm3 => (cm3/1_000_000).toFixed(2) + ' m³';

const CELL_BASE_HEIGHT = 140;

let CONFIG = null;
let CELLS = [];
let CURRENT_ROW = null;
let CURRENT_CELL = null;
let CURRENT_ITEM_SKU = null;
let MOVEMENTS = [];

/* ---------- dialog helpers ---------- */
let __dlgOverlay = null;
function openDialog(el) { if (el && typeof el.showModal === 'function') { el.showModal(); return; } if (!el) return; __dlgOverlay = document.createElement('div'); __dlgOverlay.className = 'backdrop'; document.body.append(__dlgOverlay); el.setAttribute('open',''); }
function closeDialog(el) { if (el && typeof el.close === 'function') { el.close(); return; } if (!el) return; el.removeAttribute('open'); if (__dlgOverlay) { __dlgOverlay.remove(); __dlgOverlay = null; } }

function setDialogPending(dlg, pending, submitSelector, pendingLabel = '처리중...') {
  if (!dlg) return;
  dlg.dataset.pending = pending ? '1' : '0';
  dlg.querySelectorAll('button, input, select, textarea').forEach(el => {
    if (pending) {
      el.dataset.wasDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.wasDisabled !== '1') {
      el.disabled = false;
    }
  });
  const submitBtn = submitSelector ? dlg.querySelector(submitSelector) : null;
  if (submitBtn) {
    if (!submitBtn.dataset.defaultLabel) {
      submitBtn.dataset.defaultLabel = submitBtn.textContent || '';
    }
    submitBtn.textContent = pending ? pendingLabel : submitBtn.dataset.defaultLabel;
    submitBtn.disabled = pending;
  }
}

function isDialogPending(dlg) {
  return dlg?.dataset?.pending === '1';
}

/* ---------- inbound dialog ---------- */
function ensureInboundDialog() {
  let dlg = document.getElementById('dlgInbound');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlgInbound';
    dlg.innerHTML = `
      <form method="dialog" class="dialog">
        <h3 id="dlgTitle">입고</h3>
        <div class="row">
          <input id="dlgQuery" type="text" placeholder="SKU/상품명/위치코드" />
          <button id="dlgBtnSearch">검색</button>
        </div>
        <div class="list" id="dlgList"></div>
        <div class="row">
          <label>입고수량 : <input id="dlgQty" type="number" min="1" step="1" value="100"
            style="width:80px; text-align:right;" /></label>
          <button id="dlgOk" value="ok">확인</button>
          <button id="dlgCancel">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }

  // ----- Autocomplete (dialog-scoped) -----
  const qbox = dlg.querySelector('#dlgQuery');
  const rowSearch = qbox?.closest('.row');
  if (rowSearch) rowSearch.style.position = 'relative';
  let dlgSuggest = dlg.querySelector('#dlgSuggest');
  if (!dlgSuggest) {
    dlgSuggest = document.createElement('div');
    dlgSuggest.id = 'dlgSuggest';
    dlgSuggest.className = 'suggest';
    dlgSuggest.hidden = true;
    (rowSearch || dlg).append(dlgSuggest);
  }
  const D_SUGGEST = { open:false, idx:-1, items:[] };
  function dlgShowSuggest(items){
    dlgSuggest.innerHTML = '';
    if (!items || !items.length){
      dlgSuggest.innerHTML = '<div class="empty">일치하는 항목이 없습니다.</div>';
      dlgSuggest.hidden = false; D_SUGGEST.open = true; D_SUGGEST.idx = -1; D_SUGGEST.items = [];
      return;
    }
    D_SUGGEST.items = items.slice(0, 20);
    D_SUGGEST.idx = -1;
    for (const name of D_SUGGEST.items){
      const div = document.createElement('div');
      div.className = 'item'; div.textContent = name;
      let picked = false;
      const doPick = ()=>{ if (picked) return; picked = true; dlgPickSuggest(name); };
      div.addEventListener('pointerdown', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
      div.addEventListener('mousedown', (e)=>{ e.preventDefault(); });
      div.addEventListener('touchstart', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
      div.addEventListener('click', (e)=>{ e.preventDefault(); doPick(); }, {once:true});
      dlgSuggest.append(div);
    }
    dlgSuggest.hidden = false; D_SUGGEST.open = true;
  }
  function dlgHideSuggest(){ dlgSuggest.hidden = true; dlgSuggest.innerHTML = ''; D_SUGGEST.open=false; D_SUGGEST.idx=-1; D_SUGGEST.items=[]; }
  function dlgMoveSuggest(delta){
    if (!D_SUGGEST.open) return;
    const items = Array.from(dlgSuggest.querySelectorAll('.item'));
    if (!items.length) return;
    D_SUGGEST.idx = (D_SUGGEST.idx + delta + items.length) % items.length;
    items.forEach((el,i)=> el.classList.toggle('sel', i===D_SUGGEST.idx));
  }
  function dlgPickSuggest(name){ if(qbox){ qbox.value = name; } dlgHideSuggest(); }
  const requestDlgSuggest = debounce(async (term)=>{
    term = (term||'').trim();
    if (!term){ dlgHideSuggest(); return; }
    try {
      const data = await getJSON(`${API_BASE}/items?q=${encodeURIComponent(term)}&limit=50`);
      const names = Array.from(new Set((data.items||[]).map(it=>it.name).filter(Boolean)));
      dlgShowSuggest(names);
    } catch(e){ dlgHideSuggest(); }
  }, 180);

  qbox?.addEventListener('input', e => { requestDlgSuggest(e.target.value); });
  qbox?.addEventListener('keydown', e => {
    if (e.key==='ArrowDown'){ e.preventDefault(); dlgMoveSuggest(+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); dlgMoveSuggest(-1); return; }
    if (e.key==='Enter'){
      if (D_SUGGEST.open && D_SUGGEST.idx>=0){
        const cur = dlgSuggest.querySelectorAll('.item')[D_SUGGEST.idx];
        if (cur){ e.preventDefault(); dlgPickSuggest(cur.textContent||''); return; }
      }
      e.preventDefault(); // prevent closing dialog
      dlg.querySelector('#dlgBtnSearch')?.click();
      return;
    }
    if (e.key==='Escape'){ dlgHideSuggest(); }
  });
  dlg.addEventListener('click', (ev)=>{
    const within = dlgSuggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) dlgHideSuggest();
  });
  dlg.addEventListener('pointerdown', (ev)=>{
    const within = dlgSuggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) dlgHideSuggest();
  }, {passive:true});

  return dlg;
}

/* ---------- search dialog (재고검색 전용) ---------- */
function ensureSearchDialog() {
  let dlg = document.getElementById('dlgSearch');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlgSearch';
    dlg.innerHTML = `
      <form method="dialog" class="dialog">
        <h3 id="searchDlgTitle">검색</h3>
        <div class="row">
          <input id="searchDlgQuery" type="text" placeholder="SKU/상품명 검색" />
          <button id="searchDlgBtn" type="button">검색</button>
        </div>
        <div class="list" id="searchDlgList"></div>
        <div class="row">
          <button id="searchDlgClose">닫기</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }

  // 리스트 렌더 (상품명 | 수량)
  function renderList(items) {
    const list = dlg.querySelector('#searchDlgList');
    list.innerHTML = '';

    // ★ 헤더 제거 (컬럼 제목 표시 안 함)

    for (const it of (items || [])) {
      const row = document.createElement('div');
      row.className = 'item';
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '60px minmax(0, 1fr) 50px'; // [SKU/LOC] | [상품명] | [수량]

      const loc = it.location || '';            // ← items_with_stock 응답의 location 사용
      const qty = Number(it.stock_qty || 0);

      row.innerHTML = `
        <div class="skuBlock">
          <div class="sku"><strong>${it.code || ''}</strong></div>
          <div class="loc">${loc}</div>
        </div>
        <div class="name">${it.name || ''}</div>
        <div class="r" style="text-align:right">${qty.toLocaleString('ko-KR')}</div>
      `;
      list.append(row);
    }

    if (!items || !items.length) {
      list.innerHTML = '<div class="muted" style="padding:8px 4px;">표시할 상품이 없습니다.</div>';
    }
  }

  // 검색 실행
  async function doSearch() {
    const q = (dlg.querySelector('#searchDlgQuery')?.value || '').trim();
    const url = `${API_BASE}/items_with_stock?limit=300${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    try {
      const data = await getJSON(url);
      renderList(data.items || []);
    } catch (e) {
      alert('검색 실패: ' + (e.message || e));
    }
  }

  // 이벤트 바인딩 (중복 바인딩 방지로 once)
  const qbox = dlg.querySelector('#searchDlgQuery');
  const btn  = dlg.querySelector('#searchDlgBtn');
  const btnClose = dlg.querySelector('#searchDlgClose');

  /* ====== ⬇⬇⬇ 자동완성(입고 다이얼로그와 동일 패턴) 추가 시작 ⬇⬇⬇ ====== */
  // 입력 줄을 상대배치로 (제안박스 포지셔닝)
  const rowSearch = qbox?.closest('.row');
  if (rowSearch) rowSearch.style.position = 'relative';

  // 제안 박스 준비
  let dlgSuggest = dlg.querySelector('#searchDlgSuggest');
  if (!dlgSuggest) {
    dlgSuggest = document.createElement('div');
    dlgSuggest.id = 'searchDlgSuggest';
    dlgSuggest.className = 'suggest';
    dlgSuggest.hidden = true;
    (rowSearch || dlg).append(dlgSuggest);
  }

  // 상태
  const SD_SUGGEST = { open:false, idx:-1, items:[] };

  function sdShowSuggest(items){
    dlgSuggest.innerHTML = '';
    if (!items || !items.length){
      dlgSuggest.innerHTML = '<div class="empty">일치하는 항목이 없습니다.</div>';
      dlgSuggest.hidden = false; SD_SUGGEST.open = true; SD_SUGGEST.idx = -1; SD_SUGGEST.items = [];
      return;
    }
    SD_SUGGEST.items = items.slice(0, 20);
    SD_SUGGEST.idx = -1;
    for (const name of SD_SUGGEST.items){
      const div = document.createElement('div');
      div.className = 'item';
      div.textContent = name;
      let picked = false;
      const doPick = ()=>{ if (picked) return; picked = true; sdPickSuggest(name); };
      div.addEventListener('pointerdown', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
      div.addEventListener('mousedown', (e)=>{ e.preventDefault(); });
      div.addEventListener('touchstart', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
      div.addEventListener('click', (e)=>{ e.preventDefault(); doPick(); }, {once:true});
      dlgSuggest.append(div);
    }
    dlgSuggest.hidden = false; SD_SUGGEST.open = true;
  }
  function sdHideSuggest(){ dlgSuggest.hidden = true; dlgSuggest.innerHTML = ''; SD_SUGGEST.open=false; SD_SUGGEST.idx=-1; SD_SUGGEST.items=[]; }
  function sdMoveSuggest(delta){
    if (!SD_SUGGEST.open) return;
    const items = Array.from(dlgSuggest.querySelectorAll('.item'));
    if (!items.length) return;
    SD_SUGGEST.idx = (SD_SUGGEST.idx + delta + items.length) % items.length;
    items.forEach((el,i)=> el.classList.toggle('sel', i===SD_SUGGEST.idx));
  }
  function sdPickSuggest(name){
    if(qbox){ qbox.value = name; }
    sdHideSuggest();
    // 자동으로 검색 버튼 트리거 (선택 즉시 검색)
     btn?.click();
  }

  const requestSearchDlgSuggest = debounce(async (term)=>{
    term = (term||'').trim();
    if (!term){ sdHideSuggest(); return; }
    try {
      // 입고 자동완성과 동일: /api/items 에서 상품명 목록만 가져와 제안
      const data = await getJSON(`${API_BASE}/items?q=${encodeURIComponent(term)}&limit=50`);
      const names = Array.from(new Set((data.items||[]).map(it=>it.name).filter(Boolean)));
      sdShowSuggest(names);
    } catch(e){ sdHideSuggest(); }
  }, 180);

  qbox?.addEventListener('input', e => { requestSearchDlgSuggest(e.target.value); });
  qbox?.addEventListener('keydown', e => {
    if (e.key==='ArrowDown'){ e.preventDefault(); sdMoveSuggest(+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); sdMoveSuggest(-1); return; }
    if (e.key==='Enter'){
      if (SD_SUGGEST.open && SD_SUGGEST.idx>=0){
        const cur = dlgSuggest.querySelectorAll('.item')[SD_SUGGEST.idx];
        if (cur){ e.preventDefault(); sdPickSuggest(cur.textContent||''); return; }
      }
      // 엔터로 바로 검색
      e.preventDefault();
      btn?.click(); 
      return;
    }
    if (e.key==='Escape'){ sdHideSuggest(); }
  });
  dlg.addEventListener('click', (ev)=>{
    const within = dlgSuggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) sdHideSuggest();
  });
  dlg.addEventListener('pointerdown', (ev)=>{
    const within = dlgSuggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) sdHideSuggest();
  }, {passive:true});
  /* ====== ⬆⬆⬆ 자동완성 추가 끝 ⬆⬆⬆ ====== */

  if (btn && !btn.__bound) {
    btn.__bound = true;
    btn.addEventListener('click', (e)=>{ e.preventDefault(); doSearch(); });
  }
  if (btnClose && !btnClose.__bound) {
    btnClose.__bound = true;
    btnClose.addEventListener('click', (e)=>{ e.preventDefault(); closeDialog(dlg); });
  }
  

  return dlg;
}

async function openSearchDialog() {
  const dlg = ensureSearchDialog();
  if (!dlg.open) openDialog(dlg);
  const qbox = dlg.querySelector('#searchDlgQuery');
  if (qbox) { qbox.value = (document.querySelector('#search')?.value || ''); qbox.focus(); }
  // 처음 열릴 때 1회 자동 검색
  try {
    const initQ = (qbox?.value || '').trim();
    const url = `${API_BASE}/items_with_stock?limit=100${initQ ? `&q=${encodeURIComponent(initQ)}` : ''}`;
    const data = await getJSON(url);
   
    const list = dlg.querySelector('#searchDlgList');
    list.innerHTML = '';
    const items = data.items || [];

    // ★ 헤더 없음 (컬럼 제목 제거)

    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'item';
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '60px minmax(0, 1fr) 50px'; // [SKU/LOC] | [상품명] | [수량]
      

      const loc = it.location || '';
      const qty = Number(it.stock_qty || 0);

      row.innerHTML = `
        <div class="skuBlock">
          <div class="sku"><strong>${it.code || ''}</strong></div>
          <div class="loc">${loc}</div>
        </div>
        <div class="name">${it.name || ''}</div>
        <div class="r" style="text-align:right">${qty.toLocaleString('ko-KR')}</div>
      `;
      list.append(row);
    }
    if (!items.length) {
      list.innerHTML = '<div class="muted" style="padding:8px 4px;">표시할 상품이 없습니다.</div>';
    }

  } catch (e) {
    alert('검색 실패: ' + (e.message || e));
  }
}

/* ---------- location code dialog (로케이션코드입력) ---------- */
function ensureLocationDialog(){
  let dlg = document.getElementById('dlgLocation');
  if (!dlg){
    dlg = document.createElement('dialog');
    dlg.id = 'dlgLocation';
    dlg.innerHTML = `
      <form method="dialog" class="dialog">
        <h3>로케이션코드입력</h3>

        <!-- ① 검색섹션 -->
        <section id="locSearchSec">
          <div class="row">
            <input id="locDlgQuery" type="text" placeholder="SKU/상품명 검색" />
            <button id="locDlgBtnSearch" type="button">검색</button>
          </div>
        </section>

        <!-- ② 리스트섹션 -->
        <section id="locListSec">
          <div class="list" id="locDlgList"></div>
        </section>

        <!-- ③ 출력섹션 -->
        <section id="locOutputSec" class="row">
          <div id="locDlgOutput" class="muted">선택된 항목이 없습니다.</div>
        </section>

        <!-- ④ 입력섹션 -->
        <section id="locInputSec" class="row"
          style="gap:8px; display:grid; grid-template-columns: 1fr auto; grid-template-rows:auto auto; align-items:stretch;">
          <!-- 1행: 입력창 + 확인버튼 -->
          <input id="locDlgNewCode" type="text"
                placeholder="새 로케이션 코드 (예: D-02-02-01)"
                style="grid-column:1/2;"/>
          <button id="locDlgConfirm" type="button" style="grid-column:2/3;">확인</button>

          <!-- 2행: 닫기버튼 (두 컬럼 전체 폭) -->
          <button id="locDlgClose" type="button"
                  style="grid-column:1/3; width:100%;">닫기</button>
        </section>

      </form>`;
    document.body.append(dlg);
  }

  /* ===== 리스트 렌더링 (SKU | 상품명 | 로케이션코드) ===== */
  function renderLocList(items){
    const list = dlg.querySelector('#locDlgList');
    list.innerHTML = '';

    for (const it of (items||[])) {
      const row = document.createElement('div');
      row.className = 'item';
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '60px minmax(0, 1fr) 50px'; // [SKU] | [상품명] | [로케이션]

      const code = it.code || '';
      const name = it.name || '';
      const loc  = it.location || it.location_code || '';

      row.innerHTML = `
        <div class="sku"><strong>${code}</strong></div>
        <div class="name">${name}</div>
        <div class="loc sku"><strong>${loc}</strong></div>
      `;

      row.addEventListener('click', ()=>{
        list.querySelectorAll('.item.sel').forEach(x=>x.classList.remove('sel'));
        row.classList.add('sel');
        setSelected({ code, name, loc });
      });

      list.append(row);
    }

    if (!items || !items.length) {
      list.innerHTML = '<div class="muted" style="padding:8px 4px;">표시할 항목이 없습니다.</div>';
    }
  }

  /* ===== 선택/출력 표시 ===== */
  function setSelected(info){
    dlg.dataset.selected = JSON.stringify(info || {});
    const out = dlg.querySelector('#locDlgOutput');
    if (!out) return;

    // 줄바꿈을 실제 줄바꿈으로 보이게
    out.style.whiteSpace = 'pre-line';

    if (!info) {
      out.textContent = '선택된 항목이 없습니다.';
      return;
    }

    // 요청 형식대로 출력
    out.textContent =
      `Sku_code : ${info.code}\n` +
      `Item_name : ${info.name}\n` +
      `Location_code : ${info.loc || '-'}`;
  }

  /* ===== 검색 실행 ===== */
  async function doSearch(){
    const q = (dlg.querySelector('#locDlgQuery')?.value || '').trim();
    const url = `${API_BASE}/items?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    try{
      const data = await getJSON(url);
      renderLocList(data.items || []);
      setSelected(null);
    }catch(e){
      alert('검색 실패: ' + (e.message || e));
    }
  }

  /* ===== 자동완성(재고검색/입고와 동일 톤) ===== */
  const qbox = dlg.querySelector('#locDlgQuery');
  const rowSearch = qbox?.closest('.row');
  if (rowSearch) rowSearch.style.position = 'relative';

  let suggest = dlg.querySelector('#locDlgSuggest');
  if (!suggest){
    suggest = document.createElement('div');
    suggest.id = 'locDlgSuggest';
    suggest.className = 'suggest';
    suggest.hidden = true;
    (rowSearch || dlg).append(suggest);
  }
  const L_SUGGEST = { open:false, idx:-1, items:[] };

  function lsShow(items){
    suggest.innerHTML = '';
    if (!items || !items.length){
      suggest.innerHTML = '<div class="empty">일치하는 항목이 없습니다.</div>';
      suggest.hidden = false; L_SUGGEST.open=true; L_SUGGEST.idx=-1; L_SUGGEST.items=[];
      return;
    }
    L_SUGGEST.items = items.slice(0,20);
    L_SUGGEST.idx = -1;
    for (const name of L_SUGGEST.items){
      const div = document.createElement('div');
      div.className = 'item'; div.textContent = name;
      let picked = false;
      const pick = ()=>{ if (picked) return; picked = true; if(qbox){ qbox.value = name; } lsHide(); doSearch(); };
      div.addEventListener('pointerdown', e=>{ e.preventDefault(); pick(); }, {passive:false});
      div.addEventListener('mousedown', e=> e.preventDefault());
      div.addEventListener('touchstart', e=>{ e.preventDefault(); pick(); }, {passive:false});
      div.addEventListener('click', e=>{ e.preventDefault(); pick(); }, {once:true});
      suggest.append(div);
    }
    suggest.hidden = false; L_SUGGEST.open = true;
  }
  function lsHide(){ suggest.hidden = true; suggest.innerHTML=''; L_SUGGEST.open=false; L_SUGGEST.idx=-1; L_SUGGEST.items=[]; }
  function lsMove(d){
    if (!L_SUGGEST.open) return;
    const items = Array.from(suggest.querySelectorAll('.item'));
    if (!items.length) return;
    L_SUGGEST.idx = (L_SUGGEST.idx + d + items.length) % items.length;
    items.forEach((el,i)=> el.classList.toggle('sel', i===L_SUGGEST.idx));
  }
  const requestLocSuggest = debounce(async (term)=>{
    term = (term||'').trim();
    if (!term) return lsHide();
    try{
      const data = await getJSON(`${API_BASE}/items?q=${encodeURIComponent(term)}&limit=50`);
      const names = Array.from(new Set((data.items||[]).map(it=>it.name).filter(Boolean)));
      lsShow(names);
    }catch(_){ lsHide(); }
  }, 180);

  qbox?.addEventListener('input', e=> requestLocSuggest(e.target.value));
  qbox?.addEventListener('keydown', e=>{
    if (e.key==='ArrowDown'){ e.preventDefault(); lsMove(+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); lsMove(-1); return; }
    if (e.key==='Enter'){
      if (L_SUGGEST.open && L_SUGGEST.idx>=0){
        const cur = suggest.querySelectorAll('.item')[L_SUGGEST.idx];
        if (cur){ e.preventDefault(); if(qbox){ qbox.value = cur.textContent||''; } lsHide(); doSearch(); return; }
      }
      e.preventDefault(); lsHide(); doSearch(); return;
    }
    if (e.key==='Escape'){ lsHide(); }
  });
  dlg.addEventListener('click', (ev)=>{
    const within = suggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) lsHide();
  });
  dlg.addEventListener('pointerdown', (ev)=>{
    const within = suggest.contains(ev.target) || qbox.contains(ev.target);
    if (!within) lsHide();
  }, {passive:true});

  /* ===== 버튼 바인딩 ===== */
  const btnSearch = dlg.querySelector('#locDlgBtnSearch');
  const btnClose  = dlg.querySelector('#locDlgClose');
  const btnOk     = dlg.querySelector('#locDlgConfirm');
  const newCodeEl = dlg.querySelector('#locDlgNewCode');

  if (btnSearch && !btnSearch.__bound){
    btnSearch.__bound = true;
    btnSearch.addEventListener('click', e=>{ e.preventDefault(); doSearch(); });
  }
  if (btnClose && !btnClose.__bound){
    btnClose.__bound = true;
    btnClose.addEventListener('click', e=>{ e.preventDefault(); closeDialog(dlg); });
  }

  /* ▼▼▼ [신규] 로케이션코드 중복 검사 헬퍼 ▼▼▼ */
  async function isLocationInUse(locCode){
    // 1차: 백엔드가 location 필터를 지원한다고 가정 (/api/items?location=)
    try{
      const r1 = await getJSON(`${API_BASE}/items?location=${encodeURIComponent(locCode)}&limit=1`);
      if ((r1.items||[]).some(x => (x.location||x.location_code||'') === locCode)) return true;
    }catch(_){ /* 무시하고 2차 시도 */ }

    // 2차(폴백): 검색 API에서 location 일치가 있는지 확인
    try{
      const r2 = await getJSON(`${API_BASE}/search_racks?q=${encodeURIComponent(locCode)}&limit=5`);
      if ((r2.results||[]).some(x => (x.location||'') === locCode)) return true;
    }catch(_){ /* 네트워크/엔드포인트 부재는 사용중 아님으로 처리 */ }

    return false;
  }
  /* ▲▲▲ [신규] 헬퍼 끝 ▲▲▲ */

  if (btnOk && !btnOk.__bound){
    btnOk.__bound = true;
    btnOk.addEventListener('click', async e=>{
      e.preventDefault();
      if (isDialogPending(dlg)) return;
      const sel = JSON.parse(dlg.dataset.selected || '{}');
      const locNew = (newCodeEl?.value || '').trim();
      if (!sel.code) return alert('표에서 항목을 선택하세요.');
      if (!locNew)  return alert('새 로케이션 코드를 입력하세요.');

      // ✅ 정확히 "00" 이면 중복검사 생략
      setDialogPending(dlg, true, '#locDlgConfirm');
      try {
      if (locNew !== '00') {
        try{
          const used = await isLocationInUse(locNew);
          if (used){
            alert('해당 로케이션코드가 이미 사용중입니다. 다른 코드를 입력하세요.');
            return;
          }
        }catch(err){
          alert('로케이션코드 중복 확인에 실패했습니다. 잠시 후 다시 시도해주세요.\n' + (err.message||err));
          return;
        }
      }

      // 저장 (00 포함 일반코드 모두 동일 엔드포인트)
      try{
        await postJSON(`${API_BASE}/set_location`, { item_code: sel.code, location: locNew });
        await loadMovements();
        alert('로케이션 코드 변경 완료');

        // 화면 반영
        setSelected({ ...sel, loc: locNew });
        newCodeEl.value = '';

        // ✅ 다이얼로그 내 리스트를 즉시 새로고침해 갱신 내용 반영
        await (async function(){ 
          const q = (dlg.querySelector('#locDlgQuery')?.value || '').trim();
          const url = `${API_BASE}/items?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`;
          const data = await getJSON(url);
          renderLocList(data.items || []);
        })();
      }catch(err){
        alert(err?.message || String(err) || '요청 실패');
      }
      } finally {
        setDialogPending(dlg, false, '#locDlgConfirm');
      }
    });
  }



  return dlg;
}

async function openLocationDialog(){
  const dlg = ensureLocationDialog();
  if (!dlg.open) openDialog(dlg);

  // 기존 상단 검색어 있으면 가져오기
  const qbox = dlg.querySelector('#locDlgQuery');
  if (qbox) { qbox.value = (document.querySelector('#search')?.value || ''); qbox.focus(); }

  // 최초 1회 검색
  const btnSearch = dlg.querySelector('#locDlgBtnSearch');
  btnSearch?.click();
}


/* ---------- fetch ---------- */
async function getJSON(url) {
  const u = new URL(url, location.origin);
  u.searchParams.set('_', Date.now());
  const r = await fetch(u.toString(), {
    cache:'no-store',
    headers: await getRequestHeaders(),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const PENDING_POSTS = new Map();
async function postJSON(url, body) {
  const payload = JSON.stringify(body);
  const key = `${url}::${payload}`;
  if (PENDING_POSTS.has(key)) return PENDING_POSTS.get(key);
  const request = (async () => {
  const r = await fetch(url, {
    method:'POST',
    headers: await getRequestHeaders({'Content-Type':'application/json'}),
    body: payload,
    cache:'no-store',
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.detail || r.statusText || '요청 실패');
  return data;
  })();
  PENDING_POSTS.set(key, request);
  try {
    return await request;
  } finally {
    PENDING_POSTS.delete(key);
  }
}

async function getRequestHeaders(extra = {}) {
  const headers = { ...extra };
  if (window.WarehouseAuth && typeof window.WarehouseAuth.getApiHeaders === 'function') {
    Object.assign(headers, await window.WarehouseAuth.getApiHeaders());
  }
  return headers;
}

/* ---------- utils ---------- */
function occupancyRate(used, cap) { return cap <= 0 ? 0 : (used / cap) * 100.0; }
function colorByRate(total, cap) {
  const rate = cap <= 0 ? 0 : (total / cap) * 100;
  const low = CONFIG.rate_low_max ?? 30;
  const normal = CONFIG.rate_normal_max ?? 70;
  if (total <= 0) return {fill:'#ffffff',  border:'#cbd5e1', label:'0%'};
  if (rate <= low)  return {fill:'#e0f2fe', border:'#3C8CC8', label:`0~${low}%`};
  if (rate <= normal) return {fill:'#dcfce7', border:'#50A468', label:`${low}~${normal}%`};
  return {fill:'#ffedd5', border:'#C88C3C', label:`${normal}~100%`};
}
function buildLegend() {
  const low = CONFIG.rate_low_max ?? 30;
  const normal = CONFIG.rate_normal_max ?? 70;
  const legend = document.createElement('div');
  legend.className = 'legend';
  const entries = [
    {label:'0%', style:{background:'#ffffff', border:'#cbd5e1'}},
    {label:`0~${low}%`, style:{background:'#e0f2fe', border:'#3C8CC8'}},
    {label:`${low}~${normal}%`, style:{background:'#dcfce7', border:'#50A468'}},
    {label:`${normal}~100%`, style:{background:'#ffedd5', border:'#C88C3C'}},
  ];
  for (const e of entries) {
    const box = document.createElement('div');
    box.className = 'entry';
    const sw = document.createElement('div'); sw.className='sw';
    sw.style.background = e.style.background; sw.style.borderColor = e.style.border;
    const label = document.createElement('span'); label.className='label'; label.textContent = e.label;
    box.append(sw,label);
    legend.append(box);
  }
  return legend;
}
function matchesQuery(ci, qUpper) {
  if (!qUpper) return true;
  if (ci.code && ci.code.toUpperCase().includes(qUpper)) return true;
  return (ci.items||[]).some(it =>
    (it.sku && it.sku.toUpperCase().includes(qUpper)) ||
    (it.name && it.name.toUpperCase().includes(qUpper)) ||
    (it.location && (it.location.toUpperCase().includes(qUpper)))
  );
}

/* ---------- autocomplete (suggest) ---------- */
const SUGGEST = { open:false, idx:-1, items:[] };
function debounce(fn, ms){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }
function showSuggest(items){
  const box = document.querySelector('#searchSuggest'); if (!box) return;
  box.innerHTML = '';
  if (!items || !items.length){
    box.innerHTML = '<div class="empty">일치하는 상품명이 없습니다.</div>';
    box.hidden = false; SUGGEST.open = true; SUGGEST.idx = -1; SUGGEST.items = [];
    return;
  }
  SUGGEST.items = items.slice(0, 20);
  SUGGEST.idx = -1;
  for (const name of SUGGEST.items){
    const div = document.createElement('div');
    div.className = 'item'; div.textContent = name;
    // unified pointer/touch + click handling (mobile-safe)
    let picked = false;
    const doPick = ()=>{ if (picked) return; picked = true; pickSuggest(name); };
    div.addEventListener('pointerdown', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
    div.addEventListener('mousedown', (e)=>{ e.preventDefault(); });
    div.addEventListener('touchstart', (e)=>{ e.preventDefault(); doPick(); }, {passive:false});
    div.addEventListener('click', (e)=>{ e.preventDefault(); doPick(); }, {once:true});
    box.append(div);
  }
  box.hidden = false; SUGGEST.open = true;
}
function hideSuggest(){ const box = document.querySelector('#searchSuggest'); if (box){ box.hidden = true; box.innerHTML = ''; } SUGGEST.open=false; SUGGEST.idx=-1; SUGGEST.items=[]; }
function moveSuggest(delta){
  if (!SUGGEST.open) return;
  const box = document.querySelector('#searchSuggest'); if (!box) return;
  const items = Array.from(box.querySelectorAll('.item'));
  if (!items.length) return;
  SUGGEST.idx = (SUGGEST.idx + delta + items.length) % items.length;
  items.forEach((el,i)=> el.classList.toggle('sel', i===SUGGEST.idx));
}
function pickSuggest(name){
  const input = document.querySelector('#search'); if (input){ input.value = name; }
  hideSuggest();
}
const requestSuggest = debounce(async (term)=>{
  term = (term||'').trim();
  if (!term){ hideSuggest(); return; }
  try {
    const data = await getJSON(`${API_BASE}/items?q=${encodeURIComponent(term)}&limit=50`);
    const names = Array.from(new Set((data.items||[]).map(it=>it.name).filter(Boolean)));
    showSuggest(names);
  } catch(e){ hideSuggest(); }
}, 180);

/* ---------- Move picking state ---------- */
const MOVE = { active:false, sourceCode:null, sku:null, maxQty:0, targetCode:null, reopenAfterPick:false };
const NEW_INBOUND = {
  date: '',
  items: [],
  selectedId: null,
  targetRackCode: '',
  picking: false,
  reopenAfterPick: false,
  actionMode: '',
  draftQty: '',
};

/* ---------- rack render ---------- */
function renderRack() {
  const host = document.querySelector('#rack');
  host.innerHTML = '';
  host.append(buildLegend());

  const queryUpper = (document.querySelector('#search')?.value || '').trim().toUpperCase();

  const frame = document.createElement('div');
  frame.className = 'rackBox';
  const sc = document.createElement('div');
  sc.className = 'rackScroll';

  const gridHeader = document.createElement('div');
  gridHeader.className = 'gridHeader';
  const spacer = document.createElement('div');
  spacer.className = 'colHeader spacer';
  gridHeader.append(spacer);

  const grid = document.createElement('div');
  grid.className = 'grid';

  const bays = Array.from({length: CONFIG.bays}, (_,i)=>i+1);
  const heights = CONFIG.level_heights_cm || {};
  const getH = (lv) => Number(heights[lv] ?? heights[String(lv)] ?? 100);
  const sumH = Array.from({length: CONFIG.levels},(_,i)=>getH(i+1)).reduce((a,b)=>a+b,0) || 1;

  // 추가: 상단→하단 순서 배열
  const levelsDesc = Array.from({ length: CONFIG.levels }, (_, i) => CONFIG.levels - i);

  const bayLbl = document.createElement('div');
  bayLbl.className = 'bay labels';

  // SR2: level(숫자) → A(최상)… 순서로 변환하는 헬퍼
  const sr2LevelToLetter = (lv) => String.fromCharCode(65 + (CONFIG.levels - lv));

  for (const level of levelsDesc) {
    const cell = document.createElement('div');
    cell.className = 'cell levelLabel';
    const ph = Math.max(44, CELL_BASE_HEIGHT * (getH(level) / sumH));
    cell.style.height = cell.style.minHeight = cell.style.maxHeight = ph + 'px';
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = (CURRENT_ROW === 'SR2')
      ? sr2LevelToLetter(level)   // A..F
      : `${level}층`;              // 숫자층
    cell.append(t);
    bayLbl.append(cell);
  }
  grid.append(bayLbl);

  let firstSelectedCode = CURRENT_CELL ? CURRENT_CELL.code : null;
  let firstMatchEl = null;

  for (const bay of bays) {
    const ch = document.createElement('div');
    ch.className = 'colHeader';
    ch.textContent = String(bay).padStart(2,'0');
    gridHeader.append(ch);

    const bayDiv = document.createElement('div');
    bayDiv.className = 'bay';

    for (let level=CONFIG.levels; level>=1; level--){
      const ci = CELLS.find(c => c.bay===bay && c.level===level);
      const cell = document.createElement('div');
      cell.className = 'cell';
      const ph = Math.max(44, CELL_BASE_HEIGHT * (getH(level) / sumH));
      cell.style.height = cell.style.minHeight = cell.style.maxHeight = ph + 'px';

      if (ci) {
        const isMatch = matchesQuery(ci, queryUpper);
        if (queryUpper && isMatch) cell.classList.add('match');
        if (queryUpper && !isMatch) cell.style.opacity = 0.14;

        const {fill, border} = colorByRate(ci.total_cm3, ci.capacity_cm3);
        cell.style.background = fill; cell.style.borderColor = border;

        const rate = Math.floor(occupancyRate(ci.total_cm3, ci.capacity_cm3));
        const mid = document.createElement('div');
        mid.className = 'rate';
        mid.textContent = `${rate}%`;
        cell.append(mid);

        const newInboundTargetVisible =
          NEW_INBOUND.targetRackCode &&
          (NEW_INBOUND.picking || (NEW_INBOUND.actionMode === 'inbound' && document.getElementById('dlgNewInboundProcess')?.open));
        if ((MOVE.active && MOVE.targetCode === ci.code) || (newInboundTargetVisible && NEW_INBOUND.targetRackCode === ci.code)) {
          cell.classList.add('target');
        }
        if (!MOVE.active && firstSelectedCode && firstSelectedCode === ci.code) cell.classList.add('selected');

        cell.addEventListener('click', ()=> {
          if (NEW_INBOUND.picking) {
            setNewInboundTarget(ci, cell);
            return;
          }
          if (MOVE.active) {
            setMoveTarget(ci, cell);
            return;
          }
          document.querySelectorAll('.cell.selected').forEach(el=>el.classList.remove('selected'));
          cell.classList.add('selected');
          showDetail(ci);
        });

        if (!firstMatchEl && cell.classList.contains('match')) firstMatchEl = cell;
        if (!MOVE.active && firstSelectedCode && firstSelectedCode === ci.code) {
          setTimeout(()=>{ showDetail(ci); }, 0);
        }
      }

      bayDiv.append(cell);
    }
    grid.append(bayDiv);
  }

  sc.append(gridHeader, grid);
  frame.append(sc);
  host.append(frame);

  syncHeaderSizes();
  window.addEventListener('resize', syncHeaderSizes, { passive:true });

  /* === [추가] 렌더 후 패딩 재적용 === */
  applyFooterSafePadding();

  if (firstMatchEl) firstMatchEl.scrollIntoView({behavior:'smooth', block:'center', inline:'center'});
}

function syncHeaderSizes(){
  const gridHeader = document.querySelector('.gridHeader');
  const labelBay   = document.querySelector('.grid .bay.labels');
  const bays       = Array.from(document.querySelectorAll('.grid .bay:not(.labels)'));
  if (!gridHeader || !labelBay || bays.length===0) return;

  const spacerW = Math.round(labelBay.getBoundingClientRect().width);
  const bayW    = Math.round(bays[0].getBoundingClientRect().width);

  gridHeader.style.display = 'grid';
  gridHeader.style.gridTemplateColumns = `${spacerW}px repeat(${bays.length}, ${bayW}px)`;
  gridHeader.style.columnGap = getComputedStyle(document.querySelector('.grid')).columnGap || '8px';

  const headers = Array.from(gridHeader.querySelectorAll('.colHeader'));
  headers.forEach((h, idx)=>{ h.style.width = (idx===0? spacerW : bayW) + 'px'; });
}

/* ---------- detail ---------- */
function showDetail(ci) {
  CURRENT_CELL = ci;
  CURRENT_ITEM_SKU = null;
  document.querySelector('#selTitle').textContent = `선택된 위치: ${ci.code}`;
  const rate = Math.floor(occupancyRate(ci.total_cm3, ci.capacity_cm3));
  const remain = Math.max(0, ci.capacity_cm3 - ci.total_cm3);
  document.querySelector('#selStats').textContent = `적재율: ${rate}% · 용량: ${fmtM3(ci.capacity_cm3)} · 사용: ${fmtM3(ci.total_cm3)} · 남은공간: ${fmtM3(remain)}`;
  document.querySelector('#barFill').style.width = Math.min(100, rate) + '%';

  const tb = document.querySelector('#tblItems tbody');
  tb.innerHTML = '';
  for (const it of (ci.items||[])) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div>${it.sku}</div><div class="muted">${it.location||''}</div></td>
                    <td>${it.name||''}</td>
                    <td style="text-align:center">${(it.qty??0).toLocaleString('ko-KR')}</td>`;
    tr.addEventListener('click', ()=> {
      tb.querySelectorAll('tr.sel').forEach(x=>x.classList.remove('sel'));
      tr.classList.add('sel');
      CURRENT_ITEM_SKU = it.sku;
    });
    tb.append(tr);
  }
  loadMovements().catch(err => console.warn('rack movement load failed', err));
}

function resetDetailPanel() {
  CURRENT_CELL = null;
  CURRENT_ITEM_SKU = null;
  document.querySelector('#selTitle').textContent = '선택된 위치: -';
  document.querySelector('#selStats').textContent = '적재율: - · 용량: - · 사용: - · 남은공간: -';
  document.querySelector('#barFill').style.width = '0%';
  const tb = document.querySelector('#tblItems tbody');
  if (tb) tb.innerHTML = '';
}

/* ---------- inbound / outbound / move ---------- */
async function openInbound() {
  if (!CURRENT_CELL) { alert('먼저 랙의 셀을 클릭해 선택하세요.'); return; }
  const dlg = ensureInboundDialog();
  const titleEl = dlg.querySelector('#dlgTitle');
  const list = dlg.querySelector('#dlgList');
  const qbox = dlg.querySelector('#dlgQuery');
  const qtyEl = dlg.querySelector('#dlgQty');
  if (!titleEl || !list || !qbox || !qtyEl) { alert('입고창 구성요소 오류'); return; }
  titleEl.textContent = `입고(${CURRENT_CELL.code})`;
  list.innerHTML = '';

  async function search() {
    const q = (qbox.value || '').trim();
    let url = `${API_BASE}/items?limit=500`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    const data = await getJSON(url);
    list.innerHTML = '';
    for (const it of (data.items || [])) {
      const row = document.createElement('div');
      row.className = 'item';
      const loc = it.location_code || it.location || '';
      row.innerHTML = `
        <div class="skuBlock">
          <div class="sku"><strong>${it.code}</strong></div>
          <div class="loc">${loc}</div>
        </div>
        <div class="name">${it.name || ''}</div>`;
      row.addEventListener('click', ()=>{
        list.querySelectorAll('.item.sel').forEach(x=>x.classList.remove('sel'));
        row.classList.add('sel');
      });
      list.append(row);
    }
    if (!list.children.length) list.innerHTML = '<div class="muted">표시할 상품이 없습니다.</div>';
  }

  dlg.querySelector('#dlgBtnSearch').onclick = (e)=>{ e.preventDefault(); search(); };
  dlg.querySelector('#dlgCancel').onclick = (e)=>{ e.preventDefault(); closeDialog(dlg); };
  dlg.querySelector('#dlgOk').onclick = async (e)=>{
    e.preventDefault();
    if (isDialogPending(dlg)) return;
    const selRow = list.querySelector('.item.sel');
    if (!selRow) { alert('아이템을 선택하세요.'); return; }
    const code = selRow.querySelector('strong').textContent.trim();
    const qty = Math.max(1, parseInt(qtyEl.value||'1',10));
    try {
      setDialogPending(dlg, true, '#dlgOk');
      await postJSON(`${API_BASE}/inbound`, { rack_code: CURRENT_CELL.code, item_code: code, qty });
      await loadMovements();
      await loadCells();
      const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
      if (found) showDetail(found);
      alert(`[${CURRENT_CELL.code}] 위치로 ${code} ${qty}개 입고 완료`);
      closeDialog(dlg);
      setDialogPending(dlg, false, '#dlgOk');
    } catch (err) {
      setDialogPending(dlg, false, '#dlgOk');
      alert('입고 실패: ' + (err.message || err));
    }
  };

  if (!dlg.open) openDialog(dlg);
  qbox.focus();
  await search();
}

/* === 출고 다이얼로그 === */
function ensureOutboundDialog(){
  let dlg = document.getElementById('dlgOutbound');
  if(!dlg){
    dlg = document.createElement('dialog');
    dlg.id = 'dlgOutbound';
    dlg.innerHTML = `
      <form method="dialog" class="dialog">
        <h3 id="outTitle">출고</h3>
        <div class="row"><div id="outMeta" class="muted"></div></div>
        <div class="row">
          <label>출고 수량 : <input id="outQty" type="number" min="1" step="1" value="1" /></label>
          <button id="outOk" value="ok">확인</button>
          <button id="outCancel">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }
  return dlg;
}
async function openOutbound(){
  if(!CURRENT_CELL) return alert('먼저 셀을 선택하세요.');
  if(!CURRENT_ITEM_SKU) return alert('출고할 상품을 표에서 선택하세요.');
  const item = (CURRENT_CELL.items||[]).find(it=>it.sku===CURRENT_ITEM_SKU);
  if(!item) return alert('선택한 상품을 찾을 수 없습니다.');

  const dlg = ensureOutboundDialog();
  const title = dlg.querySelector('#outTitle');
  const meta  = dlg.querySelector('#outMeta');
  const qtyEl = dlg.querySelector('#outQty');
  if(title) title.textContent = `출고(${CURRENT_CELL.code})`;
  if(meta)  meta.textContent  = `위치: ${CURRENT_CELL.code} · SKU: ${item.sku} · 보유: ${item.qty}개`;
  if(qtyEl){ qtyEl.min = 1; qtyEl.max = Math.max(1, item.qty); qtyEl.value = 1; }

  dlg.querySelector('#outCancel').onclick = (e)=>{ e.preventDefault(); closeDialog(dlg); };
  dlg.querySelector('#outOk').onclick = async (e)=>{
    e.preventDefault();
    if (isDialogPending(dlg)) return;
    const qty = Math.max(1, Math.min(item.qty, parseInt((qtyEl?.value)||'1',10)));
    try{
      setDialogPending(dlg, true, '#outOk');
      try {
        await postJSON(`${API_BASE}/outbound`, { rack_code: CURRENT_CELL.code, item_code: item.sku, qty });
        await loadMovements();
        await loadCells();
        const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
        if(found) showDetail(found);
        closeDialog(dlg);
      } finally {
        setDialogPending(dlg, false, '#outOk');
      }
    }catch(err){ alert('출고 실패: ' + (err.message||err)); }
  };

  openDialog(dlg);
  qtyEl?.focus();
}

/* === 이동 다이얼로그 === */
function ensureMoveDialog(){
  let dlg = document.getElementById('dlgMove');
  if(!dlg){
    dlg = document.createElement('dialog');
    dlg.id = 'dlgMove';
    dlg.innerHTML = `
      <form method="dialog" class="dialog">
        <h3 id="moveTitle">이동</h3>
        <div class="row"><div id="moveMeta" class="muted"></div></div>
        <div class="row" style="justify-content:space-between;">
          <div>대상: <strong id="moveTargetCode">-</strong></div>
          <div><button id="movePick" type="button">이동위치 선택</button></div>
        </div>
        <div class="row">
          <label>이동 수량 : <input id="moveQty" type="number" min="1" step="1" /></label>
          <button id="moveOk" value="ok">확인</button>
          <button id="moveCancel">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }
  return dlg;
}
function setMoveTarget(ci, cellEl){
  document.querySelectorAll('.cell.target').forEach(el=>el.classList.remove('target'));
  if(!ci) return;
  if (MOVE.sourceCode && MOVE.sourceCode === ci.code) return;
  MOVE.targetCode = ci.code;
  if(cellEl) cellEl.classList.add('target');
  const codeEl = document.getElementById('moveTargetCode');
  if(codeEl) codeEl.textContent = MOVE.targetCode;
  if (MOVE.reopenAfterPick){
    MOVE.reopenAfterPick = false;
    openMove(true);
  }
}
function resetMoveState(){
  MOVE.active = false;
  MOVE.sourceCode = null;
  MOVE.sku = null;
  MOVE.maxQty = 0;
  MOVE.targetCode = null;
  MOVE.reopenAfterPick = false;
  document.querySelectorAll('.cell.target').forEach(el=>el.classList.remove('target'));
}
async function openMove(preserve=false){
  if(!CURRENT_CELL) return alert('먼저 셀을 선택하세요.');
  if(!CURRENT_ITEM_SKU) return alert('이동할 상품을 표에서 선택하세요.');
  const item = (CURRENT_CELL.items||[]).find(it=>it.sku===CURRENT_ITEM_SKU);
  if(!item) return alert('선택한 상품을 찾을 수 없습니다.');

  if(!MOVE.active || !preserve){
    MOVE.active = true;
    MOVE.sourceCode = CURRENT_CELL.code;
    MOVE.sku = item.sku;
    MOVE.maxQty = item.qty;
    if(!preserve) MOVE.targetCode = null;
  }

  const dlg = ensureMoveDialog();
  const title   = dlg.querySelector('#moveTitle');
  const meta    = dlg.querySelector('#moveMeta');
  const codeEl  = dlg.querySelector('#moveTargetCode');
  const qtyEl   = dlg.querySelector('#moveQty');
  const pickBtn = dlg.querySelector('#movePick');

  if(title)  title.textContent = `이동(${MOVE.sourceCode})`;
  if(meta)   meta.textContent  = `FROM ${MOVE.sourceCode} · SKU: ${MOVE.sku} · 보유: ${MOVE.maxQty}개`;
  if(codeEl) codeEl.textContent = MOVE.targetCode || '-';

  if(qtyEl){
    qtyEl.min = 1;
    qtyEl.max = Math.max(1, MOVE.maxQty);
    if(!preserve || !qtyEl.value) qtyEl.value = MOVE.maxQty;
  }

  dlg.querySelector('#moveCancel').onclick = (e)=>{ e.preventDefault(); resetMoveState(); closeDialog(dlg); };
  dlg.querySelector('#moveOk').onclick = async (e)=>{
    e.preventDefault();
    if (isDialogPending(dlg)) return;
    if(!MOVE.targetCode) return alert('대상 위치를 선택하세요.');
    if(MOVE.targetCode === MOVE.sourceCode) return alert('같은 위치로는 이동할 수 없습니다.');
    let qty = parseInt((qtyEl?.value)||'1',10);
    if(!Number.isFinite(qty) || qty <= 0) qty = 1;
    if(qty > MOVE.maxQty) qty = MOVE.maxQty;
    try{
      setDialogPending(dlg, true, '#moveOk');
      try {
        await postJSON(`${API_BASE}/move`, { from_rack: MOVE.sourceCode, to_rack: MOVE.targetCode, item_code: MOVE.sku, qty });
        await loadMovements();
        await loadCells();
        const found = CELLS.find(c=>c.code===MOVE.sourceCode);
        if(found) showDetail(found);
        resetMoveState();
        closeDialog(dlg);
      } finally {
        setDialogPending(dlg, false, '#moveOk');
      }
    }catch(err){ alert('이동 실패: ' + (err.message||err)); }
  };
  if (pickBtn){
    pickBtn.onclick = (e)=>{
      e.preventDefault();
      MOVE.reopenAfterPick = true;
      closeDialog(dlg);
    };
  }

  openDialog(dlg);
}

function isDesktopDevice(){
  const coarse = window.matchMedia ? window.matchMedia('(pointer:coarse)').matches : false;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  return !coarse && !mobileUa;
}

function todayYmd(){
  const now = new Date();
  const yy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function arrayBufferToBase64(buffer){
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeExcelHeader(value){
  return String(value ?? '').replace(/\s+/g, '').trim().toLowerCase();
}

function findInboundHeaderIndex(headerRow, candidates, excludes = []){
  const normalized = headerRow.map((value)=> normalizeExcelHeader(value));
  const deny = excludes.map((value)=> normalizeExcelHeader(value));
  for (const candidate of candidates.map((value)=> normalizeExcelHeader(value))) {
    const exactIndex = normalized.findIndex((value)=> value === candidate);
    if (exactIndex >= 0) return exactIndex;
  }
  for (const candidate of candidates.map((value)=> normalizeExcelHeader(value))) {
    const fuzzyIndex = normalized.findIndex((value)=>
      value.includes(candidate) && !deny.some((blocked)=> blocked && value.includes(blocked))
    );
    if (fuzzyIndex >= 0) return fuzzyIndex;
  }
  return -1;
}

function toExcelNumber(value){
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const parsed = Number.parseFloat(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed);
}

async function extractInboundRowsFromExcel(file){
  if (!window.XLSX) {
    throw new Error('엑셀 파서 라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: 'array' });
  const rows = [];

  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const matrix = window.XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
    });
    const headerRow = matrix[1] || [];
    const productIndex = findInboundHeaderIndex(headerRow, ['품명'], ['영어품명']);
    const detailIndex = findInboundHeaderIndex(headerRow, ['상세수량']);
    const boxIndex = findInboundHeaderIndex(headerRow, ['박스수']);
    if (productIndex < 0 || detailIndex < 0 || boxIndex < 0) continue;

    for (const row of matrix.slice(2)) {
      const productName = String(row?.[productIndex] ?? '').trim();
      const inboundQty = toExcelNumber(row?.[detailIndex]);
      const boxQty = toExcelNumber(row?.[boxIndex]);
      if (!productName && !inboundQty && !boxQty) continue;
      if (!productName) continue;
      rows.push({
        product_name: productName,
        inbound_qty: inboundQty,
        pending_qty: inboundQty,
        box_qty: boxQty,
        source_sheet: sheetName,
      });
    }
  }

  if (!rows.length) {
    throw new Error('엑셀에서 품명, 상세수량, 박스수 데이터를 찾지 못했습니다.');
  }
  return rows;
}

function getNewInboundSelectedItem(){
  return (NEW_INBOUND.items || []).find(item => item.id === NEW_INBOUND.selectedId) || null;
}

function updateNewInboundActionButtons(){
  const dlg = document.getElementById('dlgNewInbound');
  if (!dlg) return;
  const selected = getNewInboundSelectedItem();
  const hasSelectable = Boolean(selected);
  const displayBtn = dlg.querySelector('#btnNewInboundDisplay');
  const inboundBtn = dlg.querySelector('#btnNewInboundInbound');
  if (displayBtn) displayBtn.disabled = !hasSelectable;
  if (inboundBtn) inboundBtn.disabled = !hasSelectable;
}

function renderNewInboundTable(){
  const dlg = document.getElementById('dlgNewInbound');
  if (!dlg) return;
  const tbody = dlg.querySelector('#tblNewInbound tbody');
  const meta = dlg.querySelector('#newInboundSource');
  if (!tbody || !meta) return;

  tbody.innerHTML = '';
  const items = NEW_INBOUND.items || [];
  meta.textContent = items.length
    ? `${items.length.toLocaleString('ko-KR')}건 · ${dlg.dataset.sourceName || '저장된 리스트'}`
    : '저장된 리스트가 없습니다.';

  for (const item of items) {
    const tr = document.createElement('tr');
    if (item.id === NEW_INBOUND.selectedId) tr.classList.add('sel');
    tr.innerHTML = `
      <td>${item.sku_code || '-'}</td>
      <td>${item.product_name || ''}</td>
      <td class="r">${Number(item.box_qty || 0).toLocaleString('ko-KR')}</td>
      <td class="r">${Number(item.inbound_qty || 0).toLocaleString('ko-KR')}</td>
      <td class="r">${Number(item.pending_qty || 0).toLocaleString('ko-KR')}</td>
    `;
    tr.addEventListener('click', ()=>{
      NEW_INBOUND.selectedId = item.id;
      renderNewInboundTable();
      updateNewInboundActionButtons();
    });
    tbody.append(tr);
  }

  if (!items.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="muted" style="text-align:center;">선택한 날짜에 저장된 신규입고리스트가 없습니다.</td>';
    tbody.append(tr);
  }

  updateNewInboundActionButtons();
}

async function fetchNewInboundList(dateText){
  const data = await getJSON(`${API_BASE}/new_inbound_list?date=${encodeURIComponent(dateText)}`);
  NEW_INBOUND.date = data.date || dateText;
  NEW_INBOUND.items = data.items || [];
  NEW_INBOUND.selectedId = (NEW_INBOUND.items || []).some(item => item.id === NEW_INBOUND.selectedId)
    ? NEW_INBOUND.selectedId
    : ((NEW_INBOUND.items[0] && NEW_INBOUND.items[0].id) || null);
  const dlg = document.getElementById('dlgNewInbound');
  if (dlg) dlg.dataset.sourceName = data.source_name || '저장된 리스트';
  renderNewInboundTable();
}

async function importNewInboundExcel(file){
  if (!file) return;
  if (!/\.xlsx$|\.xlsm$|\.xltx$|\.xltm$/i.test(file.name || '')) {
    alert('현재는 .xlsx 계열 엑셀 파일만 불러올 수 있습니다.');
    return;
  }
  const dlg = ensureNewInboundDialog();
  const dateInput = dlg.querySelector('#newInboundDate');
  const dateText = (dateInput?.value || NEW_INBOUND.date || todayYmd()).trim();
  try {
    setDialogPending(dlg, true, '#newInboundImport', '불러오는 중...');
    const rows = await extractInboundRowsFromExcel(file);
    const data = await postJSON(`${API_BASE}/new_inbound_list/import`, {
      date: dateText,
      filename: file.name || '',
      rows,
    });
    NEW_INBOUND.date = data.date || dateText;
    NEW_INBOUND.items = data.items || [];
    NEW_INBOUND.selectedId = (NEW_INBOUND.items[0] && NEW_INBOUND.items[0].id) || null;
    dlg.dataset.sourceName = data.source_name || file.name || '엑셀 불러오기';
    if (dateInput) dateInput.value = NEW_INBOUND.date;
    renderNewInboundTable();
  } catch (err) {
    alert('신규입고 엑셀 불러오기 실패: ' + (err.message || err));
  } finally {
    setDialogPending(dlg, false, '#newInboundImport');
    const fileInput = dlg.querySelector('#newInboundFile');
    if (fileInput) fileInput.value = '';
  }
}

async function resetNewInboundDate(){
  const dlg = ensureNewInboundDialog();
  const dateInput = dlg.querySelector('#newInboundDate');
  const dateText = (dateInput?.value || NEW_INBOUND.date || todayYmd()).trim();
  if (!dateText) {
    alert('초기화할 날짜를 먼저 선택하세요.');
    return;
  }
  if (!confirm(`${dateText} 날짜의 신규입고 데이터를 초기화할까요?`)) {
    return;
  }
  try {
    setDialogPending(dlg, true, '#newInboundImport', '초기화 중...');
    const data = await postJSON(`${API_BASE}/new_inbound_list/import`, {
      date: dateText,
      filename: '',
      rows: [],
    });
    NEW_INBOUND.date = data.date || dateText;
    NEW_INBOUND.items = data.items || [];
    NEW_INBOUND.selectedId = null;
    dlg.dataset.sourceName = '저장된 리스트';
    if (dateInput) dateInput.value = NEW_INBOUND.date;
    renderNewInboundTable();
  } catch (err) {
    alert('신규입고 데이터 초기화 실패: ' + (err.message || err));
  } finally {
    setDialogPending(dlg, false, '#newInboundImport');
  }
}

function ensureNewInboundDialog(){
  let dlg = document.getElementById('dlgNewInbound');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlgNewInbound';
    dlg.innerHTML = `
      <form method="dialog" class="dialog new-inbound-dialog">
        <h3>신규입고리스트</h3>
        <div class="row new-inbound-toolbar">
          <label class="new-inbound-date-field">날짜 <input id="newInboundDate" type="date" /></label>
          <button id="newInboundImport" type="button">불러오기</button>
          <button id="newInboundReset" type="button">초기화</button>
          <input id="newInboundFile" type="file" accept=".xlsx,.xlsm,.xltx,.xltm" hidden />
          <div id="newInboundSource" class="muted"></div>
        </div>
        <div class="new-inbound-table-wrap">
          <table id="tblNewInbound">
            <thead>
              <tr>
                <th>skucode</th>
                <th>상품명</th>
                <th class="r">박스수량</th>
                <th class="r">입고수량</th>
                <th class="r">미처리수량</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="row new-inbound-actions">
          <button id="btnNewInboundDisplay" type="button">진열</button>
          <button id="btnNewInboundInbound" type="button">입고</button>
          <button id="btnNewInboundClose" type="button">닫기</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }

  if (!dlg.__bound) {
    dlg.__bound = true;
    const dateInput = dlg.querySelector('#newInboundDate');
    const importBtn = dlg.querySelector('#newInboundImport');
    const resetBtn = dlg.querySelector('#newInboundReset');
    const closeBtn = dlg.querySelector('#btnNewInboundClose');
    const displayBtn = dlg.querySelector('#btnNewInboundDisplay');
    const inboundBtn = dlg.querySelector('#btnNewInboundInbound');
    const fileInput = dlg.querySelector('#newInboundFile');

    if (dateInput) {
      dateInput.addEventListener('change', async ()=>{
        const nextDate = (dateInput.value || '').trim();
        if (!nextDate) return;
        try {
          setDialogPending(dlg, true, '#newInboundImport', '불러오는 중...');
          await fetchNewInboundList(nextDate);
        } catch (err) {
          alert('신규입고리스트 조회 실패: ' + (err.message || err));
        } finally {
          setDialogPending(dlg, false, '#newInboundImport');
        }
      });
      dateInput.addEventListener('click', ()=>{
        if (typeof dateInput.showPicker === 'function') {
          try { dateInput.showPicker(); } catch (_) {}
        }
      });
    }

    if (importBtn) {
      importBtn.addEventListener('click', ()=>{
        if (!isDesktopDevice()) return;
        fileInput?.click();
      });
    }

    resetBtn?.addEventListener('click', ()=>{
      resetNewInboundDate().catch(err=>alert(err.message || err));
    });

    fileInput?.addEventListener('change', ()=>{
      const file = fileInput.files && fileInput.files[0];
      importNewInboundExcel(file);
    });

    closeBtn?.addEventListener('click', ()=>{
      closeDialog(dlg);
    });
    displayBtn?.addEventListener('click', ()=>{
      openNewInboundProcessDialog('display').catch(err=>alert(err.message || err));
    });
    inboundBtn?.addEventListener('click', ()=>{
      openNewInboundProcessDialog('inbound').catch(err=>alert(err.message || err));
    });
  }

  const importBtn = dlg.querySelector('#newInboundImport');
  const resetBtn = dlg.querySelector('#newInboundReset');
  if (importBtn) {
    importBtn.disabled = !isDesktopDevice();
    importBtn.title = isDesktopDevice() ? '엑셀 파일을 불러옵니다.' : 'PC에서만 엑셀 불러오기를 사용할 수 있습니다.';
  }
  if (resetBtn) {
    resetBtn.title = '선택한 날짜의 신규입고 데이터를 비웁니다.';
  }
  return dlg;
}

async function openNewInboundDialog(){
  const dlg = ensureNewInboundDialog();
  const dateInput = dlg.querySelector('#newInboundDate');
  const targetDate = NEW_INBOUND.date || todayYmd();
  if (dateInput) dateInput.value = targetDate;
  if (!dlg.open) openDialog(dlg);
  try {
    setDialogPending(dlg, true, '#newInboundImport', '불러오는 중...');
    await fetchNewInboundList(targetDate);
  } catch (err) {
    alert('신규입고리스트 조회 실패: ' + (err.message || err));
  } finally {
    setDialogPending(dlg, false, '#newInboundImport');
  }
}

function ensureNewInboundProcessDialog(){
  let dlg = document.getElementById('dlgNewInboundProcess');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlgNewInboundProcess';
    dlg.innerHTML = `
      <form method="dialog" class="dialog new-inbound-process-dialog">
        <h3 id="newInboundProcessTitle">처리</h3>
        <div class="row"><div id="newInboundProcessMeta" class="muted"></div></div>
        <div class="row">
          <label>수량 <input id="newInboundProcessQty" type="number" min="1" step="1" value="1" /></label>
        </div>
        <div class="row" id="newInboundRackRow" hidden>
          <div>선택된 렉: <strong id="newInboundRackCode">-</strong></div>
          <button id="newInboundPickRack" type="button">위치선택</button>
        </div>
        <div class="row">
          <button id="newInboundProcessOk" value="ok">확인</button>
          <button id="newInboundProcessCancel" type="button">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }
  return dlg;
}

function setNewInboundTarget(ci, cellEl){
  document.querySelectorAll('.cell.target').forEach(el=>el.classList.remove('target'));
  NEW_INBOUND.targetRackCode = ci.code;
  NEW_INBOUND.picking = false;
  if (cellEl) cellEl.classList.add('target');
  if (NEW_INBOUND.reopenAfterPick) {
    NEW_INBOUND.reopenAfterPick = false;
    openNewInboundProcessDialog('inbound', true).catch(err=>alert(err.message || err));
  }
}

async function openNewInboundProcessDialog(mode, preserveDraft=false){
  const item = getNewInboundSelectedItem();
  if (!item) {
    alert('처리할 항목을 먼저 선택하세요.');
    return;
  }
  if (!(Number(item.pending_qty || 0) > 0)) {
    alert('미처리수량이 0인 항목은 처리할 수 없습니다.');
    return;
  }

  NEW_INBOUND.actionMode = mode;
  NEW_INBOUND.picking = false;

  const listDlg = ensureNewInboundDialog();
  if (listDlg.open) closeDialog(listDlg);

  const dlg = ensureNewInboundProcessDialog();
  const titleEl = dlg.querySelector('#newInboundProcessTitle');
  const metaEl = dlg.querySelector('#newInboundProcessMeta');
  const qtyEl = dlg.querySelector('#newInboundProcessQty');
  const rackRow = dlg.querySelector('#newInboundRackRow');
  const rackCodeEl = dlg.querySelector('#newInboundRackCode');
  const pickBtn = dlg.querySelector('#newInboundPickRack');
  const cancelBtn = dlg.querySelector('#newInboundProcessCancel');
  const okBtn = dlg.querySelector('#newInboundProcessOk');

  if (titleEl) titleEl.textContent = mode === 'display' ? '진열' : '입고';
  if (metaEl) {
    metaEl.style.whiteSpace = 'pre-line';
    metaEl.textContent =
      `상품코드: ${item.sku_code || '-'}\n` +
      `상품명: ${item.product_name || '-'}\n` +
      `수량: ${Number(item.pending_qty || 0).toLocaleString('ko-KR')}`;
  }
  if (qtyEl) {
    qtyEl.min = '1';
    qtyEl.max = String(Math.max(1, Number(item.pending_qty || 0)));
    qtyEl.value = preserveDraft && NEW_INBOUND.draftQty
      ? String(NEW_INBOUND.draftQty)
      : String(Math.max(1, Number(item.pending_qty || 0)));
  }

  const inboundMode = mode === 'inbound';
  if (rackRow) rackRow.hidden = !inboundMode;
  if (rackCodeEl) rackCodeEl.textContent = NEW_INBOUND.targetRackCode || '-';

  if (pickBtn) {
    pickBtn.onclick = (e)=>{
      e.preventDefault();
      NEW_INBOUND.draftQty = qtyEl?.value || '';
      NEW_INBOUND.picking = true;
      NEW_INBOUND.reopenAfterPick = true;
      closeDialog(dlg);
      alert('현황판에서 입고할 렉을 선택하세요.');
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = (e)=>{
      e.preventDefault();
      NEW_INBOUND.picking = false;
      NEW_INBOUND.reopenAfterPick = false;
      NEW_INBOUND.actionMode = '';
      NEW_INBOUND.draftQty = '';
      closeDialog(dlg);
      openNewInboundDialog().catch(err=>alert(err.message || err));
    };
  }

  if (okBtn) {
    okBtn.onclick = async (e)=>{
      e.preventDefault();
      if (isDialogPending(dlg)) return;
      let qty = parseInt((qtyEl?.value || '0').trim(), 10);
      if (!Number.isFinite(qty) || qty <= 0) qty = 1;
      if (qty > Number(item.pending_qty || 0)) qty = Number(item.pending_qty || 0);
      if (inboundMode && !NEW_INBOUND.targetRackCode) {
        alert('입고할 렉을 먼저 선택하세요.');
        return;
      }
      try {
        setDialogPending(dlg, true, '#newInboundProcessOk');
        const data = await postJSON(`${API_BASE}/new_inbound_list/process`, {
          date: NEW_INBOUND.date,
          entry_id: item.id,
          action: mode,
          qty,
          rack_code: inboundMode ? NEW_INBOUND.targetRackCode : '',
        });

        NEW_INBOUND.items = data.list?.items || [];
        NEW_INBOUND.selectedId = (NEW_INBOUND.items || []).some(entry => entry.id === item.id)
          ? item.id
          : ((NEW_INBOUND.items[0] && NEW_INBOUND.items[0].id) || null);
        NEW_INBOUND.actionMode = '';
        NEW_INBOUND.draftQty = '';
        renderNewInboundTable();
        closeDialog(dlg);

        if (inboundMode && data.row) {
          const rowSelect = document.querySelector('#rowSelect');
          if (rowSelect && rowSelect.value !== data.row) {
            rowSelect.value = data.row;
          }
          await loadCells();
          const targetCell = CELLS.find(ci => ci.code === NEW_INBOUND.targetRackCode);
          if (targetCell) {
            CURRENT_CELL = targetCell;
            renderRack();
            showDetail(targetCell);
          } else {
            renderRack();
          }
        }

        await openNewInboundDialog();
      } catch (err) {
        alert((mode === 'display' ? '진열' : '입고') + ' 처리 실패: ' + (err.message || err));
      } finally {
        setDialogPending(dlg, false, '#newInboundProcessOk');
      }
    };
  }

  openDialog(dlg);
}

/* ---------- results list below rack ---------- */
function clearResults(){
  const sec = document.querySelector('#searchResults');
  const tb = document.querySelector('#tblResults tbody');
  if (tb) tb.innerHTML = '';
  if (sec) sec.hidden = true;
  const meta = document.querySelector('#resultsMeta'); if (meta) meta.textContent = '-';
}
async function renderSearchResults(query){
  const sec = document.querySelector('#searchResults');
  const tb = document.querySelector('#tblResults tbody');
  const meta = document.querySelector('#resultsMeta');
  if (!sec || !tb || !meta) return;
  tb.innerHTML = '';
  if (!query) { sec.hidden = true; meta.textContent='-'; return; }

  const data = await getJSON(`${API_BASE}/search_racks?q=${encodeURIComponent(query)}&limit=1000`);
  const results = data.results || [];
  meta.textContent = results.length ? `${results.length.toLocaleString('ko-KR')}건` : '결과 없음';
  sec.hidden = false;

  for (const r of results){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.rack_code}</td>
                    <td><div>${r.sku}</div><div class="muted">${r.location||''}</div></td>
                    <td>${r.name||''}</td>
                    <td class="r">${(r.qty||0).toLocaleString('ko-KR')}</td>`;
    tr.addEventListener('click', async ()=>{
      try{
        const rowLabel = r.row || r.rack_code.split('-')[0];
        const rs = document.querySelector('#rowSelect');
        if (rs && rs.value !== rowLabel) { rs.value = rowLabel; await loadCells(); }
        else { await loadCells(); }
        const cell = CELLS.find(c=>c.code===r.rack_code);
        if (cell){
          CURRENT_CELL = cell;
          renderRack();
          setTimeout(()=>{
            const selected = document.querySelector('.cell.selected');
            if (selected) selected.scrollIntoView({behavior:'smooth', block:'center', inline:'center'});
            showDetail(cell);
          }, 50);
        }
      }catch(e){ console.error(e); }
    });
    tb.append(tr);
  }
}

function formatMovementType(type){
  switch (type) {
    case 'inbound': return '입고';
    case 'outbound': return '출고';
    case 'move': return '이동';
    case 'set_location': return '위치변경';
    default: return type || '-';
  }
}

function formatMovementTarget(item){
  if (!item) return '-';
  if (item.movement_type === 'move') {
    return `${item.from_rack || '-'} -> ${item.to_rack || '-'}`;
  }
  if (item.movement_type === 'set_location') {
    return item.note || item.payload?.location || '-';
  }
  return item.rack_code || item.payload?.rack_code || '-';
}

function formatMovementDate(value){
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yy}.${mm}.${dd}(${hh}:${mi})`;
}

function renderMovements(){
  const section = document.querySelector('#movementLog');
  const tbody = document.querySelector('#tblMovements tbody');
  if (!section || !tbody) return;

  tbody.innerHTML = '';
  if (!MOVEMENTS.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  for (const item of MOVEMENTS) {
    const userLabel = item.actor_name || '-';
    const nameLabel = item.item_name ? `${item.item_code} / ${item.item_name}` : (item.item_code || '-');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatMovementDate(item.created_at)}</td>
      <td>${userLabel}</td>
      <td>${formatMovementType(item.movement_type)}</td>
      <td>${nameLabel}</td>
      <td class="r">${Number(item.quantity || 0).toLocaleString('ko-KR')}</td>
      <td>${formatMovementTarget(item)}</td>
    `;
    tbody.append(tr);
  }
}

async function loadMovements(){
  const params = new URLSearchParams();
  params.set('limit', CURRENT_CELL?.code ? '200' : '200');
  if (CURRENT_CELL?.code) {
    params.set('rack_code', CURRENT_CELL.code);
  }
  const data = await getJSON(`${API_BASE}/movements?${params.toString()}`);
  MOVEMENTS = data.items || [];
  renderMovements();
}

/* ---------- data ---------- */
async function loadCells() {
  const row = document.querySelector('#rowSelect').value;
  CURRENT_ROW = row;
  const data = await getJSON(`${API_BASE}/cells?row=${encodeURIComponent(row)}`);

  // 행별 그리드 크기 반영
  CONFIG.bays   = data.bays   ?? CONFIG.bays;
  CONFIG.levels = data.levels ?? CONFIG.levels;

  CELLS = data.cells || [];
  renderRack();
}
/* ---------- footer actions (bottom bar) ---------- */
function ensureFooterActions(){
  if (document.getElementById('footerActions')) return;

  // 스타일(없으면 주입) — 상단 버튼(입고/출고/이동)과 비슷한 아웃라인 톤
  if (!document.getElementById('footerActionsStyle')) {
    const st = document.createElement('style');
    st.id = 'footerActionsStyle';
    st.textContent = `
        /* 하단 바 높이를 변수로 관리(+ 노치 대응) */
        :root{
          --footer-h: 64px; /* JS로 실제 높이로 재설정됨 */
          --footer-safe: calc(var(--footer-h) + env(safe-area-inset-bottom, 0px));
        }

        /* 페이지 전체 기본 여백(바가 body를 덮는 경우 대비) */
        body{ padding-bottom: var(--footer-safe); }

        /* 주요 내부 스크롤 컨테이너에도 하단 여백을 부여 */
        .rackScroll{ padding-bottom: var(--footer-safe); }

        /* (안전망) 상세 패널이 자체 스크롤이면 아래 선택자 중 하나가 적용됨 */
        #selPanel, .detail, .detailScroll{ padding-bottom: var(--footer-safe); }

        .footer-actions{
          position:fixed; left:0; right:0; bottom:0;
          display:flex; gap:8px; padding:10px 12px;
          border-top:1px solid #e5e7eb;
          background:rgba(255,255,255,.94);
          backdrop-filter:saturate(120%) blur(6px);
          z-index:1000;
        }
        .footer-actions .btn{
          flex:1;
          display:inline-flex; align-items:center; justify-content:center;
          padding:10px 12px;
          border-radius:10px;
          border:1px solid #cbd5e1;
          background:#ffffff;
          font-weight:600;
          line-height:1.2;
          cursor:pointer;
          user-select:none;
          transition:background-color .15s ease, border-color .15s ease, box-shadow .15s ease;
        }
        .footer-actions .btn:hover{
          background:#f1f5f9;
          border-color:#94a3b8;
        }
        .footer-actions .btn:active{
          background:#e2e8f0;
        }
        @media (pointer:coarse){
          .footer-actions .btn{ padding:14px; }
        }
      `;
    document.head.append(st);
  }

  // 바 생성 (아이콘 제거, ‘primary’ 제거 -> 둘 다 동일 분위기)
  const bar = document.createElement('div');
  bar.id = 'footerActions';
  bar.className = 'footer-actions';
  bar.innerHTML = `
    <button id="btnFooterSearch" class="btn">재고검색</button>
    <button id="btnFooterNewInbound" class="btn">신규입고</button>
    <button id="btnFooterGoLocation" class="btn">로케이션코드입력</button>
  `;
  document.body.append(bar);
}


/* ---------- init ---------- */
async function init() {
  if (window.WarehouseAuth && typeof window.WarehouseAuth.requireSession === 'function') {
    await window.WarehouseAuth.requireSession();
    window.WarehouseAuth.render?.();
  }

  try {
    CONFIG = await getJSON(`${API_BASE}/config`);
  } catch (err) {
    console.warn('config 불러오기 실패. 기본값으로 진행:', err);
    CONFIG = {
      rows: ['SR1','SR2','SR3'],     // <- 최신 포맷로 교체
      bays: 21,
      levels: 3,
      level_heights_cm: {1: 100, 2: 95, 3: 110},
      rate_low_max: 30,
      rate_normal_max: 70,
    };
  }
  CONFIG.rate_low_max = CONFIG.rate_low_max ?? 30;
  CONFIG.rate_normal_max = CONFIG.rate_normal_max ?? 70;
  CONFIG.level_heights_cm = CONFIG.level_heights_cm || {1: 100, 2: 95, 3: 110};

  const rs = document.querySelector('#rowSelect'); rs.innerHTML = '';
  for (const r of CONFIG.rows) {
    const o = document.createElement('option'); o.value = o.textContent = r; rs.append(o);
  }
  rs.value = CONFIG.rows[0];
  rs.addEventListener('change', async ()=>{ await loadCells(); clearResults(); });

  document.querySelector('#btnReload').addEventListener('click', async ()=>{
    const searchInput = document.querySelector('#search');
    if (searchInput) searchInput.value = '';
    hideSuggest();
    clearResults();
    resetDetailPanel();
    await loadCells();
    await loadMovements();
  });
  async function handleSearch(){
    renderRack();
    const q = (document.querySelector('#search')?.value || '').trim();
    await renderSearchResults(q);
  }
  document.querySelector('#btnSearch').addEventListener('click', e => { e.preventDefault(); hideSuggest(); handleSearch(); });
  document.querySelector('#search').addEventListener('keydown', e => { 
    if (e.key==='ArrowDown'){ e.preventDefault(); moveSuggest(+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); moveSuggest(-1); return; }
    if (e.key==='Enter'){
      if (SUGGEST.open && SUGGEST.idx>=0){ 
        const box=document.querySelector('#searchSuggest'); 
        const cur=box?.querySelectorAll('.item')[SUGGEST.idx]; 
        if (cur){ pickSuggest(cur.textContent||''); return; } 
      }
      e.preventDefault(); hideSuggest(); handleSearch(); return; }
    if (e.key==='Escape'){ hideSuggest(); }
  });
  document.querySelector('#search').addEventListener('input', e => { requestSuggest(e.target.value); });
  document.addEventListener('click', (ev)=>{
    const box = sel('#searchSuggest'); const input = sel('#search');
    if (!box) return; const within = box.contains(ev.target) || input.contains(ev.target);
    if (!within) hideSuggest();
  });
  document.addEventListener('pointerdown', (ev)=>{
    const box = sel('#searchSuggest'); const input = sel('#search');
    if (!box) return; const within = box.contains(ev.target) || input.contains(ev.target);
    if (!within) hideSuggest();
  }, {passive:true});

  document.querySelector('#btnInbound').addEventListener('click', ()=>{ openInbound().catch(err=>alert('입고창 오류: '+(err.message||err))); });
  document.querySelector('#btnOutbound').addEventListener('click', ()=> openOutbound().catch(err=>alert(err.message||err)));
  document.querySelector('#btnMove').addEventListener('click', ()=> openMove().catch(err=>alert(err.message||err)));

  /* === [추가] 하단 고정 버튼 생성 및 동작 === */
  ensureFooterActions();

  /* === [추가] 초기 1회 패딩 적용 & 리사이즈 대응 === */
  applyFooterSafePadding();
  window.addEventListener('resize', applyFooterSafePadding, { passive:true });



  // [재고검색] -> 검색창으로 스크롤 & 포커스
  document.getElementById('btnFooterSearch')?.addEventListener('click', () => {
    // 변경: 검색 전용 다이얼로그 오픈 (상품명 | 수량 표시)
    openSearchDialog().catch(err => alert('검색창 오류: ' + (err.message || err)));
  });

  document.getElementById('btnFooterNewInbound')?.addEventListener('click', () => {
    openNewInboundDialog().catch(err => alert('신규입고리스트 오류: ' + (err.message || err)));
  });

  // [로케이션코드입력] -> 코드 입력 받아 해당 위치로 점프
  document.querySelector('#btnFooterGoLocation')?.addEventListener('click', ()=>{
    openLocationDialog().catch(err => alert('창 열기 오류: ' + (err.message || err)));
  });

  await loadCells();
  try {
    await loadMovements();
  } catch (err) {
    console.warn('recent movements load failed', err);
    MOVEMENTS = [];
    renderMovements();
  }
  clearResults();
}

/* === [신규] 스크롤 가능한 조상 찾기 === */
function findScrollableAncestor(el){
  let n = el;
  while (n && n !== document.body){
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY)) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/* === [신규] 하단 바 높이에 맞춰 안전 패딩 적용 === */
function applyFooterSafePadding(){
  const bar = document.getElementById('footerActions');
  const h = bar ? bar.offsetHeight : 72; // fallback
  // CSS 변수 업데이트
  document.documentElement.style.setProperty('--footer-h', `${h}px`);

  // 1) 랙 스크롤(동적으로 매 렌더 생성)
  document.querySelectorAll('.rackScroll').forEach(el=>{
    el.style.paddingBottom = `calc(${h}px + env(safe-area-inset-bottom, 0px))`;
  });

  // 2) 상세 리스트가 자체 스크롤이면 그 조상에 패딩 부여(테이블 기준으로 탐색)
  const tbl = document.getElementById('tblItems');
  if (tbl){
    const scroller = findScrollableAncestor(tbl);
    if (scroller){
      const cur = getComputedStyle(scroller).paddingBottom;
      scroller.style.paddingBottom = `calc(${h}px + env(safe-area-inset-bottom, 0px) + 12px)`;
    }
  }
}

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.unregister()));
    } catch (e) {
      console.error('SW 등록 실패', e);
    }
  });
}

/* ---------- boot ---------- */
function start() { init().catch(err => { console.error(err); alert('초기화 실패: ' + (err.message || err)); }); }
if (document.readyState === 'loading') { window.addEventListener('DOMContentLoaded', start); } else { start(); }
