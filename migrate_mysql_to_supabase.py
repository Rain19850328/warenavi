import os
import re
from collections import defaultdict
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

import psycopg2
from psycopg2.extras import execute_values
import pymysql
from pymysql.cursors import SSDictCursor


ITEMS_MYSQL = os.environ.get("ITEMS_DB_URL", "mysql+pymysql://rain:8520@192.168.0.5:3306/items")
SALES_MYSQL = os.environ.get("SALES_DB_URL", "mysql+pymysql://rain:8520@192.168.0.5:3306/salesdb")
SUPABASE_PG = os.environ["SUPABASE_DB_URL"]

SR2_LETTER_CODE_RE = re.compile(r"^SR2-([A-Fa-f])-([0-9]{2})$")
SR2_NUM_CODE_RE = re.compile(r"^SR2-([0-9]{2})-([0-9]{2})$")


def parse_mysql_url(url: str) -> Dict[str, object]:
    m = re.match(r"^mysql\+pymysql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)$", url)
    if not m:
        raise ValueError(f"Unsupported MySQL URL: {url}")
    user, password, host, port, database = m.groups()
    return {
        "host": host,
        "user": user,
        "password": password,
        "port": int(port),
        "database": database,
        "charset": "utf8mb4",
    }


def sr2_level_to_letter(level: int) -> str:
    return chr(65 + (6 - int(level)))


def sr2_letter_to_level(letter: str) -> int:
    idx = ord(letter.upper()) - 65
    if idx < 0 or idx >= 6:
        raise ValueError(f"Invalid SR2 level letter: {letter}")
    return 6 - idx


def parse_rack_code(code: str) -> Optional[Tuple[str, int, int]]:
    s = (code or "").strip()

    m = SR2_LETTER_CODE_RE.match(s)
    if m:
        letter, bay_s = m.groups()
        return ("SR2", int(bay_s), sr2_letter_to_level(letter))

    m = SR2_NUM_CODE_RE.match(s)
    if m:
        bay_s, level_s = m.groups()
        return ("SR2", int(bay_s), int(level_s))

    m = re.match(r"^SR(\d{1,2})-(\d{2})-(\d{2})$", s)
    if m:
        row_s, bay_s, level_s = m.groups()
        return (f"SR{int(row_s)}", int(bay_s), int(level_s))

    m = re.match(r"^SR-(\d{2})-([A-Fa-f])-([0-9]{2})$", s)
    if m and m.group(1) == "02":
        _, letter, bay_s = m.groups()
        return ("SR2", int(bay_s), sr2_letter_to_level(letter))

    m = re.match(r"^SR-(\d{2})-(\d{2})-(\d{2})$", s)
    if m:
        row_s, bay_s, level_s = m.groups()
        return (f"SR{int(row_s)}", int(bay_s), int(level_s))

    return None


def to_canonical_code(code: str) -> str:
    p = parse_rack_code(code)
    if not p:
        return (code or "").strip()
    row, bay, level = p
    if row == "SR2":
        return f"{row}-{sr2_level_to_letter(level)}-{bay:02d}"
    return f"{row}-{bay:02d}-{level:02d}"


def connect_mysql(url: str, cursorclass=None):
    params = parse_mysql_url(url)
    if cursorclass is not None:
        params["cursorclass"] = cursorclass
    return pymysql.connect(**params)


def chunked(iterable: Iterable[Tuple], size: int) -> Iterator[List[Tuple]]:
    batch: List[Tuple] = []
    for row in iterable:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def load_items() -> Tuple[List[Tuple], set]:
    conn = connect_mysql(ITEMS_MYSQL)
    rows_out: List[Tuple] = []
    item_codes = set()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT code, name, volume_width, volume_length, volume_height, location_code
            FROM items
            ORDER BY code
            """
        )
        for code, name, width, length, height, location_code in cur.fetchall():
            code = (code or "").strip()
            if not code:
                continue
            item_codes.add(code)
            rows_out.append(
                (
                    code,
                    (name or "").strip(),
                    float(width or 0),
                    float(length or 0),
                    float(height or 0),
                    to_canonical_code(location_code or ""),
                )
            )
    conn.close()
    return rows_out, item_codes


def load_racks(valid_codes: set) -> Tuple[List[Tuple], int]:
    conn = connect_mysql(ITEMS_MYSQL)
    aggregated: Dict[Tuple[str, str], int] = defaultdict(int)
    skipped = 0
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT rack_code, item_code, quantity
            FROM storage_racks
            """
        )
        for rack_code, item_code, quantity in cur.fetchall():
            sku = (item_code or "").strip()
            rack = to_canonical_code(rack_code or "")
            qty = int(quantity or 0)
            if not rack or not sku or sku not in valid_codes:
                skipped += 1
                continue
            if qty <= 0:
                continue
            aggregated[(rack, sku)] += qty
    conn.close()
    rows_out = [(rack, sku, qty) for (rack, sku), qty in sorted(aggregated.items())]
    return rows_out, skipped


def daily_stock_rows(valid_codes: set) -> Iterator[Tuple]:
    conn = connect_mysql(SALES_MYSQL, cursorclass=SSDictCursor)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT date, sku_cd, stock_cnt_real
        FROM daily_stock
        ORDER BY date, sku_cd
        """
    )
    try:
        while True:
            rows = cur.fetchmany(5000)
            if not rows:
                break
            for row in rows:
                sku = (row["sku_cd"] or "").strip()
                stock_date = row["date"]
                if not sku or sku not in valid_codes or stock_date is None:
                    continue
                yield (sku, stock_date, int(row["stock_cnt_real"] or 0))
    finally:
        cur.close()
        conn.close()


def upsert_items(pg_conn, rows: List[Tuple]) -> None:
    sql = """
        INSERT INTO public.items (code, name, volume_width, volume_length, volume_height, location_code)
        VALUES %s
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          volume_width = EXCLUDED.volume_width,
          volume_length = EXCLUDED.volume_length,
          volume_height = EXCLUDED.volume_height,
          location_code = EXCLUDED.location_code
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows, page_size=1000)
    pg_conn.commit()


def upsert_racks(pg_conn, rows: List[Tuple]) -> None:
    sql = """
        INSERT INTO public.warehouse_racks (rack_code, item_code, quantity)
        VALUES %s
        ON CONFLICT (rack_code, item_code) DO UPDATE SET
          quantity = EXCLUDED.quantity
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows, page_size=1000)
    pg_conn.commit()


def upsert_daily_stock(pg_conn, rows_iter: Iterable[Tuple]) -> int:
    sql = """
        INSERT INTO public.daily_stock (sku_cd, stock_date, stock_cnt_real)
        VALUES %s
        ON CONFLICT (sku_cd, stock_date) DO UPDATE SET
          stock_cnt_real = EXCLUDED.stock_cnt_real
    """
    total = 0
    with pg_conn.cursor() as cur:
        for batch in chunked(rows_iter, 5000):
            execute_values(cur, sql, batch, page_size=5000)
            total += len(batch)
            pg_conn.commit()
            print(f"daily_stock upserted: {total}")
    return total


def target_counts(pg_conn) -> Dict[str, int]:
    out = {}
    with pg_conn.cursor() as cur:
        for table in ["items", "warehouse_racks", "daily_stock", "warehouse_movements"]:
            cur.execute(f"SELECT COUNT(*) FROM public.{table}")
            out[table] = cur.fetchone()[0]
    return out


def main() -> int:
    print("Loading source items...")
    items_rows, item_codes = load_items()
    print(f"items source rows: {len(items_rows)}")

    print("Loading source racks...")
    rack_rows, skipped_racks = load_racks(item_codes)
    print(f"warehouse_racks source rows: {len(rack_rows)} (skipped={skipped_racks})")

    print("Connecting to Supabase...")
    pg_conn = psycopg2.connect(SUPABASE_PG, sslmode="require", connect_timeout=10)

    before = target_counts(pg_conn)
    print(f"target before: {before}")

    print("Upserting items...")
    upsert_items(pg_conn, items_rows)

    print("Upserting warehouse_racks...")
    upsert_racks(pg_conn, rack_rows)

    print("Upserting daily_stock...")
    daily_total = upsert_daily_stock(pg_conn, daily_stock_rows(item_codes))
    print(f"daily_stock source rows migrated: {daily_total}")

    after = target_counts(pg_conn)
    print(f"target after: {after}")
    pg_conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
