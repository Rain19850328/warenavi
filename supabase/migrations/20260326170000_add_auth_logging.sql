alter table public.warehouse_movements
  add column if not exists actor_user_id uuid;

alter table public.warehouse_movements
  add column if not exists actor_email text not null default '';

alter table public.warehouse_movements
  add column if not exists actor_name text not null default '';

alter table public.warehouse_movements
  add column if not exists payload jsonb not null default '{}'::jsonb;

create index if not exists warehouse_movements_actor_user_id_idx
  on public.warehouse_movements (actor_user_id, created_at desc);

create index if not exists warehouse_movements_created_at_idx
  on public.warehouse_movements (created_at desc);

create index if not exists warehouse_movements_type_created_at_idx
  on public.warehouse_movements (movement_type, created_at desc);

drop function if exists public.warehouse_post_inbound(text, text, integer);
drop function if exists public.warehouse_post_outbound(text, text, integer);
drop function if exists public.warehouse_post_move(text, text, text, integer);
drop function if exists public.warehouse_post_set_location(text, text);

create or replace function public.warehouse_get_movements(
  p_limit integer default 30,
  p_actor_user_id uuid default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'items',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', src.id,
          'movement_type', src.movement_type,
          'item_code', src.item_code,
          'item_name', src.item_name,
          'rack_code', src.rack_code,
          'from_rack', src.from_rack,
          'to_rack', src.to_rack,
          'quantity', src.quantity,
          'note', src.note,
          'actor_user_id', src.actor_user_id,
          'actor_email', src.actor_email,
          'actor_name', src.actor_name,
          'payload', src.payload,
          'created_at', src.created_at
        )
        order by src.created_at desc
      ),
      '[]'::jsonb
    )
  )
  from (
    select
      wm.id,
      wm.movement_type,
      wm.item_code,
      coalesce(i.name, '') as item_name,
      wm.rack_code,
      wm.from_rack,
      wm.to_rack,
      wm.quantity,
      wm.note,
      wm.actor_user_id,
      wm.actor_email,
      wm.actor_name,
      wm.payload,
      wm.created_at
    from public.warehouse_movements wm
    left join public.items i on i.code = wm.item_code
    where p_actor_user_id is null
      or wm.actor_user_id = p_actor_user_id
    order by wm.created_at desc
    limit greatest(coalesce(p_limit, 30), 1)
  ) as src;
$$;

create or replace function public.warehouse_post_inbound(
  p_rack_code text,
  p_item_code text,
  p_qty integer,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_rack text := public.warehouse_to_canonical_code(p_rack_code);
  v_row text;
  v_bay integer;
  v_level integer;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'qty must be greater than 0';
  end if;

  if not exists (select 1 from public.items where code = p_item_code) then
    raise exception 'Unknown item_code: %', p_item_code;
  end if;

  select row_label, bay, level
    into v_row, v_bay, v_level
  from public.warehouse_parse_rack_code(v_rack)
  limit 1;

  if v_row is null then
    raise exception 'Invalid rack code: %', p_rack_code;
  end if;

  insert into public.warehouse_racks (rack_code, item_code, quantity)
  values (v_rack, p_item_code, p_qty)
  on conflict (rack_code, item_code)
  do update set quantity = public.warehouse_racks.quantity + excluded.quantity;

  insert into public.warehouse_movements (
    movement_type,
    item_code,
    rack_code,
    quantity,
    note,
    actor_user_id,
    actor_email,
    actor_name,
    payload
  )
  values (
    'inbound',
    p_item_code,
    v_rack,
    p_qty,
    '',
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    jsonb_build_object('rack_code', v_rack, 'quantity', p_qty)
  );

  return jsonb_build_object(
    'ok', true,
    'row', v_row,
    'cells', public.warehouse_get_cells(v_row)
  );
end;
$$;

create or replace function public.warehouse_post_outbound(
  p_rack_code text,
  p_item_code text,
  p_qty integer,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_rack text := public.warehouse_to_canonical_code(p_rack_code);
  v_row text;
  v_bay integer;
  v_level integer;
  v_current integer;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'qty must be greater than 0';
  end if;

  select row_label, bay, level
    into v_row, v_bay, v_level
  from public.warehouse_parse_rack_code(v_rack)
  limit 1;

  if v_row is null then
    raise exception 'Invalid rack code: %', p_rack_code;
  end if;

  select quantity
    into v_current
  from public.warehouse_racks
  where rack_code = v_rack
    and item_code = p_item_code
  for update;

  if coalesce(v_current, 0) < p_qty then
    raise exception 'Not enough quantity in rack';
  end if;

  update public.warehouse_racks
  set quantity = quantity - p_qty
  where rack_code = v_rack
    and item_code = p_item_code;

  delete from public.warehouse_racks
  where rack_code = v_rack
    and item_code = p_item_code
    and quantity <= 0;

  insert into public.warehouse_movements (
    movement_type,
    item_code,
    rack_code,
    quantity,
    note,
    actor_user_id,
    actor_email,
    actor_name,
    payload
  )
  values (
    'outbound',
    p_item_code,
    v_rack,
    p_qty,
    '',
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    jsonb_build_object('rack_code', v_rack, 'quantity', p_qty)
  );

  return jsonb_build_object(
    'ok', true,
    'row', v_row,
    'cells', public.warehouse_get_cells(v_row)
  );
end;
$$;

create or replace function public.warehouse_post_move(
  p_from_rack text,
  p_to_rack text,
  p_item_code text,
  p_qty integer,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_from text := public.warehouse_to_canonical_code(p_from_rack);
  v_to text := public.warehouse_to_canonical_code(p_to_rack);
  v_from_row text;
  v_from_bay integer;
  v_from_level integer;
  v_to_row text;
  v_to_bay integer;
  v_to_level integer;
  v_current integer;
  v_rows jsonb;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'qty must be greater than 0';
  end if;

  if v_from = v_to then
    raise exception 'from_rack and to_rack must differ';
  end if;

  select row_label, bay, level
    into v_from_row, v_from_bay, v_from_level
  from public.warehouse_parse_rack_code(v_from)
  limit 1;

  select row_label, bay, level
    into v_to_row, v_to_bay, v_to_level
  from public.warehouse_parse_rack_code(v_to)
  limit 1;

  if v_from_row is null then
    raise exception 'Invalid from_rack: %', p_from_rack;
  end if;

  if v_to_row is null then
    raise exception 'Invalid to_rack: %', p_to_rack;
  end if;

  select quantity
    into v_current
  from public.warehouse_racks
  where rack_code = v_from
    and item_code = p_item_code
  for update;

  if coalesce(v_current, 0) < p_qty then
    raise exception 'Not enough quantity in source rack';
  end if;

  update public.warehouse_racks
  set quantity = quantity - p_qty
  where rack_code = v_from
    and item_code = p_item_code;

  delete from public.warehouse_racks
  where rack_code = v_from
    and item_code = p_item_code
    and quantity <= 0;

  insert into public.warehouse_racks (rack_code, item_code, quantity)
  values (v_to, p_item_code, p_qty)
  on conflict (rack_code, item_code)
  do update set quantity = public.warehouse_racks.quantity + excluded.quantity;

  insert into public.warehouse_movements (
    movement_type,
    item_code,
    from_rack,
    to_rack,
    quantity,
    note,
    actor_user_id,
    actor_email,
    actor_name,
    payload
  )
  values (
    'move',
    p_item_code,
    v_from,
    v_to,
    p_qty,
    '',
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    jsonb_build_object('from_rack', v_from, 'to_rack', v_to, 'quantity', p_qty)
  );

  if v_from_row = v_to_row then
    v_rows := jsonb_build_object(
      v_from_row, public.warehouse_get_cells(v_from_row)
    );
  else
    v_rows := jsonb_build_object(
      v_from_row, public.warehouse_get_cells(v_from_row),
      v_to_row, public.warehouse_get_cells(v_to_row)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'rows', v_rows
  );
end;
$$;

create or replace function public.warehouse_post_set_location(
  p_item_code text,
  p_location text,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_location text;
  v_used_by text;
begin
  if trim(coalesce(p_item_code, '')) = '' then
    raise exception 'item_code is required';
  end if;

  if not exists (select 1 from public.items where code = p_item_code) then
    raise exception 'Unknown item_code: %', p_item_code;
  end if;

  if trim(coalesce(p_location, '')) = '00' then
    update public.items
    set location_code = '00'
    where code = p_item_code;

    insert into public.warehouse_movements (
      movement_type,
      item_code,
      quantity,
      note,
      actor_user_id,
      actor_email,
      actor_name,
      payload
    )
    values (
      'set_location',
      p_item_code,
      0,
      '00',
      p_actor_user_id,
      trim(coalesce(p_actor_email, '')),
      trim(coalesce(p_actor_name, '')),
      jsonb_build_object('location', '00')
    );

    return jsonb_build_object('ok', true);
  end if;

  v_location := public.warehouse_to_canonical_code(p_location);
  v_used_by := public.warehouse_location_in_use(v_location, p_item_code);

  if v_used_by is not null then
    raise exception 'Location code already in use by %', v_used_by;
  end if;

  update public.items
  set location_code = v_location
  where code = p_item_code;

  insert into public.warehouse_movements (
    movement_type,
    item_code,
    quantity,
    note,
    actor_user_id,
    actor_email,
    actor_name,
    payload
  )
  values (
    'set_location',
    p_item_code,
    0,
    v_location,
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    jsonb_build_object('location', v_location)
  );

  return jsonb_build_object('ok', true);
end;
$$;
