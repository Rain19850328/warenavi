// r9 repack2: level & column labels + OCC-only view
const API_BASE = '/api';
const sel = s => document.querySelector(s);
const fmtM3 = cm3 => (cm3/1_000_000).toFixed(2) + ' m³';

const CELL_BASE_HEIGHT = 240;

let CONFIG = null;
let CELLS = [];
let CURRENT_ROW = null;
let CURRENT_CELL = null;
let CURRENT_ITEM_SKU = null;

let __dlgOverlay = null;
function openDialog(el) { if (el && typeof el.showModal === 'function') { el.showModal(); return; } if (!el) return; __dlgOverlay = document.createElement('div'); __dlgOverlay.className = 'backdrop'; document.body.append(__dlgOverlay); el.setAttribute('open',''); }
function closeDialog(el) { if (el && typeof el.close === 'function') { el.close(); return; } if (!el) return; el.removeAttribute('open'); if (__dlgOverlay) { __dlgOverlay.remove(); __dlgOverlay = null; } }
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
          <label>수량 <input id="dlgQty" type="number" min="1" step="1" value="100" /></label>
          <button id="dlgOk" value="ok">확인</button>
          <button id="dlgCancel">취소</button>
        </div>
      </form>`;
    document.body.append(dlg);
  }
  return dlg;
}

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(await r.text()); return r.json(); }
async function postJSON(url, body) { const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); if (!r.ok) throw new Error(await r.text()); return r.json(); }

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

// Search
function matchesQuery(ci, qUpper) {
  if (!qUpper) return true;
  if (ci.code && ci.code.toUpperCase().includes(qUpper)) return true;
  return ci.items.some(it =>
    (it.sku && it.sku.toUpperCase().includes(qUpper)) ||
    (it.name && it.name.toUpperCase().includes(qUpper))
  );
}

function renderRack() {
  const host = sel('#rack');
  host.innerHTML = '';
  host.append(buildLegend());

  const queryUpper = sel('#search').value.trim().toUpperCase();

  // wrapper with header + grid in same scroll container
  const frame = document.createElement('div');
  frame.className = 'rackBox';
  const sc = document.createElement('div');
  sc.className = 'rackScroll';

  // header (column numbers)
  const gridHeader = document.createElement('div');
  gridHeader.className = 'gridHeader';
  const spacer = document.createElement('div');
  spacer.className = 'colHeader spacer';
  spacer.textContent = ''; // left label column
  gridHeader.append(spacer);

  // main grid
  const grid = document.createElement('div');
  grid.className = 'grid';

  const bays = Array.from({length: CONFIG.bays}, (_,i)=>i+1);
  const heights = CONFIG.level_heights_cm;
  const sumH = Object.values(heights).reduce((a,b)=>a+b,0);

  // First sticky label column in grid
  const bayLbl = document.createElement('div');
  bayLbl.className = 'bay labels';
  for (let level=CONFIG.levels; level>=1; level--) {
    const cell = document.createElement('div');
    cell.className = 'cell levelLabel';
    const ph = Math.max(44, CELL_BASE_HEIGHT * (heights[level] / sumH));
    cell.style.height = ph + 'px';
    cell.style.minHeight = ph + 'px';
    cell.style.maxHeight = ph + 'px';
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = `${level}층`;
    cell.append(t);
    bayLbl.append(cell);
  }
  grid.append(bayLbl);

  // Build bays + header numbers
  let firstSelectedCode = CURRENT_CELL ? CURRENT_CELL.code : null;
  let firstMatchEl = null;

  for (const bay of bays) {
    // header number
    const ch = document.createElement('div');
    ch.className = 'colHeader';
    ch.textContent = String(bay).padStart(2,'0');
    gridHeader.append(ch);

    // bay column
    const bayDiv = document.createElement('div');
    bayDiv.className = 'bay';

    // 층: 3층 위, 1층 아래
    for (let level=CONFIG.levels; level>=1; level--){
      const ci = CELLS.find(c => c.bay===bay && c.level===level);
      const cell = document.createElement('div');
      cell.className = 'cell';
      const ph = Math.max(44, CELL_BASE_HEIGHT * (heights[level] / sumH));
      cell.style.height = ph + 'px';
      cell.style.minHeight = ph + 'px';
      cell.style.maxHeight = ph + 'px';

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

        cell.addEventListener('click', ()=> {
          document.querySelectorAll('.cell.selected').forEach(el=>el.classList.remove('selected'));
          cell.classList.add('selected');
          showDetail(ci);
        });

        if (!firstMatchEl && cell.classList.contains('match')) firstMatchEl = cell;
        if (firstSelectedCode && firstSelectedCode === ci.code) {
          setTimeout(()=>{
            cell.classList.add('selected');
            showDetail(ci);
          }, 0);
        }
      }

      bayDiv.append(cell);
    }
    grid.append(bayDiv);
  }

  sc.append(gridHeader, grid);
  frame.append(sc);
  host.append(frame);

  if (firstMatchEl) firstMatchEl.scrollIntoView({behavior:'smooth', block:'center', inline:'center'});
}

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
  for (const it of ci.items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${it.sku}</td><td>${it.name}</td><td style="text-align:center">${it.qty}</td><td style="text-align:center">${fmtM3(it.used_cm3)}</td>`;
    tr.addEventListener('click', ()=> {
      tb.querySelectorAll('tr.sel').forEach(x=>x.classList.remove('sel'));
      tr.classList.add('sel');
      CURRENT_ITEM_SKU = it.sku;
    });
    tb.append(tr);
  }
}

// ---------- Inbound / Outbound / Move ----------
async function openInbound() {
  if (!CURRENT_CELL) { alert('먼저 랙의 셀을 클릭해 선택하세요.'); return; }
  const dlg = ensureInboundDialog();
  const titleEl = dlg.querySelector('#dlgTitle');
  const list = dlg.querySelector('#dlgList');
  const qbox = dlg.querySelector('#dlgQuery');
  const qtyEl = dlg.querySelector('#dlgQty');
  if (!titleEl || !list || !qbox || !qtyEl) { alert('입고창 구성요소 오류'); return; }
  titleEl.textContent = `입고 - ${CURRENT_CELL.code}`;
  list.innerHTML = '';

  async function search() {
    const q = qbox.value.trim();
    const data = await getJSON(`${API_BASE}/items?q=${encodeURIComponent(q)}&limit=500`);
    list.innerHTML = '';
    for (const it of data.items) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div><strong>${it.code}</strong></div>
        <div>${it.name}<div style="color:#64748b;font-size:12px">${it.location||''}</div></div>
        <div style="text-align:center">${it.w}×${it.l}×${it.h} cm</div>
        <div style="text-align:right">${it.unit_cm3.toLocaleString()} cm³/개</div>`;
      row.addEventListener('click', ()=> row.classList.toggle('sel'));
      list.append(row);
    }
  }

  dlg.querySelector('#dlgBtnSearch').onclick = (e)=>{ e.preventDefault(); search(); };
  dlg.querySelector('#dlgCancel').onclick = (e)=>{ e.preventDefault(); closeDialog(dlg); };
  dlg.querySelector('#dlgOk').onclick = async (e)=>{
    e.preventDefault();
    const selRow = list.querySelector('.sel');
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

async function doOutbound() {
  if (!CURRENT_CELL) return alert('먼저 셀을 선택하세요.');
  if (!CURRENT_ITEM_SKU) return alert('출고할 상품을 표에서 선택하세요.');
  const item = CURRENT_CELL.items.find(it=>it.sku===CURRENT_ITEM_SKU);
  if (!item) return alert('선택한 상품을 찾을 수 없습니다.');
  const qtyStr = prompt(`출고 수량을 입력하세요 (보유 ${item.qty}개):`, '1');
  if (qtyStr===null) return;
  let qty = parseInt(qtyStr,10);
  if (!Number.isFinite(qty) || qty <= 0) return alert('수량은 1 이상이어야 합니다.');
  if (qty > item.qty) qty = item.qty;

  try {
    await postJSON(`${API_BASE}/outbound`, { rack_code: CURRENT_CELL.code, item_code: CURRENT_ITEM_SKU, qty });
    await loadCells();
    const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
    if (found) showDetail(found);
  } catch(e) {
    alert('서버 출고 실패: ' + (e.message||e));
  }
}

async function doMove() {
  if (!CURRENT_CELL) return alert('먼저 셀을 선택하세요.');
  if (!CURRENT_ITEM_SKU) return alert('이동할 상품을 표에서 선택하세요.');
  const item = CURRENT_CELL.items.find(it=>it.sku===CURRENT_ITEM_SKU);
  if (!item) return alert('선택한 상품을 찾을 수 없습니다.');

  const target = prompt('이동할 위치 코드를 입력하세요 (예: SR-01-03-02):', CURRENT_CELL.code);
  if (target===null) return;
  const re = /^SR-\d{2}-\d{2}-\d{2}$/;
  if (!re.test(target)) return alert('위치 코드 형식이 올바르지 않습니다. 예: SR-01-03-02');

  const qtyStr = prompt(`이동 수량을 입력하세요 (보유 ${item.qty}개):`, String(item.qty));
  if (qtyStr===null) return;
  let qty = parseInt(qtyStr,10);
  if (!Number.isFinite(qty) || qty <= 0) return alert('수량은 1 이상이어야 합니다.');
  if (qty > item.qty) qty = item.qty;

  const ok = confirm(`[확인] ${CURRENT_CELL.code} → ${target}\nSKU: ${CURRENT_ITEM_SKU}\n수량: ${qty}개\n\n계속할까요?`);
  if (!ok) return;

  try {
    await postJSON(`${API_BASE}/move`, { from_rack: CURRENT_CELL.code, to_rack: target, item_code: CURRENT_ITEM_SKU, qty });
    await loadCells();
    const found = CELLS.find(c=>c.code===CURRENT_CELL.code);
    if (found) showDetail(found);
  } catch(e) {
    alert('서버 이동 실패: ' + (e.message||e));
  }
}

async function loadCells() {
  const row = sel('#rowSelect').value;
  CURRENT_ROW = row;
  const data = await getJSON(`${API_BASE}/cells?row=${encodeURIComponent(row)}`);
  CELLS = data.cells;
  renderRack();
}

async function init() {
  try {
    CONFIG = await getJSON(`${API_BASE}/config`);
  } catch (err) {
    console.warn('config 불러오기 실패. 기본값으로 진행:', err);
    CONFIG = {
      rows: ['SR-01','SR-02','SR-03'],
      bays: 21,
      levels: 3,
      level_heights_cm: {1: 100, 2: 90, 3: 120},
      rate_low_max: 30,
      rate_normal_max: 70,
    };
  }
  CONFIG.rate_low_max = CONFIG.rate_low_max ?? 30;
  CONFIG.rate_normal_max = CONFIG.rate_normal_max ?? 70;
  CONFIG.level_heights_cm = CONFIG.level_heights_cm || {1: 100, 2: 90, 3: 120};

  const rs = sel('#rowSelect'); rs.innerHTML = '';
  for (const r of CONFIG.rows) {
    const o = document.createElement('option'); o.value = o.textContent = r; rs.append(o);
  }
  rs.value = CONFIG.rows[0];
  rs.addEventListener('change', loadCells);

  sel('#btnReload').addEventListener('click', loadCells);
  sel('#btnSearch').addEventListener('click', e => { e.preventDefault(); renderRack(); });
  sel('#search').addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); renderRack(); }});

  sel('#btnInbound').addEventListener('click', ()=>{
    try{ openInbound().catch(err=>alert('입고창 오류: '+(err.message||err))); }
    catch(e){ alert('입고창 오류: '+e); }
  });
  sel('#btnOutbound').addEventListener('click', doOutbound);
  sel('#btnMove').addEventListener('click', doMove);

  await loadCells();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!window.__reloadedBySW) { window.__reloadedBySW = true; location.reload(); }
  });
}
function start() { init().catch(err => { console.error(err); alert('초기화 실패: ' + (err.message || err)); }); }
if (document.readyState === 'loading') { window.addEventListener('DOMContentLoaded', start); } else { start(); }
