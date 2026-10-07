-- 작업 리스트 / 상품 수정 / 작업로그 함수. 전부 신규(기존 함수 시그니처 변경 없음).
-- sku_status, sku_status_history, packaging_type_list, item_stocks, items.inbound_* 는
-- MOPS 쪽에서 만든 실DB 객체라 이 저장소 마이그레이션에 없다 → 그 테이블을 읽는 함수는 plpgsql로 둔다.

-- ===========================================================================
-- 허용값 목록
-- ===========================================================================
create or replace function public.warehouse_stock_status_options()
returns text[]
language sql
immutable
as $$
  select array['안정', '주문필요', '주문완료', '보류', '1차보류', '1차보류중', '2차보류', '2차보류중', '단종', '품절']::text[]
$$;

create or replace function public.warehouse_boxtype_options()
returns text[]
language sql
immutable
as $$
  select array[
    '292번', '441번', '73번', '253번', '275번', '249번', '415번', '109번', '172번', '34번',
    '이형', '비닐팩', 'N.P',
    '비닐1호', '비닐2호', '비닐3호', '비닐4호', '비닐5호', '비닐6호', '비닐7호'
  ]::text[]
$$;

-- '' = 운반상자 없음(DB에는 NULL)
create or replace function public.warehouse_carrier_type_options()
returns text[]
language sql
immutable
as $$
  select array['', '15칸', '10칸', '6칸', '3칸', '2칸', '1칸', '별도']::text[]
$$;

-- ===========================================================================
-- 내부 도우미
-- ===========================================================================
create or replace function public.warehouse_like_pattern(p_q text)
returns text
language sql
immutable
as $$
  select '%' || replace(replace(replace(trim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

create or replace function public.warehouse_append_change(
  p_changes jsonb,
  p_field text,
  p_old jsonb,
  p_new jsonb
)
returns jsonb
language sql
immutable
as $$
  select case
    when p_old is not distinct from p_new then p_changes
    else p_changes || jsonb_build_array(jsonb_build_object('field', p_field, 'old', p_old, 'new', p_new))
  end
$$;

-- patch 안의 숫자 값 읽기: null / '' → null, 그 외는 0 이상의 숫자만 허용
create or replace function public.warehouse_patch_numeric(p_value jsonb, p_label text)
returns numeric
language plpgsql
immutable
as $$
declare
  v_text text;
  v_num numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;

  if jsonb_typeof(p_value) not in ('number', 'string') then
    raise exception '%: 숫자를 입력하세요', p_label;
  end if;

  v_text := trim(p_value #>> '{}');
  if v_text = '' then
    return null;
  end if;

  if char_length(v_text) > 20 or v_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception '%: 0 이상의 숫자를 입력하세요', p_label;
  end if;

  v_num := round(v_text::numeric, 2);
  if v_num > 9999999999.99 then
    raise exception '%: 값이 너무 큽니다', p_label;
  end if;

  return v_num;
end;
$$;

create or replace function public.warehouse_log_action(
  p_action text,
  p_entity text default '',
  p_entity_id text default '',
  p_work_date date default null,
  p_item_code text default null,
  p_detail jsonb default '{}'::jsonb,
  p_source text default 'web',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns bigint
language plpgsql
as $$
declare
  v_code text := nullif(trim(coalesce(p_item_code, '')), '');
  v_name text;
  v_location text;
  v_id bigint;
begin
  if v_code is not null then
    select i.name, i.location_code
      into v_name, v_location
    from public.items i
    where i.code = v_code;
  end if;

  insert into public.warehouse_action_logs (
    action,
    entity,
    entity_id,
    work_date,
    item_code,
    item_name,
    location_code,
    detail,
    source,
    actor_user_id,
    actor_email,
    actor_name,
    created_at
  )
  values (
    p_action,
    coalesce(p_entity, ''),
    coalesce(p_entity_id, ''),
    p_work_date,
    v_code,
    coalesce(v_name, ''),
    coalesce(v_location, ''),
    coalesce(p_detail, '{}'::jsonb),
    coalesce(nullif(trim(coalesce(p_source, '')), ''), 'web'),
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, '')),
    now()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- MOPS sku_status.py `_set_one_column` 과 같은 규칙:
-- sku_status.stock_status 한 칸만 upsert + updated_at, 값이 바뀔 때만 이력 1건.
-- item_status(판매등급)는 절대 쓰지 않는다. 반환값 = 변경 전 값(없으면 null).
create or replace function public.warehouse_set_stock_status(
  p_item_code text,
  p_value text,
  p_source text default 'warehouse_web'
)
returns text
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_value text := trim(coalesce(p_value, ''));
  v_old text;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if not exists (select 1 from public.items i where i.code = v_code) then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  if v_value = '' then
    raise exception '재고상태를 선택하세요';
  end if;

  if not (v_value = any (public.warehouse_stock_status_options())) then
    raise exception '허용되지 않는 재고상태입니다: %', v_value;
  end if;

  select ss.stock_status
    into v_old
  from public.sku_status ss
  where ss.sku_cd = v_code
  for update;

  insert into public.sku_status as ss (sku_cd, stock_status, updated_at)
  values (v_code, v_value, now())
  on conflict (sku_cd) do update
    set stock_status = excluded.stock_status,
        updated_at = now();

  if coalesce(trim(v_old), '') is distinct from v_value then
    insert into public.sku_status_history (sku_cd, status_type, old_value, new_value, source, changed_at)
    values (
      v_code,
      'stock',
      v_old,
      v_value,
      left(coalesce(nullif(trim(coalesce(p_source, '')), ''), 'warehouse_web'), 32),
      now()
    );
  end if;

  return v_old;
end;
$$;

-- 스토리지렉 위치별 수량: [{rack_code, qty}] (rack_code 순)
create or replace function public.warehouse_item_racks(p_item_code text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_result jsonb;
begin
  select coalesce(
      jsonb_agg(jsonb_build_object('rack_code', t.canon_code, 'qty', t.total_qty) order by t.canon_code),
      '[]'::jsonb
    )
    into v_result
  from (
    select
      public.warehouse_to_canonical_code(wr.rack_code) as canon_code,
      sum(wr.quantity)::integer as total_qty
    from public.warehouse_racks wr
    where wr.item_code = p_item_code
      and wr.quantity > 0
    group by public.warehouse_to_canonical_code(wr.rack_code)
  ) t;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- 단품(SKU:1 / SKU:1.0) 포장 정보. 중복 행이 있으면 id가 가장 큰 행을 읽는다.
create or replace function public.warehouse_item_single_packaging(p_item_code text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_box text;
  v_carrier text;
  v_count integer := 0;
begin
  select p.boxtype, p.carrier_type
    into v_box, v_carrier
  from public.packaging_type_list p
  where p.name in (p_item_code || ':1', p_item_code || ':1.0')
  order by p.id desc
  limit 1;

  select count(*)
    into v_count
  from public.packaging_type_list p
  where p.name in (p_item_code || ':1', p_item_code || ':1.0');

  return jsonb_build_object(
    'boxtype', coalesce(v_box, ''),
    'carrier_type', coalesce(v_carrier, ''),
    'row_count', coalesce(v_count, 0)
  );
end;
$$;

-- 해당 날짜(들)에 열려 있는 요청이 있는지
create or replace function public.warehouse_item_open_requests(
  p_item_code text,
  p_date date,
  p_alt_date date default null
)
returns jsonb
language plpgsql
stable
as $$
begin
  return jsonb_build_object(
    'stock_check', exists (
      select 1
      from public.warehouse_stock_check_requests r
      where r.item_code = p_item_code
        and r.status = 'pending'
        and (r.check_date = p_date or (p_alt_date is not null and r.check_date = p_alt_date))
    ),
    'display', exists (
      select 1
      from public.warehouse_display_requests d
      where d.item_code = p_item_code
        and d.status = 'open'
        and (d.request_date = p_date or (p_alt_date is not null and d.request_date = p_alt_date))
    )
  );
end;
$$;

-- ITEM 모양. 상품이 없으면 null.
create or replace function public.warehouse_item_json(p_item_code text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_item record;
  v_item_status text;
  v_stock_status text;
  v_status_at timestamptz;
  v_total integer;
  v_racks jsonb;
  v_rack_total integer := 0;
begin
  select i.*
    into v_item
  from public.items i
  where i.code = p_item_code;

  if not found then
    return null;
  end if;

  select ss.item_status, ss.stock_status, ss.updated_at
    into v_item_status, v_stock_status, v_status_at
  from public.sku_status ss
  where ss.sku_cd = p_item_code;

  select s.stock_today
    into v_total
  from public.item_stocks s
  where s.item_code = p_item_code;

  v_racks := public.warehouse_item_racks(p_item_code);

  select coalesce(sum((e.value ->> 'qty')::integer), 0)::integer
    into v_rack_total
  from jsonb_array_elements(v_racks) as e(value);

  return jsonb_build_object(
    'code', v_item.code,
    'name', coalesce(v_item.name, ''),
    'location', coalesce(v_item.location_code, ''),
    'inbound', jsonb_build_object(
      'w', v_item.inbound_width,
      'l', v_item.inbound_length,
      'h', v_item.inbound_height
    ),
    'outbound', jsonb_build_object(
      'w', v_item.volume_width,
      'l', v_item.volume_length,
      'h', v_item.volume_height
    ),
    'item_status', coalesce(v_item_status, ''),
    'stock_status', coalesce(v_stock_status, ''),
    'status_updated_at', coalesce(to_char(v_status_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
    'packaging', public.warehouse_item_single_packaging(p_item_code),
    'stock', jsonb_build_object(
      'total', v_total,
      'racks', v_racks,
      'rack_total', coalesce(v_rack_total, 0)
    ),
    'open_requests', public.warehouse_item_open_requests(p_item_code, public.warehouse_kst_today())
  );
end;
$$;

-- CHECK 모양
create or replace function public.warehouse_stock_check_row_json(p_row public.warehouse_stock_check_requests)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
  v_stock_status text;
  v_item_status text;
begin
  select s.stock_today
    into v_stock_today
  from public.item_stocks s
  where s.item_code = p_row.item_code;

  select ss.stock_status, ss.item_status
    into v_stock_status, v_item_status
  from public.sku_status ss
  where ss.sku_cd = p_row.item_code;

  return jsonb_build_object(
    'id', p_row.id,
    'check_date', to_char(p_row.check_date, 'YYYY-MM-DD'),
    'item_code', p_row.item_code,
    'item_name', p_row.item_name,
    'location_code', p_row.location_code,
    'db_stock', p_row.db_stock,
    'source', p_row.source,
    'sources', to_jsonb(p_row.sources),
    'request_note', p_row.request_note,
    'status', p_row.status,
    'counted_qty', p_row.counted_qty,
    'mismatch_reason', p_row.mismatch_reason,
    'resolved', p_row.resolved,
    'resolved_note', p_row.resolved_note,
    'resolved_at', p_row.resolved_at,
    'resolved_by_name', p_row.resolved_by_name,
    'checked_at', p_row.checked_at,
    'checked_by_name', p_row.checked_by_name,
    'requested_by_name', p_row.requested_by_name,
    'created_at', p_row.created_at,
    'stock_today', v_stock_today,
    'stock_status', coalesce(v_stock_status, ''),
    'item_status', coalesce(v_item_status, ''),
    'racks', public.warehouse_item_racks(p_row.item_code),
    'in_soldout', exists (
      select 1
      from public.warehouse_soldout_items so
      where so.item_code = p_row.item_code
        and so.soldout_date = p_row.check_date
    )
  );
end;
$$;

-- DISPLAY 모양
create or replace function public.warehouse_display_request_row_json(p_row public.warehouse_display_requests)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
  v_stock_status text;
begin
  select s.stock_today
    into v_stock_today
  from public.item_stocks s
  where s.item_code = p_row.item_code;

  select ss.stock_status
    into v_stock_status
  from public.sku_status ss
  where ss.sku_cd = p_row.item_code;

  return jsonb_build_object(
    'id', p_row.id,
    'request_date', to_char(p_row.request_date, 'YYYY-MM-DD'),
    'item_code', p_row.item_code,
    'item_name', p_row.item_name,
    'location_code', p_row.location_code,
    'db_stock', p_row.db_stock,
    'source', p_row.source,
    'sources', to_jsonb(p_row.sources),
    'request_note', p_row.request_note,
    'status', p_row.status,
    'done_at', p_row.done_at,
    'done_by_name', p_row.done_by_name,
    'requested_by_name', p_row.requested_by_name,
    'created_at', p_row.created_at,
    'stock_today', v_stock_today,
    'stock_status', coalesce(v_stock_status, ''),
    'racks', public.warehouse_item_racks(p_row.item_code),
    'in_soldout', exists (
      select 1
      from public.warehouse_soldout_items so
      where so.item_code = p_row.item_code
        and so.soldout_date = p_row.request_date
    )
  );
end;
$$;

-- IRREGULAR 모양. open_requests 는 작업일 또는 오늘(KST)에 열려 있는 요청 기준.
create or replace function public.warehouse_irregular_row_json(p_row public.warehouse_irregular_items)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
begin
  select s.stock_today
    into v_stock_today
  from public.item_stocks s
  where s.item_code = p_row.item_code;

  return jsonb_build_object(
    'id', p_row.id,
    'work_date', to_char(p_row.work_date, 'YYYY-MM-DD'),
    'batch_key', p_row.batch_key,
    'item_code', p_row.item_code,
    'item_name', p_row.item_name,
    'location_code', p_row.location_code,
    'qty', p_row.qty,
    'order_count', p_row.order_count,
    'mixed_order_count', p_row.mixed_order_count,
    'expected_box_count', p_row.expected_box_count,
    'status', p_row.status,
    'stale', p_row.stale,
    'export_count', p_row.export_count,
    'last_exported_at', p_row.last_exported_at,
    'status_changed_at', p_row.status_changed_at,
    'status_changed_by_name', p_row.status_changed_by_name,
    'stock_today', v_stock_today,
    'racks', public.warehouse_item_racks(p_row.item_code),
    'open_requests', public.warehouse_item_open_requests(
      p_row.item_code,
      p_row.work_date,
      public.warehouse_kst_today()
    )
  );
end;
$$;

-- SOLDOUT 모양
create or replace function public.warehouse_soldout_row_json(p_row public.warehouse_soldout_items)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
  v_stock_status text;
  v_item_status text;
begin
  select s.stock_today
    into v_stock_today
  from public.item_stocks s
  where s.item_code = p_row.item_code;

  select ss.stock_status, ss.item_status
    into v_stock_status, v_item_status
  from public.sku_status ss
  where ss.sku_cd = p_row.item_code;

  return jsonb_build_object(
    'id', p_row.id,
    'soldout_date', to_char(p_row.soldout_date, 'YYYY-MM-DD'),
    'item_code', p_row.item_code,
    'item_name', p_row.item_name,
    'location_code', p_row.location_code,
    'db_stock', p_row.db_stock,
    'source', p_row.source,
    'sources', to_jsonb(p_row.sources),
    'status_at_add', p_row.status_at_add,
    'last_set_status', p_row.last_set_status,
    'last_set_at', p_row.last_set_at,
    'last_set_by_name', p_row.last_set_by_name,
    'added_by_name', p_row.added_by_name,
    'created_at', p_row.created_at,
    'stock_today', v_stock_today,
    'stock_status', coalesce(v_stock_status, ''),
    'item_status', coalesce(v_item_status, ''),
    'disabled', coalesce(trim(v_stock_status), '') in ('주문완료', '단종')
  );
end;
$$;

-- 재고확인 자동 대상(오늘 날짜만) 지연 생성. 넣은 건수 반환.
-- 단종 아님 + 재고 0~9, 또는 단종 + 재고 1~9. 그 날짜에 이미 행이 있는 상품은 건너뛴다.
create or replace function public.warehouse_ensure_stock_check_auto(p_date date)
returns integer
language plpgsql
as $$
declare
  v_count integer := 0;
begin
  if p_date is null or p_date <> public.warehouse_kst_today() then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('warehouse_stock_check_auto:' || to_char(p_date, 'YYYY-MM-DD'), 0));

  insert into public.warehouse_stock_check_requests (
    check_date,
    item_code,
    item_name,
    location_code,
    db_stock,
    source,
    sources,
    status,
    requested_by_name
  )
  select
    p_date,
    i.code,
    coalesce(i.name, ''),
    coalesce(i.location_code, ''),
    s.stock_today,
    'auto_low_stock',
    array['auto_low_stock']::text[],
    'pending',
    '자동'
  from public.item_stocks s
  join public.items i on i.code = s.item_code
  left join public.sku_status ss on ss.sku_cd = i.code
  where s.stock_today is not null
    and (
      (
        not (coalesce(ss.stock_status, '') = '단종' or coalesce(ss.item_status, '') = '단종')
        and s.stock_today between 0 and 9
      )
      or (
        (coalesce(ss.stock_status, '') = '단종' or coalesce(ss.item_status, '') = '단종')
        and s.stock_today between 1 and 9
      )
    )
    and not exists (
      select 1
      from public.warehouse_stock_check_requests r
      where r.check_date = p_date
        and r.item_code = i.code
    )
  on conflict do nothing;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform public.warehouse_log_action(
      'stock_check_auto',
      'stock_check',
      '',
      p_date,
      null,
      jsonb_build_object('count', v_count),
      'system',
      null,
      '',
      '자동'
    );
  end if;

  return v_count;
end;
$$;

-- ===========================================================================
-- 상품조회
-- ===========================================================================
create or replace function public.warehouse_get_item_options()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'stock_statuses', to_jsonb(public.warehouse_stock_status_options()),
    'boxtypes', to_jsonb(public.warehouse_boxtype_options()),
    'carrier_types', to_jsonb(public.warehouse_carrier_type_options())
  )
$$;

create or replace function public.warehouse_search_items(p_q text default '', p_limit integer default 100)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_like text := public.warehouse_like_pattern(p_q);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_result jsonb;
begin
  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code', t.code,
          'name', t.name,
          'location', coalesce(t.location_code, ''),
          'stock_qty', coalesce(s.stock_today, 0),
          'rack_qty', coalesce(rq.rack_qty, 0),
          'item_status', coalesce(ss.item_status, ''),
          'stock_status', coalesce(ss.stock_status, '')
        )
        order by t.is_exact desc, t.code asc
      ),
      '[]'::jsonb
    )
    into v_result
  from (
    select
      i.code,
      i.name,
      i.location_code,
      (v_q <> '' and upper(i.code) = upper(v_q)) as is_exact
    from public.items i
    where v_q = ''
      or i.code ilike v_like
      or i.name ilike v_like
      or i.location_code ilike v_like
    order by (v_q <> '' and upper(i.code) = upper(v_q)) desc, i.code asc
    limit v_limit
  ) t
  left join public.item_stocks s on s.item_code = t.code
  left join public.sku_status ss on ss.sku_cd = t.code
  left join lateral (
    select sum(wr.quantity)::integer as rack_qty
    from public.warehouse_racks wr
    where wr.item_code = t.code
  ) rq on true;

  return jsonb_build_object('items', coalesce(v_result, '[]'::jsonb));
end;
$$;

create or replace function public.warehouse_get_item(p_code text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  v_item jsonb;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  v_item := public.warehouse_item_json(v_code);
  if v_item is null then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  return jsonb_build_object('item', v_item);
end;
$$;

create or replace function public.warehouse_update_item(
  p_item_code text,
  p_patch jsonb,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_key text;
  v_item record;
  v_changes jsonb := '[]'::jsonb;
  v_new_name text;
  v_loc_in text;
  v_new_location text;
  v_used_by text;
  v_out_w numeric;
  v_out_l numeric;
  v_out_h numeric;
  v_in_w numeric;
  v_in_l numeric;
  v_in_h numeric;
  v_items_dirty boolean := false;
  v_old_status text := '';
  v_new_status text := '';
  v_status_dirty boolean := false;
  v_old_box text := '';
  v_old_carrier text := '';
  v_new_box text := '';
  v_new_carrier text := '';
  v_pkg_count integer := 0;
  v_box_dirty boolean := false;
  v_carrier_dirty boolean := false;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if jsonb_typeof(v_patch) <> 'object' then
    raise exception '수정 내용 형식이 올바르지 않습니다';
  end if;

  if v_patch ? 'item_status' then
    raise exception '판매등급은 MOPS에서만 변경할 수 있습니다';
  end if;

  for v_key in select k.key_name from jsonb_object_keys(v_patch) as k(key_name) loop
    if v_key not in (
      'name', 'location',
      'inbound_w', 'inbound_l', 'inbound_h',
      'outbound_w', 'outbound_l', 'outbound_h',
      'stock_status', 'boxtype', 'carrier_type'
    ) then
      raise exception '수정할 수 없는 항목입니다: %', v_key;
    end if;
  end loop;

  select i.*
    into v_item
  from public.items i
  where i.code = v_code
  for update;

  if not found then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  -- 상품명
  v_new_name := v_item.name;
  if v_patch ? 'name' then
    if jsonb_typeof(v_patch -> 'name') <> 'string' then
      raise exception '상품명을 입력하세요';
    end if;

    v_new_name := regexp_replace(v_patch ->> 'name', '^\s+|\s+$', '', 'g');
    if v_new_name = '' then
      raise exception '상품명을 입력하세요';
    end if;
    if char_length(v_new_name) > 255 then
      raise exception '상품명은 255자 이하로 입력하세요';
    end if;
    if position('<' in v_new_name) > 0 or position('>' in v_new_name) > 0 then
      raise exception '상품명에 < 또는 > 문자는 사용할 수 없습니다';
    end if;

    v_changes := public.warehouse_append_change(v_changes, 'name', to_jsonb(v_item.name::text), to_jsonb(v_new_name));
  end if;

  -- 로케이션: '' / '00' → '00'(미지정, 중복 허용). 그 외는 warehouse_post_set_location 과 같은 규칙.
  v_new_location := v_item.location_code;
  if v_patch ? 'location' then
    if jsonb_typeof(v_patch -> 'location') not in ('string', 'null') then
      raise exception '로케이션 형식이 올바르지 않습니다';
    end if;

    v_loc_in := trim(coalesce(v_patch ->> 'location', ''));
    if v_loc_in in ('', '00') then
      v_new_location := '00';
    else
      if char_length(v_loc_in) > 64 or position('<' in v_loc_in) > 0 or position('>' in v_loc_in) > 0 then
        raise exception '로케이션 형식이 올바르지 않습니다';
      end if;

      v_new_location := public.warehouse_to_canonical_code(v_loc_in);
      if v_new_location is distinct from v_item.location_code then
        v_used_by := public.warehouse_location_in_use(v_new_location, v_code);
        if v_used_by is not null then
          raise exception '이미 다른 상품(%)이 사용 중인 로케이션입니다', v_used_by;
        end if;
      end if;
    end if;

    v_changes := public.warehouse_append_change(
      v_changes, 'location', to_jsonb(v_item.location_code::text), to_jsonb(v_new_location)
    );
  end if;

  -- 출고사이즈(volume_*): 필수
  v_out_w := v_item.volume_width;
  v_out_l := v_item.volume_length;
  v_out_h := v_item.volume_height;

  if v_patch ? 'outbound_w' then
    v_out_w := public.warehouse_patch_numeric(v_patch -> 'outbound_w', '출고 가로');
    if v_out_w is null then
      raise exception '출고사이즈는 비워 둘 수 없습니다';
    end if;
  end if;
  if v_patch ? 'outbound_l' then
    v_out_l := public.warehouse_patch_numeric(v_patch -> 'outbound_l', '출고 세로');
    if v_out_l is null then
      raise exception '출고사이즈는 비워 둘 수 없습니다';
    end if;
  end if;
  if v_patch ? 'outbound_h' then
    v_out_h := public.warehouse_patch_numeric(v_patch -> 'outbound_h', '출고 높이');
    if v_out_h is null then
      raise exception '출고사이즈는 비워 둘 수 없습니다';
    end if;
  end if;

  -- 입고사이즈(inbound_*): 세 칸 모두 비우면 출고값 복사, 일부만 비우면 오류
  v_in_w := v_item.inbound_width;
  v_in_l := v_item.inbound_length;
  v_in_h := v_item.inbound_height;

  if v_patch ? 'inbound_w' or v_patch ? 'inbound_l' or v_patch ? 'inbound_h' then
    if v_patch ? 'inbound_w' then
      v_in_w := public.warehouse_patch_numeric(v_patch -> 'inbound_w', '입고 가로');
    end if;
    if v_patch ? 'inbound_l' then
      v_in_l := public.warehouse_patch_numeric(v_patch -> 'inbound_l', '입고 세로');
    end if;
    if v_patch ? 'inbound_h' then
      v_in_h := public.warehouse_patch_numeric(v_patch -> 'inbound_h', '입고 높이');
    end if;

    if v_in_w is null and v_in_l is null and v_in_h is null then
      v_in_w := v_out_w;
      v_in_l := v_out_l;
      v_in_h := v_out_h;
    elsif v_in_w is null or v_in_l is null or v_in_h is null then
      raise exception '입고사이즈는 세 칸을 모두 입력하거나 모두 비워 주세요';
    end if;
  end if;

  v_changes := public.warehouse_append_change(v_changes, 'inbound_w', to_jsonb(v_item.inbound_width::numeric), to_jsonb(v_in_w));
  v_changes := public.warehouse_append_change(v_changes, 'inbound_l', to_jsonb(v_item.inbound_length::numeric), to_jsonb(v_in_l));
  v_changes := public.warehouse_append_change(v_changes, 'inbound_h', to_jsonb(v_item.inbound_height::numeric), to_jsonb(v_in_h));
  v_changes := public.warehouse_append_change(v_changes, 'outbound_w', to_jsonb(v_item.volume_width::numeric), to_jsonb(v_out_w));
  v_changes := public.warehouse_append_change(v_changes, 'outbound_l', to_jsonb(v_item.volume_length::numeric), to_jsonb(v_out_l));
  v_changes := public.warehouse_append_change(v_changes, 'outbound_h', to_jsonb(v_item.volume_height::numeric), to_jsonb(v_out_h));

  v_items_dirty :=
    v_new_name is distinct from v_item.name
    or v_new_location is distinct from v_item.location_code
    or v_out_w is distinct from v_item.volume_width
    or v_out_l is distinct from v_item.volume_length
    or v_out_h is distinct from v_item.volume_height
    or v_in_w is distinct from v_item.inbound_width
    or v_in_l is distinct from v_item.inbound_length
    or v_in_h is distinct from v_item.inbound_height;

  -- 재고상태
  if v_patch ? 'stock_status' then
    select ss.stock_status
      into v_old_status
    from public.sku_status ss
    where ss.sku_cd = v_code;

    v_old_status := coalesce(trim(v_old_status), '');
    v_new_status := trim(coalesce(v_patch ->> 'stock_status', ''));

    if v_new_status is distinct from v_old_status then
      if v_new_status = '' then
        raise exception '재고상태를 선택하세요';
      end if;
      if not (v_new_status = any (public.warehouse_stock_status_options())) then
        raise exception '허용되지 않는 재고상태입니다: %', v_new_status;
      end if;

      v_status_dirty := true;
      v_changes := public.warehouse_append_change(
        v_changes, 'stock_status', to_jsonb(v_old_status), to_jsonb(v_new_status)
      );
    end if;
  end if;

  -- 단품 포장타입 / 운반상자
  if v_patch ? 'boxtype' or v_patch ? 'carrier_type' then
    select p.boxtype, p.carrier_type
      into v_old_box, v_old_carrier
    from public.packaging_type_list p
    where p.name in (v_code || ':1', v_code || ':1.0')
    order by p.id desc
    limit 1;

    select count(*)
      into v_pkg_count
    from public.packaging_type_list p
    where p.name in (v_code || ':1', v_code || ':1.0');

    v_old_box := coalesce(trim(v_old_box), '');
    v_old_carrier := coalesce(trim(v_old_carrier), '');
    v_new_box := v_old_box;
    v_new_carrier := v_old_carrier;

    if v_patch ? 'boxtype' then
      v_new_box := trim(coalesce(v_patch ->> 'boxtype', ''));
    end if;
    if v_patch ? 'carrier_type' then
      v_new_carrier := trim(coalesce(v_patch ->> 'carrier_type', ''));
    end if;

    if v_new_box is distinct from v_old_box or v_new_carrier is distinct from v_old_carrier then
      if v_new_box = '' then
        raise exception '포장타입을 선택하세요';
      end if;
      if v_new_box is distinct from v_old_box
         and not (v_new_box = any (public.warehouse_boxtype_options())) then
        raise exception '허용되지 않는 포장타입입니다: %', v_new_box;
      end if;
      if v_new_carrier is distinct from v_old_carrier
         and not (v_new_carrier = any (public.warehouse_carrier_type_options())) then
        raise exception '허용되지 않는 운반상자입니다: %', v_new_carrier;
      end if;

      -- MOPS carrier_fit.carrier_for_boxtype_change: 이형 → 별도, N.P → 없음, 그 외 박스에 별도 → 없음
      if v_new_box = '이형' then
        v_new_carrier := '별도';
      elsif v_new_box = 'N.P' or v_new_carrier = '별도' then
        v_new_carrier := '';
      end if;

      v_box_dirty := v_new_box is distinct from v_old_box;
      v_carrier_dirty := v_new_carrier is distinct from v_old_carrier;

      v_changes := public.warehouse_append_change(v_changes, 'boxtype', to_jsonb(v_old_box), to_jsonb(v_new_box));
      v_changes := public.warehouse_append_change(
        v_changes, 'carrier_type', to_jsonb(v_old_carrier), to_jsonb(v_new_carrier)
      );
    end if;
  end if;

  if jsonb_array_length(v_changes) = 0 then
    return jsonb_build_object(
      'ok', true,
      'changed', '[]'::jsonb,
      'item', public.warehouse_item_json(v_code)
    );
  end if;

  if v_items_dirty then
    update public.items i
    set name = v_new_name,
        location_code = v_new_location,
        volume_width = v_out_w,
        volume_length = v_out_l,
        volume_height = v_out_h,
        inbound_width = v_in_w,
        inbound_length = v_in_l,
        inbound_height = v_in_h
    where i.code = v_code;
  end if;

  if v_status_dirty then
    perform public.warehouse_set_stock_status(v_code, v_new_status, 'warehouse_web');
  end if;

  if v_box_dirty or v_carrier_dirty then
    if v_pkg_count = 0 then
      insert into public.packaging_type_list (name, boxtype, carrier_type)
      values (v_code || ':1', v_new_box, nullif(v_new_carrier, ''));
    else
      update public.packaging_type_list p
      set boxtype = case when v_box_dirty then v_new_box else p.boxtype end,
          carrier_type = case when v_carrier_dirty then nullif(v_new_carrier, '') else p.carrier_type end
      where p.name in (v_code || ':1', v_code || ':1.0');
    end if;
  end if;

  perform public.warehouse_log_action(
    'item_update',
    'item',
    v_code,
    public.warehouse_kst_today(),
    v_code,
    jsonb_build_object('changes', v_changes),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object(
    'ok', true,
    'changed', v_changes,
    'item', public.warehouse_item_json(v_code)
  );
end;
$$;

-- 재고상태 단건 변경 (품절관리 탭에서는 p_soldout_id 와 함께 호출)
create or replace function public.warehouse_post_stock_status(
  p_item_code text,
  p_value text,
  p_soldout_id uuid default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_value text := trim(coalesce(p_value, ''));
  v_current text;
  v_old text;
  v_soldout_item text;
  v_soldout_date date;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if not exists (select 1 from public.items i where i.code = v_code) then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  if p_soldout_id is not null then
    select so.item_code, so.soldout_date
      into v_soldout_item, v_soldout_date
    from public.warehouse_soldout_items so
    where so.id = p_soldout_id
    for update;

    if not found then
      raise exception '품절관리 항목을 찾을 수 없습니다';
    end if;
    if v_soldout_item <> v_code then
      raise exception '품절관리 항목과 상품코드가 일치하지 않습니다';
    end if;

    select ss.stock_status
      into v_current
    from public.sku_status ss
    where ss.sku_cd = v_code;

    if coalesce(trim(v_current), '') in ('주문완료', '단종') then
      raise exception '재고상태가 주문완료 또는 단종인 상품은 품절관리에서 변경할 수 없습니다';
    end if;
  end if;

  v_old := public.warehouse_set_stock_status(v_code, v_value, 'warehouse_web');

  if p_soldout_id is not null then
    update public.warehouse_soldout_items so
    set last_set_status = v_value,
        last_set_at = now(),
        last_set_by_user_id = p_actor_user_id,
        last_set_by_name = trim(coalesce(p_actor_name, ''))
    where so.id = p_soldout_id;
  end if;

  if coalesce(trim(v_old), '') is distinct from v_value then
    perform public.warehouse_log_action(
      'stock_status_change',
      case when p_soldout_id is not null then 'soldout' else 'item' end,
      coalesce(p_soldout_id::text, v_code),
      coalesce(v_soldout_date, public.warehouse_kst_today()),
      v_code,
      jsonb_build_object(
        'old', coalesce(v_old, ''),
        'new', v_value,
        'via', case when p_soldout_id is not null then 'soldout' else 'item' end
      ),
      'web',
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  return jsonb_build_object('ok', true, 'old', coalesce(v_old, ''), 'new', v_value);
end;
$$;

-- ===========================================================================
-- 재고확인
-- ===========================================================================
create or replace function public.warehouse_get_stock_check_list(
  p_date date default null,
  p_only_open_mismatch boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_items jsonb;
begin
  if coalesce(p_only_open_mismatch, false) then
    select coalesce(
        jsonb_agg(
          public.warehouse_stock_check_row_json(r)
          order by r.check_date desc, r.location_code asc, r.item_code asc, r.created_at asc
        ),
        '[]'::jsonb
      )
      into v_items
    from public.warehouse_stock_check_requests r
    where r.status = 'mismatch'
      and not r.resolved;

    return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'items', coalesce(v_items, '[]'::jsonb));
  end if;

  perform public.warehouse_ensure_stock_check_auto(v_date);

  select coalesce(
      jsonb_agg(
        public.warehouse_stock_check_row_json(r)
        order by r.location_code asc, r.item_code asc, r.created_at asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_stock_check_requests r
  where r.check_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;

create or replace function public.warehouse_request_stock_check(
  p_item_code text,
  p_source text default 'item',
  p_note text default '',
  p_date date default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_source text := trim(coalesce(p_source, ''));
  v_note text := left(trim(coalesce(p_note, '')), 500);
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_name text;
  v_location text;
  v_stock integer;
  v_id uuid;
  v_created boolean;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if v_source not in ('item', 'irregular') then
    raise exception '요청 출처가 올바르지 않습니다: %', v_source;
  end if;

  select i.name, i.location_code
    into v_name, v_location
  from public.items i
  where i.code = v_code;

  if not found then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  select s.stock_today
    into v_stock
  from public.item_stocks s
  where s.item_code = v_code;

  insert into public.warehouse_stock_check_requests as t (
    check_date,
    item_code,
    item_name,
    location_code,
    db_stock,
    source,
    sources,
    request_note,
    status,
    requested_by_user_id,
    requested_by_email,
    requested_by_name
  )
  values (
    v_date,
    v_code,
    coalesce(v_name, ''),
    coalesce(v_location, ''),
    v_stock,
    v_source,
    array[v_source]::text[],
    v_note,
    'pending',
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, ''))
  )
  on conflict (check_date, item_code) where status = 'pending'
  do update set
    sources = case
      when excluded.source = any (t.sources) then t.sources
      else array_append(t.sources, excluded.source)
    end,
    request_note = case
      when excluded.request_note = '' then t.request_note
      when t.request_note = '' then excluded.request_note
      else t.request_note || ' / ' || excluded.request_note
    end
  returning t.id, (t.xmax = 0)
    into v_id, v_created;

  perform public.warehouse_log_action(
    'stock_check_request',
    'stock_check',
    v_id::text,
    v_date,
    v_code,
    jsonb_build_object('source', v_source, 'note', v_note),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', coalesce(v_created, false));
end;
$$;

create or replace function public.warehouse_record_stock_check(
  p_id uuid,
  p_result text,
  p_counted_qty integer default null,
  p_reason text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_result text := lower(trim(coalesce(p_result, '')));
  v_reason text := left(trim(coalesce(p_reason, '')), 500);
  v_row public.warehouse_stock_check_requests%rowtype;
  v_live_stock integer;
  v_db_stock integer;
  v_counted integer;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '재고확인 항목이 지정되지 않았습니다';
  end if;

  if v_result not in ('match', 'mismatch', 'pending') then
    raise exception '확인 결과가 올바르지 않습니다: %', v_result;
  end if;

  select r.*
    into v_row
  from public.warehouse_stock_check_requests r
  where r.id = p_id
  for update;

  if not found then
    raise exception '재고확인 항목을 찾을 수 없습니다';
  end if;

  select s.stock_today
    into v_live_stock
  from public.item_stocks s
  where s.item_code = v_row.item_code;

  v_db_stock := coalesce(v_live_stock, v_row.db_stock);

  if v_result = 'pending' then
    if v_row.status <> 'pending' and exists (
      select 1
      from public.warehouse_stock_check_requests o
      where o.check_date = v_row.check_date
        and o.item_code = v_row.item_code
        and o.status = 'pending'
        and o.id <> v_row.id
    ) then
      raise exception '같은 상품의 미확인 요청이 이미 있어 되돌릴 수 없습니다';
    end if;

    update public.warehouse_stock_check_requests r
    set status = 'pending',
        counted_qty = null,
        mismatch_reason = '',
        resolved = false,
        resolved_note = '',
        resolved_at = null,
        resolved_by_user_id = null,
        resolved_by_name = '',
        checked_at = null,
        checked_by_user_id = null,
        checked_by_name = ''
    where r.id = p_id;

    v_counted := null;
  elsif v_result = 'match' then
    v_counted := coalesce(p_counted_qty, v_db_stock);
    if v_counted is not null and v_counted < 0 then
      raise exception '실제 수량은 0 이상이어야 합니다';
    end if;

    update public.warehouse_stock_check_requests r
    set status = 'match',
        counted_qty = v_counted,
        mismatch_reason = '',
        resolved = false,
        resolved_note = '',
        resolved_at = null,
        resolved_by_user_id = null,
        resolved_by_name = '',
        checked_at = now(),
        checked_by_user_id = p_actor_user_id,
        checked_by_name = trim(coalesce(p_actor_name, ''))
    where r.id = p_id;
  else
    if p_counted_qty is null then
      raise exception '실제 수량을 입력하세요';
    end if;
    if p_counted_qty < 0 then
      raise exception '실제 수량은 0 이상이어야 합니다';
    end if;

    v_counted := p_counted_qty;

    update public.warehouse_stock_check_requests r
    set status = 'mismatch',
        counted_qty = v_counted,
        mismatch_reason = v_reason,
        resolved = false,
        resolved_note = '',
        resolved_at = null,
        resolved_by_user_id = null,
        resolved_by_name = '',
        checked_at = now(),
        checked_by_user_id = p_actor_user_id,
        checked_by_name = trim(coalesce(p_actor_name, ''))
    where r.id = p_id;
  end if;

  perform public.warehouse_log_action(
    case v_result
      when 'match' then 'stock_check_match'
      when 'mismatch' then 'stock_check_mismatch'
      else 'stock_check_reset'
    end,
    'stock_check',
    p_id::text,
    v_row.check_date,
    v_row.item_code,
    jsonb_build_object(
      'db_stock', v_db_stock,
      'counted_qty', v_counted,
      'reason', case when v_result = 'mismatch' then v_reason else '' end
    ),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  select public.warehouse_stock_check_row_json(r)
    into v_json
  from public.warehouse_stock_check_requests r
  where r.id = p_id;

  return jsonb_build_object('ok', true, 'item', v_json);
end;
$$;

create or replace function public.warehouse_resolve_stock_check(
  p_id uuid,
  p_resolved boolean,
  p_note text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_note text := left(trim(coalesce(p_note, '')), 500);
  v_row public.warehouse_stock_check_requests%rowtype;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '재고확인 항목이 지정되지 않았습니다';
  end if;

  if p_resolved is null then
    raise exception '처리 여부가 지정되지 않았습니다';
  end if;

  select r.*
    into v_row
  from public.warehouse_stock_check_requests r
  where r.id = p_id
  for update;

  if not found then
    raise exception '재고확인 항목을 찾을 수 없습니다';
  end if;

  if v_row.status <> 'mismatch' then
    raise exception '불일치 항목만 처리완료로 바꿀 수 있습니다';
  end if;

  if p_resolved then
    update public.warehouse_stock_check_requests r
    set resolved = true,
        resolved_note = v_note,
        resolved_at = now(),
        resolved_by_user_id = p_actor_user_id,
        resolved_by_name = trim(coalesce(p_actor_name, ''))
    where r.id = p_id;
  else
    update public.warehouse_stock_check_requests r
    set resolved = false,
        resolved_note = v_note,
        resolved_at = null,
        resolved_by_user_id = null,
        resolved_by_name = ''
    where r.id = p_id;
  end if;

  if p_resolved is distinct from v_row.resolved then
    perform public.warehouse_log_action(
      case when p_resolved then 'stock_check_resolve' else 'stock_check_reopen' end,
      'stock_check',
      p_id::text,
      v_row.check_date,
      v_row.item_code,
      jsonb_build_object('note', v_note),
      'web',
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  select public.warehouse_stock_check_row_json(r)
    into v_json
  from public.warehouse_stock_check_requests r
  where r.id = p_id;

  return jsonb_build_object('ok', true, 'item', v_json);
end;
$$;

-- ===========================================================================
-- 진열보충
-- ===========================================================================
create or replace function public.warehouse_get_display_request_list(p_date date default null)
returns jsonb
language plpgsql
stable
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_display_request_row_json(d)
        order by d.location_code asc, d.item_code asc, d.created_at asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_display_requests d
  where d.request_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;

create or replace function public.warehouse_request_display(
  p_item_code text,
  p_source text default 'item',
  p_note text default '',
  p_date date default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_source text := trim(coalesce(p_source, ''));
  v_note text := left(trim(coalesce(p_note, '')), 500);
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_name text;
  v_location text;
  v_stock integer;
  v_id uuid;
  v_created boolean;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if v_source not in ('item', 'irregular') then
    raise exception '요청 출처가 올바르지 않습니다: %', v_source;
  end if;

  select i.name, i.location_code
    into v_name, v_location
  from public.items i
  where i.code = v_code;

  if not found then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  select s.stock_today
    into v_stock
  from public.item_stocks s
  where s.item_code = v_code;

  insert into public.warehouse_display_requests as t (
    request_date,
    item_code,
    item_name,
    location_code,
    db_stock,
    source,
    sources,
    request_note,
    status,
    requested_by_user_id,
    requested_by_email,
    requested_by_name
  )
  values (
    v_date,
    v_code,
    coalesce(v_name, ''),
    coalesce(v_location, ''),
    v_stock,
    v_source,
    array[v_source]::text[],
    v_note,
    'open',
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, ''))
  )
  on conflict (request_date, item_code) where status = 'open'
  do update set
    sources = case
      when excluded.source = any (t.sources) then t.sources
      else array_append(t.sources, excluded.source)
    end,
    request_note = case
      when excluded.request_note = '' then t.request_note
      when t.request_note = '' then excluded.request_note
      else t.request_note || ' / ' || excluded.request_note
    end
  returning t.id, (t.xmax = 0)
    into v_id, v_created;

  perform public.warehouse_log_action(
    'display_request',
    'display',
    v_id::text,
    v_date,
    v_code,
    jsonb_build_object('source', v_source, 'note', v_note),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', coalesce(v_created, false));
end;
$$;

create or replace function public.warehouse_set_display_request_status(
  p_id uuid,
  p_status text,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_status text := lower(trim(coalesce(p_status, '')));
  v_row public.warehouse_display_requests%rowtype;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '진열 요청 항목이 지정되지 않았습니다';
  end if;

  if v_status not in ('open', 'done') then
    raise exception '상태 값이 올바르지 않습니다: %', v_status;
  end if;

  select d.*
    into v_row
  from public.warehouse_display_requests d
  where d.id = p_id
  for update;

  if not found then
    raise exception '진열 요청 항목을 찾을 수 없습니다';
  end if;

  if v_status is distinct from v_row.status then
    if v_status = 'done' then
      update public.warehouse_display_requests d
      set status = 'done',
          done_at = now(),
          done_by_user_id = p_actor_user_id,
          done_by_name = trim(coalesce(p_actor_name, ''))
      where d.id = p_id;
    else
      if exists (
        select 1
        from public.warehouse_display_requests o
        where o.request_date = v_row.request_date
          and o.item_code = v_row.item_code
          and o.status = 'open'
          and o.id <> v_row.id
      ) then
        raise exception '같은 상품의 미완료 진열 요청이 이미 있어 되돌릴 수 없습니다';
      end if;

      update public.warehouse_display_requests d
      set status = 'open',
          done_at = null,
          done_by_user_id = null,
          done_by_name = ''
      where d.id = p_id;
    end if;

    perform public.warehouse_log_action(
      case when v_status = 'done' then 'display_done' else 'display_reopen' end,
      'display',
      p_id::text,
      v_row.request_date,
      v_row.item_code,
      '{}'::jsonb,
      'web',
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  select public.warehouse_display_request_row_json(d)
    into v_json
  from public.warehouse_display_requests d
  where d.id = p_id;

  return jsonb_build_object('ok', true, 'item', v_json);
end;
$$;

-- ===========================================================================
-- 이형포장
-- ===========================================================================
create or replace function public.warehouse_get_irregular_list(p_date date default null)
returns jsonb
language plpgsql
stable
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_irregular_row_json(x)
        order by x.location_code asc, x.item_code asc, x.batch_key asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_irregular_items x
  where x.work_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;

-- p_patch 키: status, expected_box_count (있는 키만 적용, expected_box_count:null = 비움)
create or replace function public.warehouse_update_irregular_item(
  p_id uuid,
  p_patch jsonb,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_row public.warehouse_irregular_items%rowtype;
  v_new_status text;
  v_box_text text;
  v_new_box integer;
  v_status_dirty boolean := false;
  v_box_dirty boolean := false;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '이형포장 항목이 지정되지 않았습니다';
  end if;

  if jsonb_typeof(v_patch) <> 'object' then
    raise exception '수정 내용 형식이 올바르지 않습니다';
  end if;

  select x.*
    into v_row
  from public.warehouse_irregular_items x
  where x.id = p_id
  for update;

  if not found then
    raise exception '이형포장 항목을 찾을 수 없습니다';
  end if;

  v_new_status := v_row.status;
  if v_patch ? 'status' then
    v_new_status := trim(coalesce(v_patch ->> 'status', ''));
    if v_new_status not in ('대기', '작업중', '포장완료') then
      raise exception '상태 값이 올바르지 않습니다: %', v_new_status;
    end if;
    v_status_dirty := v_new_status is distinct from v_row.status;
  end if;

  v_new_box := v_row.expected_box_count;
  if v_patch ? 'expected_box_count' then
    if jsonb_typeof(v_patch -> 'expected_box_count') = 'null' then
      v_new_box := null;
    else
      v_box_text := trim(coalesce(v_patch ->> 'expected_box_count', ''));
      if v_box_text = '' then
        v_new_box := null;
      elsif v_box_text !~ '^[0-9]{1,6}$' then
        raise exception '예상박스수량은 0 이상의 정수로 입력하세요';
      else
        v_new_box := v_box_text::integer;
      end if;
    end if;
    v_box_dirty := v_new_box is distinct from v_row.expected_box_count;
  end if;

  if v_status_dirty or v_box_dirty then
    update public.warehouse_irregular_items x
    set status = v_new_status,
        expected_box_count = v_new_box,
        status_changed_at = case when v_status_dirty then now() else x.status_changed_at end,
        status_changed_by_user_id = case when v_status_dirty then p_actor_user_id else x.status_changed_by_user_id end,
        status_changed_by_name = case
          when v_status_dirty then trim(coalesce(p_actor_name, ''))
          else x.status_changed_by_name
        end
    where x.id = p_id;
  end if;

  if v_status_dirty then
    perform public.warehouse_log_action(
      'irregular_status',
      'irregular',
      p_id::text,
      v_row.work_date,
      v_row.item_code,
      jsonb_build_object('old', v_row.status, 'new', v_new_status),
      'web',
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  if v_box_dirty then
    perform public.warehouse_log_action(
      'irregular_box_count',
      'irregular',
      p_id::text,
      v_row.work_date,
      v_row.item_code,
      jsonb_build_object('old', v_row.expected_box_count, 'new', v_new_box),
      'web',
      p_actor_user_id,
      p_actor_email,
      p_actor_name
    );
  end if;

  select public.warehouse_irregular_row_json(x)
    into v_json
  from public.warehouse_irregular_items x
  where x.id = p_id;

  return jsonb_build_object('ok', true, 'item', v_json);
end;
$$;

-- MOPS 전용(HTTP 경로 없음). 엑셀 재출력에 안전: status / expected_box_count 는 절대 건드리지 않는다.
create or replace function public.warehouse_import_irregular_items(
  p_date date,
  p_batch_key text,
  p_items jsonb,
  p_actor_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_batch text := trim(coalesce(p_batch_key, ''));
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_codes text[] := '{}'::text[];
  v_skipped text[] := '{}'::text[];
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_stale integer := 0;
begin
  if p_date is null then
    raise exception '날짜가 필요합니다';
  end if;

  if jsonb_typeof(v_items) <> 'array' then
    raise exception '이형 목록 형식이 올바르지 않습니다';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('warehouse_irregular_import:' || to_char(p_date, 'YYYY-MM-DD') || ':' || v_batch, 0)
  );

  select coalesce(array_agg(distinct src.code), '{}'::text[])
    into v_codes
  from (
    select trim(coalesce(e.item_code, '')) as code
    from jsonb_to_recordset(v_items) as e(item_code text)
  ) src
  where src.code <> '';

  select coalesce(array_agg(c.code order by c.code), '{}'::text[])
    into v_skipped
  from unnest(v_codes) as c(code)
  where not exists (select 1 from public.items i where i.code = c.code);

  with src as (
    select
      trim(coalesce(e.item_code, '')) as code,
      max(trim(coalesce(e.item_name, ''))) as src_name,
      max(trim(coalesce(e.location_code, ''))) as src_location,
      coalesce(sum(round(coalesce(e.qty, 0))), 0)::integer as src_qty,
      coalesce(sum(round(coalesce(e.order_count, 0))), 0)::integer as src_orders,
      coalesce(sum(round(coalesce(e.mixed_order_count, 0))), 0)::integer as src_mixed
    from jsonb_to_recordset(v_items) as e(
      item_code text,
      item_name text,
      location_code text,
      qty numeric,
      order_count numeric,
      mixed_order_count numeric
    )
    group by trim(coalesce(e.item_code, ''))
  ),
  up as (
    insert into public.warehouse_irregular_items as t (
      work_date,
      batch_key,
      item_code,
      item_name,
      location_code,
      qty,
      order_count,
      mixed_order_count,
      status,
      stale,
      export_count,
      last_exported_at,
      created_at,
      updated_at
    )
    select
      p_date,
      v_batch,
      i.code,
      coalesce(nullif(src.src_name, ''), i.name, ''),
      coalesce(nullif(src.src_location, ''), i.location_code, ''),
      src.src_qty,
      src.src_orders,
      src.src_mixed,
      '대기',
      false,
      1,
      now(),
      now(),
      now()
    from src
    join public.items i on i.code = src.code
    on conflict (work_date, batch_key, item_code)
    do update set
      qty = excluded.qty,
      order_count = excluded.order_count,
      mixed_order_count = excluded.mixed_order_count,
      item_name = excluded.item_name,
      location_code = excluded.location_code,
      last_exported_at = excluded.last_exported_at,
      export_count = t.export_count + 1,
      stale = false
    returning (t.xmax = 0) as was_inserted
  )
  select
    count(*) filter (where up.was_inserted),
    count(*) filter (where not up.was_inserted)
    into v_inserted, v_updated
  from up;

  -- 같은 (날짜, 주문서)인데 이번 출력에서 빠진 건: 손대지 않은 대기 건은 삭제, 나머지는 제외 표시
  delete from public.warehouse_irregular_items t
  where t.work_date = p_date
    and t.batch_key = v_batch
    and not (t.item_code = any (v_codes))
    and t.status = '대기'
    and t.expected_box_count is null;
  get diagnostics v_deleted = row_count;

  update public.warehouse_irregular_items t
  set stale = true
  where t.work_date = p_date
    and t.batch_key = v_batch
    and not (t.item_code = any (v_codes));
  get diagnostics v_stale = row_count;

  perform public.warehouse_log_action(
    'irregular_import',
    'irregular',
    v_batch,
    p_date,
    null,
    jsonb_build_object(
      'batch_key', v_batch,
      'inserted', v_inserted,
      'updated', v_updated,
      'stale', v_stale,
      'deleted', v_deleted,
      'skipped', to_jsonb(v_skipped)
    ),
    'mops',
    null,
    '',
    p_actor_name
  );

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'stale', v_stale,
    'deleted', v_deleted,
    'skipped', to_jsonb(v_skipped)
  );
end;
$$;

-- ===========================================================================
-- 품절관리
-- ===========================================================================
create or replace function public.warehouse_get_soldout_list(p_date date default null)
returns jsonb
language plpgsql
stable
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_soldout_row_json(so)
        order by so.created_at asc, so.item_code asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_soldout_items so
  where so.soldout_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;

create or replace function public.warehouse_add_soldout_item(
  p_item_code text,
  p_source text default 'stock_check',
  p_source_id uuid default null,
  p_date date default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_code text := trim(coalesce(p_item_code, ''));
  v_source text := trim(coalesce(p_source, ''));
  v_date date := p_date;
  v_name text;
  v_location text;
  v_stock integer;
  v_status text;
  v_id uuid;
  v_created boolean;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if v_source not in ('stock_check', 'display') then
    raise exception '추가 출처가 올바르지 않습니다: %', v_source;
  end if;

  select i.name, i.location_code
    into v_name, v_location
  from public.items i
  where i.code = v_code;

  if not found then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  -- 날짜가 없으면 출처 행의 날짜를 따르고, 그것도 없으면 오늘(KST)
  if v_date is null and p_source_id is not null then
    if v_source = 'stock_check' then
      select r.check_date
        into v_date
      from public.warehouse_stock_check_requests r
      where r.id = p_source_id
        and r.item_code = v_code;
    else
      select d.request_date
        into v_date
      from public.warehouse_display_requests d
      where d.id = p_source_id
        and d.item_code = v_code;
    end if;
  end if;
  v_date := coalesce(v_date, public.warehouse_kst_today());

  select s.stock_today
    into v_stock
  from public.item_stocks s
  where s.item_code = v_code;

  select ss.stock_status
    into v_status
  from public.sku_status ss
  where ss.sku_cd = v_code;

  insert into public.warehouse_soldout_items as t (
    soldout_date,
    item_code,
    item_name,
    location_code,
    db_stock,
    source,
    sources,
    source_ref_id,
    status_at_add,
    added_by_user_id,
    added_by_email,
    added_by_name
  )
  values (
    v_date,
    v_code,
    coalesce(v_name, ''),
    coalesce(v_location, ''),
    v_stock,
    v_source,
    array[v_source]::text[],
    p_source_id,
    coalesce(trim(v_status), ''),
    p_actor_user_id,
    trim(coalesce(p_actor_email, '')),
    trim(coalesce(p_actor_name, ''))
  )
  on conflict (soldout_date, item_code)
  do update set
    sources = case
      when excluded.source = any (t.sources) then t.sources
      else array_append(t.sources, excluded.source)
    end
  returning t.id, (t.xmax = 0)
    into v_id, v_created;

  perform public.warehouse_log_action(
    'soldout_add',
    'soldout',
    v_id::text,
    v_date,
    v_code,
    jsonb_build_object('source', v_source),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', coalesce(v_created, false));
end;
$$;

create or replace function public.warehouse_remove_soldout_item(
  p_id uuid,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_item_code text;
  v_date date;
  v_source text;
begin
  if p_id is null then
    raise exception '품절관리 항목이 지정되지 않았습니다';
  end if;

  delete from public.warehouse_soldout_items so
  where so.id = p_id
  returning so.item_code, so.soldout_date, so.source
    into v_item_code, v_date, v_source;

  if not found then
    raise exception '품절관리 항목을 찾을 수 없습니다';
  end if;

  perform public.warehouse_log_action(
    'soldout_remove',
    'soldout',
    p_id::text,
    v_date,
    v_item_code,
    jsonb_build_object('source', v_source),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- ===========================================================================
-- 작업로그 (warehouse_action_logs + warehouse_movements 통합, 최신순)
-- ===========================================================================
create or replace function public.warehouse_get_action_logs(
  p_q text default '',
  p_from date default null,
  p_to date default null,
  p_limit integer default 100,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_like text := public.warehouse_like_pattern(p_q);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_from_ts timestamptz := case when p_from is null then null else (p_from::timestamp at time zone 'Asia/Seoul') end;
  v_to_ts timestamptz := case when p_to is null then null else ((p_to + 1)::timestamp at time zone 'Asia/Seoul') end;
  v_items jsonb;
  v_count integer := 0;
  v_last timestamptz;
begin
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', pg.log_id,
          'kind', pg.log_kind,
          'action', pg.log_action,
          'item_code', pg.log_item_code,
          'item_name', pg.log_item_name,
          'location_code', pg.log_location,
          'rack_text', pg.log_rack_text,
          'quantity', pg.log_quantity,
          'detail', pg.log_detail,
          'actor_name', pg.log_actor_name,
          'source', pg.log_source,
          'created_at', pg.log_created_at
        )
        order by pg.log_created_at desc, pg.log_id desc
      ),
      '[]'::jsonb
    ),
    count(*),
    min(pg.log_created_at)
    into v_items, v_count, v_last
  from (
    select u.*
    from (
      (
        select
          'a:' || al.id::text as log_id,
          'action'::text as log_kind,
          al.action as log_action,
          al.item_code as log_item_code,
          al.item_name as log_item_name,
          al.location_code as log_location,
          ''::text as log_rack_text,
          null::integer as log_quantity,
          al.detail as log_detail,
          al.actor_name as log_actor_name,
          al.source as log_source,
          al.created_at as log_created_at
        from public.warehouse_action_logs al
        where (v_from_ts is null or al.created_at >= v_from_ts)
          and (v_to_ts is null or al.created_at < v_to_ts)
          and (p_before is null or al.created_at < p_before)
          and (
            v_q = ''
            or al.item_code ilike v_like
            or al.item_name ilike v_like
            or al.location_code ilike v_like
          )
        order by al.created_at desc, al.id desc
        limit v_limit
      )
      union all
      (
        select
          'm:' || wm.id::text as log_id,
          'movement'::text as log_kind,
          wm.movement_type as log_action,
          wm.item_code as log_item_code,
          coalesce(i.name, '') as log_item_name,
          coalesce(i.location_code, '') as log_location,
          case
            when wm.from_rack is not null or wm.to_rack is not null
              then coalesce(wm.from_rack, '') || ' → ' || coalesce(wm.to_rack, '')
            else coalesce(wm.rack_code, '')
          end as log_rack_text,
          wm.quantity as log_quantity,
          coalesce(wm.payload, '{}'::jsonb) as log_detail,
          coalesce(wm.actor_name, '') as log_actor_name,
          'web'::text as log_source,
          wm.created_at as log_created_at
        from public.warehouse_movements wm
        left join public.items i on i.code = wm.item_code
        where (v_from_ts is null or wm.created_at >= v_from_ts)
          and (v_to_ts is null or wm.created_at < v_to_ts)
          and (p_before is null or wm.created_at < p_before)
          and (
            v_q = ''
            or wm.item_code ilike v_like
            or i.name ilike v_like
            or i.location_code ilike v_like
            or wm.rack_code ilike v_like
            or wm.from_rack ilike v_like
            or wm.to_rack ilike v_like
            or wm.note ilike v_like
          )
        order by wm.created_at desc, wm.id desc
        limit v_limit
      )
    ) u
    order by u.log_created_at desc, u.log_id desc
    limit v_limit
  ) pg;

  return jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'next_before', case
      when v_count >= v_limit and v_last is not null
        then to_char(v_last at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end
  );
end;
$$;

-- ===========================================================================
-- 탭 뱃지 건수
-- ===========================================================================
create or replace function public.warehouse_get_tab_counts(p_date date default null)
returns jsonb
language plpgsql
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_pending integer := 0;
  v_mismatch integer := 0;
  v_display integer := 0;
  v_irregular integer := 0;
  v_soldout integer := 0;
begin
  -- 자동 대상(재고 10 미만)은 하루 수백 건이라 뱃지에서 뺀다. 사람이 요청한 미확인 건만 센다.
  select count(*)
    into v_pending
  from public.warehouse_stock_check_requests r
  where r.check_date = v_date
    and r.status = 'pending'
    and r.sources && array['item', 'irregular']::text[];

  select count(*)
    into v_mismatch
  from public.warehouse_stock_check_requests r
  where r.status = 'mismatch'
    and not r.resolved;

  select count(*)
    into v_display
  from public.warehouse_display_requests d
  where d.request_date = v_date
    and d.status = 'open';

  select count(*)
    into v_irregular
  from public.warehouse_irregular_items x
  where x.work_date = v_date
    and x.status <> '포장완료'
    and not x.stale;

  select count(*)
    into v_soldout
  from public.warehouse_soldout_items so
  where so.soldout_date = v_date;

  return jsonb_build_object(
    'stock_check_pending', v_pending,
    'mismatch_open', v_mismatch,
    'display_open', v_display,
    'irregular_open', v_irregular,
    'soldout', v_soldout
  );
end;
$$;
