// app.js — stable build with autocomplete & results list (v20250825-05)
const API_BASE = '/api';
const sel = s => document.querySelector(s);
const fmtM3 = cm3 => (cm3/1_000_000).toFixed(2) + ' m³';

const CELL_BASE_HEIGHT = 140;

let CONFIG = null;
let CELLS = [];
let CURRENT_ROW = null;
let CURRENT_CELL = null;
let CURRENT_ITEM_SKU = null;

/* ---------- dialog helpers ---------- */
let __dlgOverlay = null;
function openDialog(el) { if (el && typeof el.showModal === 'function') { el.showModal(); return; } if (!el) return; __dlgOverlay = document.createElement('div'); __dlgOverlay.className = 'backdrop'; document.body.append(__dlgOverlay); el.setAttribute('open',''); }
function closeDialog(el) { if (el && typeof el.close === 'function') { el.close(); return; } if (!el) return; el.removeAttribute('open'); if (__dlgOverlay) { __dlgOverlay.remove(); __dlgOverlay = null; } }

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
          <label>입고수량 : <input id="dlgQty" type="number" min="1" step="1" value="100" /></label>
          <button id="dlgOk" value="ok">확인</button>
          <button id="dlgCancel">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }
  return dlg;
}

/* ---------- fetch ---------- */
async function getJSON(url) {
  const u = new URL(url, location.origin);
  u.searchParams.set('_', Date.now());
  const r = await fetch(u.toString(), { cache:'no-store' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), cache:'no-store' });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.detail || r.statusText || '요청 실패');
  return data;
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
    (it.name && it.name.toUpperCase().includes(qUpper))
  );
}

/* ---------- autocomplete (suggest) ---------- */
const SUGGEST = { open:false, idx:-1, items:[] };
function debounce(fn, ms){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }
function showSuggest(items){
  const box = sel('#searchSuggest'); if (!box) return;
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
    div.addEventListener('mousedown', (e)=>{ e.preventDefault(); }); // prevent input blur
    div.addEventListener('click', ()=>{ pickSuggest(name); });
    box.append(div);
  }
  box.hidden = false; SUGGEST.open = true;
}
function hideSuggest(){ const box = sel('#searchSuggest'); if (box){ box.hidden = true; box.innerHTML = ''; } SUGGEST.open=false; SUGGEST.idx=-1; SUGGEST.items=[]; }
function moveSuggest(delta){
  if (!SUGGEST.open) return;
  const box = sel('#searchSuggest'); if (!box) return;
  const items = Array.from(box.querySelectorAll('.item'));
  if (!items.length) return;
  SUGGEST.idx = (SUGGEST.idx + delta + items.length) % items.length;
  items.forEach((el,i)=> el.classList.toggle('sel', i===SUGGEST.idx));
}
function pickSuggest(name){
  const input = sel('#search'); if (input){ input.value = name; }
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

/* ---------- rack render ---------- */
function renderRack() {
  const host = sel('#rack');
  host.innerHTML = '';
  host.append(buildLegend());

  const queryUpper = (sel('#search')?.value || '').trim().toUpperCase();

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

  const bayLbl = document.createElement('div');
  bayLbl.className = 'bay labels';
  for (let level=CONFIG.levels; level>=1; level--) {
    const cell = document.createElement('div');
    cell.className = 'cell levelLabel';
    const ph = Math.max(44, CELL_BASE_HEIGHT * (getH(level) / sumH));
    cell.style.height = cell.style.minHeight = cell.style.maxHeight = ph + 'px';
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = `${level}층`;
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

        if (MOVE.active && MOVE.targetCode === ci.code) cell.classList.add('target');
        if (!MOVE.active && firstSelectedCode && firstSelectedCode === ci.code) cell.classList.add('selected');

        cell.addEventListener('click', ()=> {
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
  sel('#selTitle').textContent = `선택된 위치: ${ci.code}`;
  const rate = Math.floor(occupancyRate(ci.total_cm3, ci.capacity_cm3));
  const remain = Math.max(0, ci.capacity_cm3 - ci.total_cm3);
  sel('#selStats').textContent = `적재율: ${rate}% · 용량: ${fmtM3(ci.capacity_cm3)} · 사용: ${fmtM3(ci.total_cm3)} · 남은공간: ${fmtM3(remain)}`;
  sel('#barFill').style.width = Math.min(100, rate) + '%';

  const tb = sel('#tblItems tbody');
  tb.innerHTML = '';
  for (const it of (ci.items||[])) {
    const tr = document.createElement('tr');
    // SKU 아래 location 출력
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
    const selRow = list.querySelector('.item.sel');
    if (!selRow) { alert('아이템을 선택하세요.'); return; }
    const code = selRow.querySelector('strong').textContent.trim();
    const qty = Math.max(1, parseInt(qtyEl.value||'1',10));
    try {
      await postJSON(`${API_BASE}/inbound`, { rack_code: CURRENT_CELL.code, item_code: code, qty });
      await loadCells();
      const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
      if (found) showDetail(found);
      alert(`[${CURRENT_CELL.code}] 위치로 ${code} ${qty}개 입고 완료`);
      closeDialog(dlg);
    } catch (err) {
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
    const qty = Math.max(1, Math.min(item.qty, parseInt((qtyEl?.value)||'1',10)));
    try{
      await postJSON(`${API_BASE}/outbound`, { rack_code: CURRENT_CELL.code, item_code: item.sku, qty });
      await loadCells();
      const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
      if(found) showDetail(found);
      closeDialog(dlg);
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
    if(!MOVE.targetCode) return alert('대상 위치를 선택하세요.');
    if(MOVE.targetCode === MOVE.sourceCode) return alert('같은 위치로는 이동할 수 없습니다.');
    let qty = parseInt((qtyEl?.value)||'1',10);
    if(!Number.isFinite(qty) || qty <= 0) qty = 1;
    if(qty > MOVE.maxQty) qty = MOVE.maxQty;
    try{
      await postJSON(`${API_BASE}/move`, { from_rack: MOVE.sourceCode, to_rack: MOVE.targetCode, item_code: MOVE.sku, qty });
      await loadCells();
      const found = CELLS.find(c=>c.code===MOVE.sourceCode);
      if(found) showDetail(found);
      resetMoveState();
      closeDialog(dlg);
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

/* ---------- results list below rack ---------- */
function clearResults(){
  const sec = sel('#searchResults');
  const tb = sel('#tblResults tbody');
  if (tb) tb.innerHTML = '';
  if (sec) sec.hidden = true;
  const meta = sel('#resultsMeta'); if (meta) meta.textContent = '-';
}
async function renderSearchResults(query){
  const sec = sel('#searchResults');
  const tb = sel('#tblResults tbody');
  const meta = sel('#resultsMeta');
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
        const rowLabel = r.row || r.rack_code.split('-').slice(0,2).join('-');
        const rs = sel('#rowSelect');
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

/* ---------- data ---------- */
async function loadCells() {
  const row = sel('#rowSelect').value;
  CURRENT_ROW = row;
  const data = await getJSON(`${API_BASE}/cells?row=${encodeURIComponent(row)}`);
  CELLS = data.cells || [];
  renderRack();
}

/* ---------- init ---------- */
async function init() {
  try {
    CONFIG = await getJSON(`${API_BASE}/config`);
  } catch (err) {
    console.warn('config 불러오기 실패. 기본값으로 진행:', err);
    CONFIG = {
      rows: ['SR-01','SR-02','SR-03'],
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

  const rs = sel('#rowSelect'); rs.innerHTML = '';
  for (const r of CONFIG.rows) {
    const o = document.createElement('option'); o.value = o.textContent = r; rs.append(o);
  }
  rs.value = CONFIG.rows[0];
  rs.addEventListener('change', async ()=>{ await loadCells(); clearResults(); });

  sel('#btnReload').addEventListener('click', async ()=>{ await loadCells(); });
  async function handleSearch(){
    renderRack();
    const q = (sel('#search')?.value || '').trim();
    await renderSearchResults(q);
  }
  sel('#btnSearch').addEventListener('click', e => { e.preventDefault(); hideSuggest(); handleSearch(); });
  sel('#search').addEventListener('keydown', e => { 
    if (e.key==='ArrowDown'){ e.preventDefault(); moveSuggest(+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); moveSuggest(-1); return; }
    if (e.key==='Enter'){
      if (SUGGEST.open && SUGGEST.idx>=0){ 
        const box=sel('#searchSuggest'); 
        const cur=box?.querySelectorAll('.item')[SUGGEST.idx]; 
        if (cur){ pickSuggest(cur.textContent||''); return; } 
      }
      e.preventDefault(); hideSuggest(); handleSearch(); return; }
    if (e.key==='Escape'){ hideSuggest(); }
  });
  sel('#search').addEventListener('input', e => { requestSuggest(e.target.value); });
  document.addEventListener('click', (ev)=>{
    const box = sel('#searchSuggest'); const input = sel('#search');
    if (!box) return; const within = box.contains(ev.target) || input.contains(ev.target);
    if (!within) hideSuggest();
  });

  sel('#btnInbound').addEventListener('click', ()=>{ openInbound().catch(err=>alert('입고창 오류: '+(err.message||err))); });
  sel('#btnOutbound').addEventListener('click', ()=> openOutbound().catch(err=>alert(err.message||err)));
  sel('#btnMove').addEventListener('click', ()=> openMove().catch(err=>alert(err.message||err)));

  await loadCells();
  clearResults();
}

/* ---------- Service Worker: auto-update & auto-reload ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && reg.waiting) {
            reg.waiting.postMessage('SKIP_WAITING');
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!window.__reloadedBySW) { window.__reloadedBySW = true; location.reload(); }
      });
      setTimeout(() => reg.update().catch(()=>{}), 1000);
    } catch (e) {
      console.error('SW 등록 실패', e);
    }
  });
}

/* ---------- boot ---------- */
function start() { init().catch(err => { console.error(err); alert('초기화 실패: ' + (err.message || err)); }); }
if (document.readyState === 'loading') { window.addEventListener('DOMContentLoaded', start); } else { start(); }
