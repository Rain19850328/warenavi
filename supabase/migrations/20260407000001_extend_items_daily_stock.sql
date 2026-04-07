-- MOPS 2026 통합을 위해 기존 items, daily_stock 테이블에 컬럼 추가
-- IF NOT EXISTS 를 사용하므로 재실행해도 안전

-- items: MOPS 2026 전용 컬럼 추가
alter table public.items add column if not exists unit_price numeric;
alter table public.items add column if not exists quantity_of_set numeric;
alter table public.items add column if not exists total_ordered integer default 0;
alter table public.items add column if not exists total_imported integer default 0;
alter table public.items add column if not exists total_not_received integer default 0;
alter table public.items add column if not exists origin_marked boolean default false;
alter table public.items add column if not exists purchase_url text;
alter table public.items add column if not exists item_memo text;
alter table public.items add column if not exists unit_price_diff numeric default 0;
alter table public.items add column if not exists latest_order_detail_code text;
alter table public.items add column if not exists previous_unit_price numeric default 0;

-- daily_stock: MOPS 2026 전용 컬럼 추가
-- 기존: sku_cd, stock_date, stock_cnt_real, created_at
alter table public.daily_stock add column if not exists in_cnt_accum bigint;
alter table public.daily_stock add column if not exists sales_today bigint;
alter table public.daily_stock add column if not exists sales_annual bigint;
alter table public.daily_stock add column if not exists item_status text;
alter table public.daily_stock add column if not exists stock_status text;
