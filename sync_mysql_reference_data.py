import argparse
import datetime as dt
import os
import re
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Set, Tuple

import psycopg2
from psycopg2.extras import execute_values
import pymysql
from pymysql.cursors import SSDictCursor


ITEMS_MYSQL = os.environ.get("ITEMS_DB_URL", "mysql+pymysql://rain:8520@192.168.0.5:3306/items")
SALES_MYSQL = os.environ.get("SALES_DB_URL", "mysql+pymysql://rain:8520@192.168.0.5:3306/salesdb")
SUPABASE_PG = os.environ["SUPABASE_DB_URL"]

SR2_LETTER_CODE_RE = re.compile(r"^SR2-([A-Fa-f])-([0-9]{2})$")
SR2_NUM_CODE_RE = re.compile(r"^SR2-([0-9]{2})-([0-9]{2})$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync MySQL source tables items/daily_stock into Supabase."
    )
    parser.add_argument(
        "--daily-stock-days",
        type=int,
        default=7,
        help="Sync this many recent source days for daily_stock. Ignored by --full-daily-stock and explicit date range.",
    )
    parser.add_argument("--from-date", type=str, default="", help="Daily stock sync start date (YYYY-MM-DD).")
    parser.add_argument("--to-date", type=str, default="", help="Daily stock sync end date (YYYY-MM-DD).")
    parser.add_argument(
        "--full-daily-stock",
        action="store_true",
        help="Replace all daily_stock rows in Supabase with MySQL source rows.",
    )
    parser.add_argument("--no-items", action="store_true", help="Skip items sync.")
    parser.add_argument("--no-daily-stock", action="store_true", help="Skip daily_stock sync.")
    parser.add_argument("--dry-run", action="store_true", help="Read and count only. Do not modify Supabase.")
    return parser.parse_args()


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


def connect_mysql(url: str, cursorclass=None):
    params = parse_mysql_url(url)
    if cursorclass is not None:
        params["cursorclass"] = cursorclass
    return pymysql.connect(**params)


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


def chunked(iterable: Iterable[Tuple], size: int) -> Iterator[List[Tuple]]:
    batch: List[Tuple] = []
    for row in iterable:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def parse_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y-%m-%d").date()


def source_daily_stock_bounds() -> Tuple[Optional[dt.date], Optional[dt.date]]:
    conn = connect_mysql(SALES_MYSQL)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT MIN(date), MAX(date) FROM daily_stock")
            min_date, max_date = cur.fetchone()
            return min_date, max_date
    finally:
        conn.close()


def resolve_daily_stock_range(args: argparse.Namespace) -> Tuple[Optional[dt.date], Optional[dt.date]]:
    if args.no_daily_stock:
        return None, None

    source_min, source_max = source_daily_stock_bounds()
    if source_max is None:
        raise RuntimeError("Source salesdb.daily_stock is empty.")

    if args.full_daily_stock:
        return source_min, source_max

    if bool(args.from_date) != bool(args.to_date):
        raise ValueError("--from-date and --to-date must be used together.")

    if args.from_date and args.to_date:
        start = parse_date(args.from_date)
        end = parse_date(args.to_date)
    else:
        days = max(int(args.daily_stock_days), 1)
        end = source_max
        start = end - dt.timedelta(days=days - 1)

    if start > end:
        raise ValueError("Daily stock range start must not be after end.")
    return start, end


def load_items() -> Tuple[List[Tuple], Set[str]]:
    conn = connect_mysql(ITEMS_MYSQL)
    rows_out: List[Tuple] = []
    item_codes: Set[str] = set()
    try:
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
    finally:
        conn.close()
    return rows_out, item_codes


def count_daily_stock_rows(valid_codes: Set[str], start: dt.date, end: dt.date) -> int:
    conn = connect_mysql(SALES_MYSQL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*)
                FROM daily_stock
                WHERE date BETWEEN %s AND %s
                  AND sku_cd IN %s
                """,
                (start, end, tuple(sorted(valid_codes)) or ("",)),
            )
            return int(cur.fetchone()[0] or 0)
    finally:
        conn.close()


def daily_stock_rows(valid_codes: Set[str], start: dt.date, end: dt.date) -> Iterator[Tuple]:
    conn = connect_mysql(SALES_MYSQL, cursorclass=SSDictCursor)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT date, sku_cd, stock_cnt_real
        FROM daily_stock
        WHERE date BETWEEN %s AND %s
        ORDER BY date, sku_cd
        """,
        (start, end),
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


def connect_pg():
    return psycopg2.connect(SUPABASE_PG, sslmode="require", connect_timeout=10)


def upsert_items(pg_conn, rows: Sequence[Tuple]) -> None:
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


def replace_daily_stock_range(
    pg_conn,
    rows_iter: Iterable[Tuple],
    start: dt.date,
    end: dt.date,
) -> int:
    delete_sql = """
        DELETE FROM public.daily_stock
        WHERE stock_date BETWEEN %s AND %s
    """
    insert_sql = """
        INSERT INTO public.daily_stock (sku_cd, stock_date, stock_cnt_real)
        VALUES %s
    """
    total = 0
    with pg_conn.cursor() as cur:
        cur.execute(delete_sql, (start, end))
        pg_conn.commit()
        for batch in chunked(rows_iter, 5000):
            execute_values(cur, insert_sql, batch, page_size=5000)
            total += len(batch)
            pg_conn.commit()
            print(f"daily_stock synced: {total}")
    return total


def target_counts(pg_conn) -> Dict[str, int]:
    out: Dict[str, int] = {}
    with pg_conn.cursor() as cur:
        for table in ["items", "daily_stock", "warehouse_racks", "warehouse_movements"]:
            cur.execute(f"SELECT COUNT(*) FROM public.{table}")
            out[table] = int(cur.fetchone()[0] or 0)
    return out


def target_daily_stock_count(pg_conn, start: dt.date, end: dt.date) -> int:
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
            FROM public.daily_stock
            WHERE stock_date BETWEEN %s AND %s
            """,
            (start, end),
        )
        return int(cur.fetchone()[0] or 0)


def main() -> int:
    args = parse_args()

    print("Loading source items...")
    items_rows, item_codes = load_items()
    print(f"source items rows: {len(items_rows)}")

    daily_start, daily_end = resolve_daily_stock_range(args)
    if daily_start and daily_end:
        source_daily_count = count_daily_stock_rows(item_codes, daily_start, daily_end)
        print(f"source daily_stock rows in range {daily_start}..{daily_end}: {source_daily_count}")

    print("Connecting to Supabase...")
    pg_conn = connect_pg()
    before = target_counts(pg_conn)
    print(f"target before: {before}")

    if args.dry_run:
        if daily_start and daily_end:
            target_range_count = target_daily_stock_count(pg_conn, daily_start, daily_end)
            print(f"target daily_stock rows in range {daily_start}..{daily_end}: {target_range_count}")
        pg_conn.close()
        print("Dry run complete. No changes applied.")
        return 0

    if not args.no_items:
        print("Syncing items...")
        upsert_items(pg_conn, items_rows)

    if not args.no_daily_stock and daily_start and daily_end:
        print(f"Replacing daily_stock range {daily_start}..{daily_end}...")
        synced = replace_daily_stock_range(
            pg_conn,
            daily_stock_rows(item_codes, daily_start, daily_end),
            daily_start,
            daily_end,
        )
        print(f"daily_stock rows synced: {synced}")

    after = target_counts(pg_conn)
    print(f"target after: {after}")
    if daily_start and daily_end:
        final_range_count = target_daily_stock_count(pg_conn, daily_start, daily_end)
        print(f"target daily_stock rows in range {daily_start}..{daily_end}: {final_range_count}")
    pg_conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
