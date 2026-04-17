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
  select i.name, i.code
  from public.items i
  join names_ n on n.item_name = trim(i.name)
  order by i.code asc, i.name asc
$$;
