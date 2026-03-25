# app/main.py
# -*- coding: utf-8 -*-
import re, datetime, os
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

DB_URL = os.environ.get("ITEMS_DB_URL", "mysql+pymysql://rain:8520@192.168.0.5:3306/items")

ROW_IDS = [f"SR-{i:02d}" for i in range(1, 4)]
LEVEL_WIDTH_CM  = 110
LEVEL_DEPTH_CM  = 110
LEVEL_HEIGHT_CM = {1:120, 2:100, 3:180}
LEVEL_CAPACITY_CM3 = {lv: LEVEL_WIDTH_CM * LEVEL_DEPTH_CM * LEVEL_HEIGHT_CM[lv] for lv in LEVEL_HEIGHT_CM}
DEFAULT_BAYS, DEFAULT_LEVELS = 21, 3
RATE_LOW_MAX, RATE_NORMAL_MAX = 25, 70

def occupancy_rate(used_cm3: int, cap_cm3: int) -> float:
  return 0.0 if cap_cm3 <= 0 else (used_cm3 / cap_cm3) * 100.0

@dataclass
class CellInfo:
  code: str
  capacity: int
  total_cm3: int
  top_sku: Optional[str]
  kinds: int
  items: List[Tuple[str, str, int, int]]  # (sku, name, qty, used_cm3)

class DataProvider:
  def rows(self) -> List[str]: raise NotImplementedError
  def layout(self) -> Tuple[int,int]: return (DEFAULT_BAYS, DEFAULT_LEVELS)
  def fetch_cells_for_row(self, row_label: str) -> Dict[Tuple[int,int], CellInfo]: raise NotImplementedError
  def recent_movements(self, limit:int=30) -> List[Tuple[str,str,str,int,str]]: return []
  def list_items(self, query: str="", limit:int=500) -> List[Tuple[str,str,float,float,float,str]]: raise NotImplementedError
  def inbound(self, rack_code: str, item_code: str, qty: int) -> None: raise NotImplementedError

class MySQLProvider(DataProvider):
  LOC_RE = re.compile(r"^SR-(\d{2})-(\d{2})-(\d{2})$")
  def __init__(self, db_url: str):
    self.engine = create_engine(db_url, pool_pre_ping=True, future=True)
    self._schema_mode = self._detect_schema_rack()
    self._item_loc_col = self._detect_items_location_col()
    self._data: Dict[str, Dict[Tuple[int,int], CellInfo]] = {}
    self._load()

  def rows(self) -> List[str]: return ROW_IDS

  def _detect_schema_rack(self) -> str:
    try:
      with self.engine.connect() as conn:
        rs = list(conn.execute(text("SHOW COLUMNS FROM storage_racks LIKE 'item_id'")))
        if rs: return "id"
        rs2 = list(conn.execute(text("SHOW COLUMNS FROM storage_racks LIKE 'item_code'")))
        return "code" if rs2 else "code"
    except Exception:
      return "code"

  def _detect_items_location_col(self) -> Optional[str]:
    try:
      with self.engine.connect() as conn:
        rs = list(conn.execute(text("SHOW COLUMNS FROM items LIKE 'location_code'")))
        if rs: return "location_code"
        rs2 = list(conn.execute(text("SHOW COLUMNS FROM items LIKE 'locationcode'")))
        if rs2: return "locationcode"
    except Exception:
      pass
    return None

  def list_items(self, query: str="", limit:int=500) -> List[Tuple[str,str,float,float,float,str]]:
    loc_col = self._item_loc_col
    select_loc = f", COALESCE(i.{loc_col}, '') AS loc" if loc_col else ", '' AS loc"
    where_loc  = f" OR i.{loc_col} LIKE :pat" if loc_col else ""
    sql = text(f"""
      SELECT i.code, i.name,
            COALESCE(i.volume_width,0.0)  AS w,
            COALESCE(i.volume_length,0.0) AS l,
            COALESCE(i.volume_height,0.0) AS h
            {select_loc}
      FROM items i
      WHERE (:q = '' OR i.code LIKE :pat OR i.name LIKE :pat{where_loc})
      ORDER BY i.code ASC, i.name ASC
      LIMIT :lim
    """)
    q = (query or "").strip()
    pat = f"%{q}%"
    with self.engine.connect() as conn:
      rows = list(conn.execute(sql, {"q":q, "pat":pat, "lim":limit}))
    return [(r[0], r[1], float(r[2]), float(r[3]), float(r[4]), r[5] or "") for r in rows]

  def inbound(self, rack_code: str, item_code: str, qty: int) -> None:
    if qty <= 0: raise ValueError("수량은 1 이상이어야 합니다.")
    mode = self._schema_mode
    try:
      with self.engine.begin() as conn:
        if mode == "id":
          rid = conn.execute(text("SELECT id FROM items WHERE code = :c"), {"c": item_code}).scalar()
          if not rid: raise RuntimeError(f"SKU를 찾을 수 없습니다: {item_code}")
          conn.execute(text("""
            INSERT INTO storage_racks (rack_code, item_id, quantity)
            VALUES (:rack, :item_id, :qty)
            ON DUPLICATE KEY UPDATE quantity = quantity + :qty_u
          """), {"rack": rack_code, "item_id": int(rid), "qty": int(qty), "qty_u": int(qty)})
        else:
          conn.execute(text("""
            INSERT INTO storage_racks (rack_code, item_code, quantity)
            VALUES (:rack, :item_code, :qty)
            ON DUPLICATE KEY UPDATE quantity = quantity + :qty_u
          """), {"rack": rack_code, "item_code": item_code, "qty": int(qty), "qty_u": int(qty)})
    except SQLAlchemyError as e:
      raise RuntimeError(f"입고 처리 실패: {e}")
    self._load()

  def _try_query(self, by: str):
    if by == "id":
      sql = text("""
        SELECT sr.rack_code AS rack, COALESCE(sr.quantity, 0) AS qty,
              i.code AS sku, i.name AS nm,
              COALESCE(i.volume_width,0.0) AS w,
              COALESCE(i.volume_length,0.0) AS l,
              COALESCE(i.volume_height,0.0) AS h
        FROM storage_racks sr
        JOIN items i ON i.id = sr.item_id
      """)
    else:
      sql = text("""
        SELECT sr.rack_code AS rack, COALESCE(sr.quantity, 0) AS qty,
              i.code AS sku, i.name AS nm,
              COALESCE(i.volume_width,0.0) AS w,
              COALESCE(i.volume_length,0.0) AS l,
              COALESCE(i.volume_height,0.0) AS h
        FROM storage_racks sr
        JOIN items i ON i.code = sr.item_code
      """)
    with self.engine.connect() as conn:
      return list(conn.execute(sql).mappings())

  def _load(self):
    try:
      rows = self._try_query("id")
    except Exception:
      rows = []
    if not rows:
      try:
        rows = self._try_query("code")
      except Exception as e:
        raise RuntimeError(f"storage_racks JOIN 실패: {e}")

    used_cm3: Dict[str, Dict[Tuple[int,int], float]] = {}
    vol_by_sku: Dict[str, Dict[Tuple[int,int], Dict[str,float]]] = {}
    qty_by_sku: Dict[str, Dict[Tuple[int,int], Dict[str,int]]] = {}
    name_by_sku: Dict[str, Dict[Tuple[int,int], Dict[str,str]]] = {}

    for r in rows:
      rack = str(r["rack"] or "").strip()
      m = self.LOC_RE.match(rack)
      if not m: continue
      row_num_s, bay_s, level_s = m.groups()
      row_label = f"SR-{row_num_s}"
      bay, level = int(bay_s), int(level_s)
      if not (1 <= bay <= DEFAULT_BAYS and 1 <= level <= DEFAULT_LEVELS): continue

      sku = (r["sku"] or "").strip()
      nm  = (r["nm"]  or "").strip()
      w   = float(r["w"] or 0.0); l = float(r["l"] or 0.0); h = float(r["h"] or 0.0)
      qty = int(r["qty"] or 0)

      unit_cm3 = max(0.0, w) * max(0.0, l) * max(0.0, h)
      used = unit_cm3 * max(0, qty)

      key = (bay, level)
      used_cm3.setdefault(row_label, {})
      used_cm3[row_label][key] = used_cm3[row_label].get(key, 0.0) + used

      vol_by_sku.setdefault(row_label, {}).setdefault(key, {})
      vol_by_sku[row_label][key][sku] = vol_by_sku[row_label][key].get(sku, 0.0) + used

      qty_by_sku.setdefault(row_label, {}).setdefault(key, {})
      qty_by_sku[row_label][key][sku] = qty_by_sku[row_label][key].get(sku, 0) + qty

      name_by_sku.setdefault(row_label, {}).setdefault(key, {})
      name_by_sku[row_label][key][sku] = nm

    self._data = {}
    for row_label in ROW_IDS:
      self._data[row_label] = {}
      for bay in range(1, DEFAULT_BAYS+1):
        for level in range(1, DEFAULT_LEVELS+1):
          key = (bay, level)
          total = used_cm3.get(row_label, {}).get(key, 0.0)
          sku_map = vol_by_sku.get(row_label, {}).get(key, {})
          items_sorted = sorted(sku_map.items(), key=lambda x: x[1], reverse=True)
          kinds = len(items_sorted)
          top_sku = items_sorted[0][0] if items_sorted else None
          cap = LEVEL_CAPACITY_CM3[level]

          items_list: List[Tuple[str, str, int, int]] = []
          for sku, vol in items_sorted:
            nm = name_by_sku.get(row_label, {}).get(key, {}).get(sku, "")
            q  = qty_by_sku.get(row_label, {}).get(key, {}).get(sku, 0)
            items_list.append((sku, nm, q, int(vol)))

          self._data[row_label][key] = CellInfo(
            code=f"{row_label}-{bay:02d}-{level:02d}",
            capacity=int(cap),
            total_cm3=int(total),
            top_sku=top_sku,
            kinds=kinds,
            items=items_list,
          )

  def fetch_cells_for_row(self, row_label: str) -> Dict[Tuple[int,int], CellInfo]:
    return self._data.get(row_label, {})

  def recent_movements(self, limit:int=30) -> List[Tuple[str,str,str,int,str]]:
    now = datetime.datetime.now()
    out = []
    for i in range(min(limit, 20)):
      out.append(((now - datetime.timedelta(minutes=i*7)).strftime("%H:%M"),
                  ["입고","출고","이동","조정"][i%4],
                  "SKU-EXAMPLE",
                  [+30, +50, -10, -4][i%4],
                  "—"))
    return out

class FakeProvider(DataProvider):
  LOC_RE = re.compile(r"^SR-(\d{2})-(\d{2})-(\d{2})$")
  def __init__(self):
    self._rows = ROW_IDS[:]
    self._cells: Dict[str, Dict[Tuple[int,int], CellInfo]] = {r:{} for r in self._rows}
    self._items = [
      ("A00100301", "샘플상품A(14×18.5×3)", 14.0, 18.5, 3.0, "C-03-03-01"),
      ("B00000001", "샘플상품B(20×20×20)", 20.0, 20.0, 20.0, "SR-01-05-02"),
      ("C00000001", "샘플상품C(30×25×15)", 30.0, 25.0, 15.0, ""),
    ]
    for r in self._rows:
      for b in range(1, DEFAULT_BAYS+1):
        for lv in range(1, DEFAULT_LEVELS+1):
          self._cells[r][(b,lv)] = CellInfo(
            code=f"{r}-{b:02d}-{lv:02d}",
            capacity=LEVEL_CAPACITY_CM3[lv],
            total_cm3=0, top_sku=None, kinds=0, items=[]
          )
    used = int(14.0 * 18.5 * 3.0 * 2000)
    self._cells["SR-03"][(3,3)] = CellInfo(
      code="SR-03-03-03",
      capacity=LEVEL_CAPACITY_CM3[3],
      total_cm3=used, top_sku="A00100301", kinds=1,
      items=[("A00100301", "샘플상품A(14×18.5×3)", 2000, used)]
    )

  def rows(self) -> List[str]: return self._rows
  def list_items(self, query: str="", limit:int=500) -> List[Tuple[str,str,float,float,float,str]]:
    q = (query or "").strip().lower()
    out = []
    for code, name, w, l, h, loc in sorted(self._items, key=lambda x: (x[1].lower(), x[0].lower())):
      if not q or q in code.lower() or q in name.lower() or q in (loc or "").lower():
        out.append((code, name, w, l, h, loc or ""))
        if len(out) >= limit: break
    return out

  def inbound(self, rack_code: str, item_code: str, qty: int) -> None:
    if qty <= 0: raise ValueError("수량은 1 이상이어야 합니다.")
    m = self.LOC_RE.match(rack_code)
    if not m: raise ValueError("위치 코드 형식 오류")
    row = f"SR-{m.group(1)}"; bay = int(m.group(2)); level = int(m.group(3))
    matches = [it for it in self._items if it[0] == item_code]
    if not matches: raise RuntimeError("아이템을 찾을 수 없습니다.")
    code, name, w, l, h, _loc = matches[0]
    unit_cm3 = w*l*h
    used = int(unit_cm3 * qty)
    ci = self._cells[row][(bay,level)]
    ci.total_cm3 += used
    found = False
    for i, (sku, nm, old_q, vol) in enumerate(ci.items):
      if sku == code:
        ci.items[i] = (sku, nm, old_q + qty, vol + used)
        found = True
        break
    if not found:
      ci.items.append((code, name, qty, used))
    ci.items.sort(key=lambda x: x[3], reverse=True)
    ci.kinds = len(ci.items)
    ci.top_sku = ci.items[0][0] if ci.items else None

  def fetch_cells_for_row(self, row_label: str) -> Dict[Tuple[int,int], CellInfo]:
    return self._cells.get(row_label, {})

  def recent_movements(self, limit:int=30) -> List[Tuple[str,str,str,int,str]]:
    now = datetime.datetime.now()
    return [((now - datetime.timedelta(minutes=i*5)).strftime("%H:%M"), "입고", "A00100301", +50, "—")
            for i in range(1, min(20, limit)+1)]

class CellItemModel(BaseModel):
  sku: str
  name: str
  qty: int
  used_cm3: int

class CellModel(BaseModel):
  code: str
  bay: int
  level: int
  capacity_cm3: int
  total_cm3: int
  kinds: int
  items: List[CellItemModel]

class CellsResponse(BaseModel):
  row: str
  bays: int
  levels: int
  cells: List[CellModel]

class ItemsResponse(BaseModel):
  items: List[dict]

class ConfigResponse(BaseModel):
  rows: List[str]
  bays: int
  levels: int
  level_heights_cm: dict
  rate_low_max: int
  rate_normal_max: int

class InboundRequest(BaseModel):
  rack_code: str
  item_code: str
  qty: int

app = FastAPI(title="Warehouse PWA API", version="1.0.0")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"], allow_credentials=True,
  allow_methods=["*"], allow_headers=["*"],
)

# Static /web (html=True so /web/ serves index.html)
app.mount("/web", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..", "web"), html=True), name="web")

@app.get("/")
def root():
  return RedirectResponse(url="/web/")

def make_provider() -> DataProvider:
  try:
    return MySQLProvider(DB_URL)
  except Exception as e:
    print("[WARN] MySQL 연동 실패, 더미 데이터로 전환:", e)
    return FakeProvider()

provider: DataProvider = make_provider()

@app.get("/api/config", response_model=ConfigResponse)
def get_config():
  bays, levels = provider.layout()
  return ConfigResponse(
    rows=provider.rows(),
    bays=bays, levels=levels,
    level_heights_cm=LEVEL_HEIGHT_CM,
    rate_low_max=RATE_LOW_MAX,
    rate_normal_max=RATE_NORMAL_MAX,
  )

@app.get("/api/cells", response_model=CellsResponse)
def get_cells(row: str = ROW_IDS[0]):
  if row not in provider.rows():
    raise HTTPException(404, detail="없는 행(row)입니다.")
  bays, levels = provider.layout()
  data = provider.fetch_cells_for_row(row)
  out: List[CellModel] = []
  for (bay, level), ci in sorted(data.items(), key=lambda x: (x[0][0], x[0][1])):
    out.append(CellModel(
      code=ci.code, bay=bay, level=level,
      capacity_cm3=ci.capacity, total_cm3=ci.total_cm3,
      kinds=ci.kinds,
      items=[CellItemModel(sku=s, name=n, qty=q, used_cm3=u) for (s,n,q,u) in ci.items]
    ))
  return CellsResponse(row=row, bays=bays, levels=levels, cells=out)

@app.get("/api/movements")
def get_movements(limit: int = 30):
  rows = provider.recent_movements(limit=limit)
  return {"movements": [{"time":t, "type":typ, "sku":sku, "qty":qty, "path":path} for (t,typ,sku,qty,path) in rows]}

@app.get("/api/items", response_model=ItemsResponse)
def get_items(q: str = "", limit: int = 500):
  rows = provider.list_items(q, limit=limit)
  items = []
  for code, name, w, l, h, loc in rows:
    unit = int(max(0.0,w)*max(0.0,l)*max(0.0,h))
    items.append({"code":code, "name":name, "w":w, "l":l, "h":h, "unit_cm3":unit, "location":loc})
  return ItemsResponse(items=items)

@app.post("/api/inbound")
def post_inbound(req: InboundRequest):
  try:
    provider.inbound(req.rack_code, req.item_code, req.qty)
  except Exception as e:
    raise HTTPException(400, detail=str(e))
  row = "-".join(req.rack_code.split("-")[:2])
  cells = get_cells(row=row)
  return {"ok": True, "row": row, "cells": cells}
