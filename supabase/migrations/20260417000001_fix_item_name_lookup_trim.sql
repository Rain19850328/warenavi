-- Fix: item name lookup was failing when DB name had trailing/leading spaces
-- Re-create function with TRIM applied to items.name in the join condition

create or replace function public.warehouse_lookup_item_codes_by_names(p_names jsonb default '[]'::jsonb)
returns table(name text, code text)
language sql
stable
as $$
  with names_ as (
    select distinct trim(value) as item_name
    from jsonb_array_elements_text(coalesce(p_names, '[]'::jsonb)) as value
    where trim(value) <> ''
  )
  select trim(i.name), i.code
  from public.items i
  join names_ n on n.item_name = trim(i.name)
  order by i.code asc, i.name asc
$$;

-- Backfill: update existing warehouse_new_inbound_items rows where sku_code is empty
-- by matching product_name to items.name (with TRIM)
update public.warehouse_new_inbound_items wni
set sku_code = i.code
from public.items i
where trim(coalesce(wni.sku_code, '')) = ''
  and trim(wni.product_name) = trim(i.name);
