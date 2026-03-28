create table if not exists public.warehouse_new_inbound_items (
  id uuid primary key default gen_random_uuid(),
  inbound_date date not null,
  sku_code text references public.items(code) on delete set null,
  product_name text not null default '',
  box_qty integer not null default 0 check (box_qty >= 0),
  inbound_qty integer not null default 0 check (inbound_qty >= 0),
  pending_qty integer not null default 0 check (pending_qty >= 0),
  source_name text not null default '',
  last_action jsonb not null default '{}'::jsonb,
  logs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists warehouse_new_inbound_items_inbound_date_idx
  on public.warehouse_new_inbound_items (inbound_date, created_at);

create index if not exists warehouse_new_inbound_items_sku_code_idx
  on public.warehouse_new_inbound_items (sku_code);

drop trigger if exists warehouse_new_inbound_items_set_updated_at on public.warehouse_new_inbound_items;
create trigger warehouse_new_inbound_items_set_updated_at
before update on public.warehouse_new_inbound_items
for each row
execute function public.warehouse_set_updated_at();

alter table public.warehouse_new_inbound_items enable row level security;

create or replace function public.warehouse_get_new_inbound_list(p_date date)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'updated_at', coalesce(to_char(max(src.updated_at at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
    'source_name', coalesce(max(src.source_name), ''),
    'items',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', src.id,
          'sku_code', coalesce(src.sku_code, ''),
          'product_name', src.product_name,
          'box_qty', src.box_qty,
          'inbound_qty', src.inbound_qty,
          'pending_qty', src.pending_qty,
          'last_action', src.last_action,
          'logs', src.logs
        )
        order by src.created_at asc, src.product_name asc, src.id asc
      ) filter (where src.id is not null),
      '[]'::jsonb
    )
  )
  from public.warehouse_new_inbound_items src
  where src.inbound_date = p_date;
$$;

create or replace function public.warehouse_replace_new_inbound_list(
  p_date date,
  p_source_name text default '',
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
as $$
begin
  if p_date is null then
    raise exception 'date is required';
  end if;

  delete from public.warehouse_new_inbound_items
  where inbound_date = p_date;

  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 0 then
    insert into public.warehouse_new_inbound_items (
      id,
      inbound_date,
      sku_code,
      product_name,
      box_qty,
      inbound_qty,
      pending_qty,
      source_name,
      last_action,
      logs
    )
    select
      coalesce(nullif(trim(item.id), '')::uuid, gen_random_uuid()),
      p_date,
      nullif(trim(coalesce(item.sku_code, '')), ''),
      trim(coalesce(item.product_name, '')),
      greatest(coalesce(item.box_qty, 0), 0),
      greatest(coalesce(item.inbound_qty, 0), 0),
      greatest(coalesce(item.pending_qty, coalesce(item.inbound_qty, 0)), 0),
      trim(coalesce(p_source_name, '')),
      '{}'::jsonb,
      '[]'::jsonb
    from jsonb_to_recordset(p_items) as item(
      id text,
      sku_code text,
      product_name text,
      box_qty integer,
      inbound_qty integer,
      pending_qty integer
    );
  end if;

  return public.warehouse_get_new_inbound_list(p_date);
end;
$$;

create or replace function public.warehouse_process_new_inbound_item(
  p_date date,
  p_entry_id uuid,
  p_action text,
  p_qty integer,
  p_rack_code text default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_item public.warehouse_new_inbound_items%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_qty integer := coalesce(p_qty, 0);
  v_pending integer;
  v_log jsonb;
  v_inbound jsonb;
begin
  if p_date is null then
    raise exception 'date is required';
  end if;

  if p_entry_id is null then
    raise exception 'entry_id is required';
  end if;

  if v_action not in ('display', 'inbound') then
    raise exception 'Unsupported action: %', p_action;
  end if;

  if v_qty <= 0 then
    raise exception 'qty must be greater than 0';
  end if;

  select *
    into v_item
  from public.warehouse_new_inbound_items
  where inbound_date = p_date
    and id = p_entry_id
  for update;

  if not found then
    raise exception 'New inbound item not found';
  end if;

  if trim(coalesce(v_item.sku_code, '')) = '' then
    raise exception '상품코드가 없는 항목은 처리할 수 없습니다.';
  end if;

  v_pending := coalesce(v_item.pending_qty, 0);
  if v_pending < v_qty then
    raise exception '미처리수량보다 큰 수량은 처리할 수 없습니다.';
  end if;

  if v_action = 'inbound' then
    if trim(coalesce(p_rack_code, '')) = '' then
      raise exception '입고 처리에는 위치 선택이 필요합니다.';
    end if;

    v_inbound := public.warehouse_post_inbound(
      p_rack_code,
      v_item.sku_code,
      v_qty,
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  v_log := jsonb_build_object(
    'type', v_action,
    'qty', v_qty,
    'rack_code', case when v_action = 'inbound' then public.warehouse_to_canonical_code(p_rack_code) else '' end,
    'processed_at', timezone('utc', now())
  );

  update public.warehouse_new_inbound_items
  set pending_qty = pending_qty - v_qty,
      last_action = v_log,
      logs = coalesce(logs, '[]'::jsonb) || jsonb_build_array(v_log)
  where id = p_entry_id;

  return jsonb_build_object(
    'ok', true,
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'list', public.warehouse_get_new_inbound_list(p_date),
    'row', case when v_action = 'inbound' then coalesce(v_inbound ->> 'row', '') else '' end,
    'cells', case when v_action = 'inbound' then coalesce(v_inbound -> 'cells', '{}'::jsonb) else '{}'::jsonb end
  );
end;
$$;
