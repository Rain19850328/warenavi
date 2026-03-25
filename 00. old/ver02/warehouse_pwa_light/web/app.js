// app.js — selection glow highlight (CSS)
const API_BASE = '/api';
const sel = s => document.querySelector(s);
const fmtM3 = cm3 => (cm3/1_000_000).toFixed(2) + ' m³';
const CELL_BASE_HEIGHT = (window.matchMedia('(max-width: 600px)').matches ? 180 : 340);

let CONFIG = null;
let CELLS = [];
let CURRENT_ROW = null;
let CURRENT_CELL = null;

function occupancyRate(used, cap) { return cap <= 0 ? 0 : (used / cap) * 100.0; }

function colorByRate(total, cap) {
  const rate = cap <= 0 ? 0 : (total / cap) * 100;
  if (total <= 0) return {fill:'#ffffff',  border:'#cbd5e1'};
  if (rate <= CONFIG.rate_low_max)  return {fill:'#e0f2fe', border:'#3C8CC8'};
  if (rate <= CONFIG.rate_normal_max) return {fill:'#dcfce7', border:'#50A468'};
  return {fill:'#ffedd5', border:'#C88C3C'};
}

function buildLegend() {
  const legend = document.createElement('div');
  legend.className = 'legend';
  const entries = [
    {name:'빈칸', style:{background:'#ffffff', border:'#cbd5e1'}},
    {name:`저적재(≤${CONFIG.rate_low_max}%)`, style:{background:'#e0f2fe', border:'#3C8CC8'}},
    {name:`정상(${CONFIG.rate_low_max+1}–${CONFIG.rate_normal_max}%)`, style:{background:'#dcfce7', border:'#50A468'}},
    {name:`포화(>${CONFIG.rate_normal_max}%)`, style:{background:'#ffedd5', border:'#C88C3C'}},
  ];
  for (const e of entries) {
    const sw = document.createElement('div'); sw.className='sw';
    sw.style.background = e.style.background; sw.style.borderColor = e.style.border;
    const label = document.createElement('span'); label.textContent = e.name; label.style.marginLeft='6px';
    const box = document.createElement('div'); box.style.display='flex'; box.style.alignItems='center'; box.append(sw,label);
    legend.append(box);
  }
  return legend;
}

function renderRack() {
  const host = sel('#rack');
  host.innerHTML = '';
  host.append(buildLegend());

  const query = sel('#search').value.trim().toUpperCase();
  const fEmpty = sel('#fEmpty').classList.contains('on');
  const fLow   = sel('#fLow').classList.contains('on');
  const fMixed = sel('#fMixed').classList.contains('on');

  const bays = Array.from({length: CONFIG.bays}, (_,i)=>i+1);
  const heights = CONFIG.level_heights_cm;
  const sumH = Object.values(heights).reduce((a,b)=>a+b,0);
  const phByLevel = {};
  for (let level=1; level<=CONFIG.levels; level++) {
    phByLevel[level] = Math.max(44, CELL_BASE_HEIGHT * (heights[level] / sumH));
  }

  const scrollX = document.createElement('div'); scrollX.className = 'scrollX';

  const colHeader = document.createElement('div'); colHeader.className = 'colHeader';
  const corner = document.createElement('div'); corner.className = 'corner'; colHeader.append(corner);
  for (const bay of bays) {
    const lab = document.createElement('div'); lab.className = 'colLabel'; lab.textContent = String(bay).padStart(2,'0');
    colHeader.append(lab);
  }
  scrollX.append(colHeader);

  const body = document.createElement('div'); body.className = 'body';

  const rowHeader = document.createElement('div'); rowHeader.className = 'rowHeader';
  for (let level = CONFIG.levels; level >= 1; level--) {
    const rl = document.createElement('div');
    rl.className = 'rowLabel';
    rl.textContent = `${level}층`;
    rl.style.height = phByLevel[level] + 'px';
    rowHeader.append(rl);
  }
  body.append(rowHeader);

  const grid = document.createElement('div'); grid.className = 'grid';

  for (const bay of bays) {
    const bayDiv = document.createElement('div'); bayDiv.className = 'bay';
    for (let level = CONFIG.levels; level >= 1; level--) {
      const ci = CELLS.find(c => c.bay===bay && c.level===level);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('role','button');
      const ph = phByLevel[level];
      cell.style.height = ph + 'px';
      cell.style.minHeight = ph + 'px';
      cell.style.maxHeight = ph + 'px';

      if (ci) {
        // 필터
        let hide = false;
        if (fEmpty && ci.total_cm3 !== 0) hide = true;
        if (fLow) {
          const r = occupancyRate(ci.total_cm3, ci.capacity_cm3);
          if (!(ci.total_cm3 > 0 && r <= CONFIG.rate_low_max)) hide = true;
        }
        if (fMixed && ci.kinds < 2) hide = true;
        if (hide) cell.style.opacity = 0.22;

        // 선택 복원
        cell.dataset.code = ci.code;
        if (CURRENT_CELL && CURRENT_CELL.code === ci.code) {
          cell.classList.add('selected');
          cell.setAttribute('aria-selected','true');
        }

        // 색상
        const {fill, border} = colorByRate(ci.total_cm3, ci.capacity_cm3);
        cell.style.background = fill; cell.style.borderColor = border; cell.style.borderWidth = '1px'; cell.style.borderStyle = 'solid';

        // 중앙엔 "적재율 %"
        const rate = Math.floor(occupancyRate(ci.total_cm3, ci.capacity_cm3));
        const mid = document.createElement('div');
        mid.className = 'rateOnly';
        mid.textContent = `${rate}%`;
        cell.append(mid);

        // 검색 하이라이트(정확 SKU 일치 시 외곽선 표시)
        if (query && ci.items.some(it => it.sku && it.sku.toUpperCase() === query)) {
          cell.style.outline = '3px solid #2F6BFF';
        }

        // 클릭 핸들러
        cell.addEventListener('click', ()=> {
          const prev = document.querySelector('.cell.selected');
          if (prev) { prev.classList.remove('selected'); prev.removeAttribute('aria-selected'); }
          cell.classList.add('selected');
          cell.setAttribute('aria-selected','true');
          showDetail(ci);
        });
      }
      bayDiv.append(cell);
    }
    grid.append(bayDiv);
  }
  body.append(grid);
  scrollX.append(body);
  host.append(scrollX);
}

function showDetail(ci) {
  CURRENT_CELL = ci;
  sel('#selTitle').textContent = `선택된 위치: ${ci.code}`;
  const rate = Math.floor(occupancyRate(ci.total_cm3, ci.capacity_cm3));
  const remain = Math.max(0, ci.capacity_cm3 - ci.total_cm3);
  sel('#selStats').textContent = `적재율: ${rate}% · 용량: ${fmtM3(ci.capacity_cm3)} · 사용: ${fmtM3(ci.total_cm3)} · 남은공간: ${fmtM3(remain)}`;
  sel('#barFill').style.width = Math.min(100, rate) + '%';

  const tb = sel('#tblItems tbody');
  tb.innerHTML = '';
  for (const it of (ci.items || [])) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${it.sku}</td><td>${it.name}</td><td style="text-align:center">${it.qty}</td><td style="text-align:center">${fmtM3(it.used_cm3)}</td>`;
    tb.append(tr);
  }
  sel('#btnInbound').disabled = false;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function loadCells() {
  const row = sel('#rowSelect').value;
  CURRENT_ROW = row;
  const data = await getJSON(`/api/cells?row=${encodeURIComponent(row)}`);
  CELLS = data.cells;
  renderRack();

  const tb = sel('#tblLog tbody');
  const logs = await getJSON(`/api/movements?limit=30`);
  tb.innerHTML = '';
  for (const x of logs.movements) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${x.time}</td><td>${x.type}</td><td>${x.sku}</td><td style="text-align:center">${x.qty}</td><td>${x.path}</td>`;
    tb.append(tr);
  }
}

async function init() {
  try {
    CONFIG = await getJSON(`/api/config`);
  } catch (err) {
    console.warn('config 불러오기 실패. 기본값으로 진행:', err);
    CONFIG = {
      rows: ['SR-01','SR-02','SR-03'],
      bays: 21,
      levels: 3,
      level_heights_cm: {1:120,2:100,3:180},
      rate_low_max: 25,
      rate_normal_max: 70,
    };
  }

  // height ratio 1 : 0.9 : 1.3 (3층이 위, 1층이 아래)
  CONFIG.levels = 3;
  CONFIG.level_heights_cm = { 1: 100, 2: 90, 3: 130 };

  const rs = sel('#rowSelect');
  rs.innerHTML = '';
  for (const r of CONFIG.rows) {
    const o = document.createElement('option'); o.value = o.textContent = r; rs.append(o);
  }
  rs.value = CONFIG.rows[0];
  rs.addEventListener('change', loadCells);

  // 필터 토글 버튼
  for (const id of ['fEmpty','fLow','fMixed']) {
    const b = sel('#'+id);
    b.addEventListener('click', ()=>{ b.classList.toggle('on'); renderRack(); });
  }

  sel('#btnSearch').addEventListener('click', e => { e.preventDefault(); renderRack(); });
  sel('#search').addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); renderRack(); }});

  sel('#btnReload').addEventListener('click', loadCells);
  sel('#btnInbound').addEventListener('click', ()=> alert('입고: 셀 선택 후 서버 연동 필요'));

  await loadCells();
}

function start(){ init().catch(err => { console.error(err); alert('초기화 실패: ' + (err.message || err)); }); }
if (document.readyState === 'loading') { window.addEventListener('DOMContentLoaded', start); } else { start(); }
