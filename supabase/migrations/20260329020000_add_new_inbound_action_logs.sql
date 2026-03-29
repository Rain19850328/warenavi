alter table public.warehouse_movements
  drop constraint if exists warehouse_movements_movement_type_check;

alter table public.warehouse_movements
  add constraint warehouse_movements_movement_type_check
  check (movement_type in ('inbound', 'outbound', 'move', 'set_location', 'new_inbound_display'));

create or replace function public.warehouse_post_inbound(
  p_rack_code text,
  p_item_code text,
  p_qty integer,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default '',
  p_note text default '',
  p_payload jsonb default '{}'::jsonb
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
    trim(coalesce(p_note, '')),
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('rack_code', v_rack, 'quantity', p_qty)
  );

  return jsonb_build_object(
    'ok', true,
    'row', v_row,
    'cells', public.warehouse_get_cells(v_row)
  );
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
  v_pending_after integer;
  v_inbound_date_text text := to_char(p_date, 'YYYY-MM-DD');
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
    raise exception '미처리수량보다 많은 수량은 처리할 수 없습니다.';
  end if;

  v_pending_after := greatest(v_pending - v_qty, 0);

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
      p_actor_name,
      v_inbound_date_text,
      jsonb_build_object(
        'source', 'new_inbound',
        'action', v_action,
        'entry_id', p_entry_id,
        'inbound_date', v_inbound_date_text,
        'product_name', v_item.product_name,
        'pending_before', v_pending,
        'pending_after', v_pending_after
      )
    );
  end if;

  v_log := jsonb_build_object(
    'source', 'new_inbound',
    'type', v_action,
    'qty', v_qty,
    'sku_code', coalesce(v_item.sku_code, ''),
    'product_name', v_item.product_name,
    'rack_code', case when v_action = 'inbound' then public.warehouse_to_canonical_code(p_rack_code) else '' end,
    'pending_before', v_pending,
    'pending_after', v_pending_after,
    'actor_user_id', p_actor_user_id,
    'actor_email', trim(coalesce(p_actor_email, '')),
    'actor_name', trim(coalesce(p_actor_name, '')),
    'processed_at', timezone('utc', now())
  );

  update public.warehouse_new_inbound_items
  set pending_qty = v_pending_after,
      last_action = v_log,
      logs = coalesce(logs, '[]'::jsonb) || jsonb_build_array(v_log)
  where id = p_entry_id;

  if v_action = 'display' then
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
      'new_inbound_display',
      v_item.sku_code,
      v_qty,
      v_inbound_date_text,
      p_actor_user_id,
      trim(coalesce(p_actor_email, '')),
      trim(coalesce(p_actor_name, '')),
      jsonb_build_object(
        'source', 'new_inbound',
        'action', v_action,
        'entry_id', p_entry_id,
        'inbound_date', v_inbound_date_text,
        'product_name', v_item.product_name,
        'pending_before', v_pending,
        'pending_after', v_pending_after
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'date', v_inbound_date_text,
    'list', public.warehouse_get_new_inbound_list(p_date),
    'row', case when v_action = 'inbound' then coalesce(v_inbound ->> 'row', '') else '' end,
    'cells', case when v_action = 'inbound' then coalesce(v_inbound -> 'cells', '{}'::jsonb) else '{}'::jsonb end
  );
end;
$$;
