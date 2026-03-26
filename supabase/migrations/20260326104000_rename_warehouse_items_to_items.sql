do $$
begin
  if exists (
    select 1
    from pg_tables
    where schemaname = 'public' and tablename = 'warehouse_items'
  ) and not exists (
    select 1
    from pg_tables
    where schemaname = 'public' and tablename = 'items'
  ) then
    alter table public.warehouse_items rename to items;
  end if;
end
$$;

alter index if exists public.warehouse_items_location_code_idx
  rename to items_location_code_idx;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'warehouse_items_pkey'
  ) then
    alter table public.items rename constraint warehouse_items_pkey to items_pkey;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'warehouse_items_set_updated_at'
  ) then
    alter trigger warehouse_items_set_updated_at on public.items rename to items_set_updated_at;
  end if;
end
$$;
