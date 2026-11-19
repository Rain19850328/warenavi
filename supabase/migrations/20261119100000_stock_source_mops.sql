-- 재고 기준을 플레이오토에서 MOPS 장부로 바꾼다(2026-11-19 10:23, app_settings 'stock.authority' = 'mops').
-- MOPS 장부(public.stock_current, mops_api.stock_count)는 창고네비와 같은 DB 에 있다.
--   1) 총 재고 출처 교체: item_stocks.stock_today 를 읽던 함수를 stock_current.real_qty 로 바꾼다.
--      응답 칸 이름('stock_today', 'stock_qty' 등)과 인자·반환 모양은 그대로다. 장부에 행이 없는 상품은 예전과 똑같이 처리(null, 또는 coalesce 로 0).
--   2) 재고실사 비교 기준 = MOPS 장부: 기록·요청 때 p_live_stock 이 비어 있으면 장부 실재고를 live_stock 으로 남긴다.
--   3) 실사반영을 MOPS 장부에 맞추는 warehouse_apply_count_to_mops 추가(플레이오토 전송 대신).
--      (warehouse_review_stock_check · warehouse_set_stock_check_playauto · warehouse_stock_check_clear_review 의
--       플레이오토 문구도 MOPS 장부 문구로 바꾼다.)
--   4) 사무실 PC 전송기 대기 목록(warehouse_playauto_queue)을 비운다(전송기 은퇴).
-- 표·칸·함수는 지우지 않는다. 칸 이름(live_stock, playauto_status 등)도 그대로 둔다.
-- 참고: item_stocks 는 더 이상 이 앱 함수에서 읽지 않지만 표는 남겨 둔다.

-- 1) 총 재고 출처 교체: 아래 12개 함수는 "public.item_stocks s" -> "public.stock_current s", "s.stock_today" -> "s.real_qty" 만 바뀜
--    (warehouse_stock_check_row_json 은 live_stock 설명 주석 한 줄도 고침)

create or replace function public.warehouse_get_items_with_stock(p_q text default '', p_limit integer default 300)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 5000);
begin
  return jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', t.code,
          'name', t.name,
          'w', t.volume_width,
          'l', t.volume_length,
          'h', t.volume_height,
          'unit_cm3', (
            greatest(t.volume_width, 0::numeric) *
            greatest(t.volume_length, 0::numeric) *
            greatest(t.volume_height, 0::numeric)
          )::integer,
          'location', coalesce(t.location_code, ''),
          'stock_qty', coalesce(s.real_qty, 0)
        )
        order by t.code, t.name
      )
      from (
        select *
        from public.items i
        where v_q = ''
          or i.code ilike '%' || v_q || '%'
          or i.name ilike '%' || v_q || '%'
          or i.location_code ilike '%' || v_q || '%'
        order by i.code asc, i.name asc
        limit v_limit
      ) t
      left join public.stock_current s on s.item_code = t.code
    ), '[]'::jsonb)
  );
end;
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
          'stock_qty', coalesce(s.real_qty, 0),
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
  left join public.stock_current s on s.item_code = t.code
  left join public.sku_status ss on ss.sku_cd = t.code
  left join lateral (
    select sum(wr.quantity)::integer as rack_qty
    from public.warehouse_racks wr
    where wr.item_code = t.code
  ) rq on true;

  return jsonb_build_object('items', coalesce(v_result, '[]'::jsonb));
end;
$$;

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

  select s.real_qty
    into v_total
  from public.stock_current s
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

create or replace function public.warehouse_irregular_row_json(p_row public.warehouse_irregular_items)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
begin
  select s.real_qty
    into v_stock_today
  from public.stock_current s
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

create or replace function public.warehouse_irregular_bundle_json(p_row public.warehouse_irregular_bundles)
returns jsonb
language plpgsql
stable
as $$
declare
  v_today date := public.warehouse_kst_today();
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'item_code', x.item_code,
          'item_name', x.item_name,
          'location_code', x.location_code,
          'qty', x.qty,
          'stock_today', s.real_qty,
          'racks', public.warehouse_item_racks(x.item_code),
          'open_requests', public.warehouse_item_open_requests(x.item_code, p_row.work_date, v_today)
        )
        order by public.warehouse_location_sort_key(x.location_code) asc nulls last, x.location_code asc, x.item_code asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_irregular_bundle_items x
  left join public.stock_current s on s.item_code = x.item_code
  where x.bundle_id = p_row.id;

  return jsonb_build_object(
    'id', p_row.id,
    'work_date', to_char(p_row.work_date, 'YYYY-MM-DD'),
    'batch_key', p_row.batch_key,
    'bundle_no', p_row.bundle_no,
    'box_no', p_row.box_no,
    'expected_box_count', p_row.expected_box_count,
    'status', p_row.status,
    'stale', p_row.stale,
    'export_count', p_row.export_count,
    'last_exported_at', p_row.last_exported_at,
    'status_changed_at', p_row.status_changed_at,
    'status_changed_by_name', p_row.status_changed_by_name,
    'items', v_items
  );
end;
$$;

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
  select s.real_qty
    into v_stock_today
  from public.stock_current s
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
    -- 판단 표시: '' = 판단 전, '완료' | '보류' | '미반영'
    'handled_as', coalesce(p_row.handled_as, ''),
    'handled_at', p_row.handled_at,
    'handled_by_name', coalesce(p_row.handled_by_name, ''),
    -- 판단을 마친 줄(완료·미반영)은 화면에서 연하게 보인다. 보류는 판단 전으로 남는다.
    'disabled', coalesce(p_row.handled_as, '') not in ('', '보류'),
    -- 스토리지렉 위치별 수량(진열보충·재고확인 카드와 같은 재고정보 표시용)
    'racks', public.warehouse_item_racks(p_row.item_code)
  );
end;
$$;

create or replace function public.warehouse_display_request_row_json(p_row public.warehouse_display_requests)
returns jsonb
language plpgsql
stable
as $$
declare
  v_stock_today integer;
  v_stock_status text;
begin
  select s.real_qty
    into v_stock_today
  from public.stock_current s
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
    'taken_rack_code', p_row.taken_rack_code,
    'taken_qty', p_row.taken_qty,
    'requested_by_name', p_row.requested_by_name,
    'created_at', p_row.created_at,
    'stock_today', v_stock_today,
    'stock_status', coalesce(v_stock_status, ''),
    'racks', public.warehouse_item_racks(p_row.item_code),
    'stock_requested', exists (
      select 1
      from public.warehouse_stock_check_requests r
      where r.item_code = p_row.item_code
        and 'display' = any (r.sources)
        and r.check_date >= p_row.request_date
    ),
    'in_soldout', exists (
      select 1
      from public.warehouse_soldout_items so
      where so.item_code = p_row.item_code
        and so.soldout_date = p_row.request_date
    )
  );
end;
$$;

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
  select s.real_qty
    into v_stock_today
  from public.stock_current s
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
  ) || jsonb_build_object(
    'review_status', p_row.review_status,
    'review_note', p_row.review_note,
    'reviewed_at', p_row.reviewed_at,
    'reviewed_by_name', p_row.reviewed_by_name,
    'playauto_status', p_row.playauto_status,
    'playauto_sent_at', p_row.playauto_sent_at,
    'playauto_message', p_row.playauto_message
  ) || jsonb_build_object(
    -- 진열보충 요청 · 재고실사 기록 때 비교에 쓴 재고(2026-11-19 이후는 MOPS 장부 실재고, 그 전 값은 플레이오토 조회값)
    'live_stock', p_row.live_stock,
    'live_stock_at', p_row.live_stock_at
  );
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

  select s.real_qty
    into v_stock
  from public.stock_current s
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

  if v_source not in ('stock_check', 'display', 'review') then
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
  if v_date is null and p_source_id is not null and v_source <> 'review' then
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

  select s.real_qty
    into v_stock
  from public.stock_current s
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
    s.real_qty,
    'auto_low_stock',
    array['auto_low_stock']::text[],
    'pending',
    '자동'
  from public.stock_current s
  join public.items i on i.code = s.item_code
  left join public.sku_status ss on ss.sku_cd = i.code
  where s.real_qty is not null
    and (
      (
        not (coalesce(ss.stock_status, '') = '단종' or coalesce(ss.item_status, '') = '단종')
        and s.real_qty between 0 and 9
      )
      or (
        (coalesce(ss.stock_status, '') = '단종' or coalesce(ss.item_status, '') = '단종')
        and s.real_qty between 1 and 9
      )
    )
    and not exists (
      select 1
      from public.warehouse_stock_check_requests r
      where r.check_date = p_date
        and r.item_code = i.code
    )
    -- 최근 60일 안에 일치/불일치로 센 적이 있고, 그 뒤 재고가 10개 이상이 된 기록(daily_stock)이 없으면 건너뛴다.
    -- 60일이 지나면 다시 올린다(재고 기록이 비어 있어도 영원히 빠지지 않게).
    and not exists (
      select 1
      from public.warehouse_stock_check_requests c
      where c.item_code = i.code
        and c.status in ('match', 'mismatch')
        and c.check_date < p_date
        and c.check_date >= p_date - 60
        and not exists (
          select 1
          from public.daily_stock ds
          where ds.sku_cd = i.code
            and ds.stock_date > c.check_date
            and ds.stock_cnt_real >= 10
        )
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

create or replace function public.warehouse_review_stock_check(
  p_id uuid,
  p_decision text,
  p_note text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_decision text := lower(trim(coalesce(p_decision, '')));
  v_note text := left(trim(coalesce(p_note, '')), 500);
  v_actor_name text := trim(coalesce(p_actor_name, ''));
  v_row public.warehouse_stock_check_requests%rowtype;
  v_live_stock integer;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '실사반영 항목이 지정되지 않았습니다';
  end if;

  if v_decision not in ('applied', 'held', 'rejected', 'pending') then
    raise exception '판단 값이 올바르지 않습니다: %', v_decision;
  end if;

  select r.*
    into v_row
  from public.warehouse_stock_check_requests r
  where r.id = p_id
  for update;

  if not found then
    raise exception '실사반영 항목을 찾을 수 없습니다';
  end if;

  if v_row.status <> 'mismatch' then
    raise exception '불일치로 기록된 항목만 판단할 수 있습니다';
  end if;

  if v_decision = 'applied' and v_row.counted_qty is null then
    raise exception '실재고 수량이 없어 반영할 수 없습니다';
  end if;

  if v_row.playauto_status = 'sent' and v_decision <> 'applied' then
    raise exception '이미 MOPS 장부에 반영된 건은 되돌릴 수 없습니다';
  end if;

  select s.real_qty
    into v_live_stock
  from public.stock_current s
  where s.item_code = v_row.item_code;

  if v_decision in ('applied', 'rejected') then
    update public.warehouse_stock_check_requests r
    set review_status = v_decision,
        review_note = v_note,
        reviewed_at = now(),
        reviewed_by_user_id = p_actor_user_id,
        reviewed_by_name = v_actor_name,
        playauto_status = case
          when v_decision = 'applied' and r.playauto_status = 'sent' then 'sent'
          when v_decision = 'applied' then 'pending'
          else ''
        end,
        playauto_sent_at = case when v_decision = 'applied' then r.playauto_sent_at else null end,
        playauto_message = case when v_decision = 'applied' then r.playauto_message else '' end,
        resolved = true,
        resolved_note = v_note,
        resolved_at = now(),
        resolved_by_user_id = p_actor_user_id,
        resolved_by_name = v_actor_name
    where r.id = p_id;
  else
    update public.warehouse_stock_check_requests r
    set review_status = case when v_decision = 'held' then 'held' else '' end,
        review_note = case when v_decision = 'held' then v_note else '' end,
        reviewed_at = case when v_decision = 'held' then now() else null end,
        reviewed_by_user_id = case when v_decision = 'held' then p_actor_user_id else null end,
        reviewed_by_name = case when v_decision = 'held' then v_actor_name else '' end,
        playauto_status = '',
        playauto_sent_at = null,
        playauto_message = '',
        resolved = false,
        resolved_note = '',
        resolved_at = null,
        resolved_by_user_id = null,
        resolved_by_name = ''
    where r.id = p_id;
  end if;

  perform public.warehouse_log_action(
    'stock_check_review',
    'stock_check',
    p_id::text,
    v_row.check_date,
    v_row.item_code,
    jsonb_build_object(
      'decision', v_decision,
      'previous', v_row.review_status,
      'db_stock', coalesce(v_live_stock, v_row.db_stock),
      'counted_qty', v_row.counted_qty,
      'note', v_note
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

-- 2) 재고실사 기록: p_live_stock 이 비어 있으면 일치/불일치 기록 때 MOPS 장부 실재고와 비교하고 live_stock 으로 남긴다.

create or replace function public.warehouse_record_stock_check(
  p_id uuid,
  p_result text,
  p_counted_qty integer default null,
  p_reason text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default '',
  p_live_stock integer default null
)
returns jsonb
language plpgsql
as $$
declare
  v_result text := lower(trim(coalesce(p_result, '')));
  v_reason text := left(trim(coalesce(p_reason, '')), 500);
  v_row public.warehouse_stock_check_requests%rowtype;
  v_live_stock integer;
  v_cmp_stock integer := p_live_stock;
  v_db_stock integer;
  v_counted integer;
  v_qty integer := p_counted_qty;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '재고실사 항목이 지정되지 않았습니다';
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
    raise exception '재고실사 항목을 찾을 수 없습니다';
  end if;

  select s.real_qty
    into v_live_stock
  from public.stock_current s
  where s.item_code = v_row.item_code;

  v_db_stock := coalesce(v_live_stock, v_row.db_stock);

  -- 비교 기준 재고를 따로 받지 않았으면(p_live_stock = null) 일치/불일치 기록 때 MOPS 장부 실재고를 쓴다
  -- (장부에 행이 없는 상품은 비워 둔다 = 비교하지 않음).
  if v_cmp_stock is null and v_result in ('match', 'mismatch') then
    v_cmp_stock := v_live_stock;
  end if;

  -- 비교 기준 재고(MOPS 장부)가 있으면 센 수량을 그 값과 비교해 일치/불일치를 정한다.
  --   일치 버튼 = 화면의 총 재고만큼 있었다는 뜻, 불일치 버튼 = 입력한 수량만큼 있었다는 뜻.
  if v_result in ('match', 'mismatch') and v_cmp_stock is not null then
    if v_result = 'match' then
      v_qty := coalesce(p_counted_qty, v_db_stock);
    end if;
    if v_qty is not null then
      if v_qty = v_cmp_stock then
        v_result := 'match';
        v_reason := '';
      else
        v_result := 'mismatch';
        if v_reason = '' then
          v_reason := format('MOPS 장부 재고 %s개와 다름', v_cmp_stock);
        end if;
      end if;
    end if;
  end if;

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
    v_counted := coalesce(v_qty, v_db_stock);
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
    if v_qty is null then
      raise exception '실제 수량을 입력하세요';
    end if;
    if v_qty < 0 then
      raise exception '실제 수량은 0 이상이어야 합니다';
    end if;

    v_counted := v_qty;

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

  -- 비교에 쓴 MOPS 장부 재고(없으면 비움)
  if v_result <> 'pending' then
    update public.warehouse_stock_check_requests r
    set live_stock = v_cmp_stock,
        live_stock_at = case when v_cmp_stock is null then null else now() end
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
      'live_stock', v_cmp_stock,
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

-- 2) 재고실사 요청: 진열보충('display') 요청이고 p_live_stock 이 비어 있으면 MOPS 장부 실재고를 live_stock 으로 남긴다.

create or replace function public.warehouse_request_stock_check(
  p_item_code text,
  p_source text default 'item',
  p_note text default '',
  p_date date default null,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default '',
  p_live_stock integer default null
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
  v_live integer := p_live_stock;
  v_saved_live integer;
  v_id uuid;
  v_created boolean;
begin
  if v_code = '' then
    raise exception '상품코드가 필요합니다';
  end if;

  if v_source not in ('item', 'irregular', 'display') then
    raise exception '요청 출처가 올바르지 않습니다: %', v_source;
  end if;

  select i.name, i.location_code
    into v_name, v_location
  from public.items i
  where i.code = v_code;

  if not found then
    raise exception '상품을 찾을 수 없습니다: %', v_code;
  end if;

  select s.real_qty
    into v_stock
  from public.stock_current s
  where s.item_code = v_code;

  -- 진열보충에서 온 요청은 비교 기준 재고를 따로 받지 않았으면(p_live_stock = null) MOPS 장부 실재고를 남긴다
  -- (장부에 행이 없는 상품은 비워 둔다).
  if v_live is null and v_source = 'display' then
    v_live := v_stock;
  end if;

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
    requested_by_name,
    live_stock,
    live_stock_at
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
    trim(coalesce(p_actor_name, '')),
    v_live,
    case when v_live is null then null else now() end
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
    end,
    live_stock = coalesce(excluded.live_stock, t.live_stock),
    live_stock_at = case when excluded.live_stock is null then t.live_stock_at else excluded.live_stock_at end
  returning t.id, (t.xmax = 0), t.live_stock
    into v_id, v_created, v_saved_live;

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

  -- live_stock: 이번 요청 뒤 이 줄에 저장된 비교 기준 재고(없으면 null). 화면(진열보충)이 읽는다.
  return jsonb_build_object('ok', true, 'id', v_id, 'created', coalesce(v_created, false), 'live_stock', v_saved_live);
end;
$$;

-- 3) · 4)
-- 판단 지우기 트리거 함수: 사용자에게 보이는 문구만 MOPS 장부 문구로 바꾼다(트리거는 그대로 이 함수를 부른다).
create or replace function public.warehouse_stock_check_clear_review()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'mismatch'
     or new.counted_qty is distinct from old.counted_qty
     or (old.resolved and not new.resolved and new.review_status in ('applied', 'rejected')) then
    if old.playauto_status = 'sent' then
      raise exception '이미 MOPS 장부에 반영된 건은 되돌릴 수 없습니다';
    end if;
    new.review_status := '';
    new.review_note := '';
    new.reviewed_at := null;
    new.reviewed_by_user_id := null;
    new.reviewed_by_name := '';
    new.playauto_status := '';
    new.playauto_sent_at := null;
    new.playauto_message := '';
  end if;
  return new;
end;
$$;

-- 실사반영 결과 기록: 사용자에게 보이는 문구만 'MOPS 장부 반영 결과'로 바꾼다(나머지는 그대로).
create or replace function public.warehouse_set_stock_check_playauto(
  p_id uuid,
  p_status text,
  p_message text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_status text := lower(trim(coalesce(p_status, '')));
  v_message text := left(trim(coalesce(p_message, '')), 500);
  v_row public.warehouse_stock_check_requests%rowtype;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '실사반영 항목이 지정되지 않았습니다';
  end if;

  if v_status not in ('sent', 'failed', 'pending') then
    raise exception '전송 상태가 올바르지 않습니다: %', v_status;
  end if;

  select r.*
    into v_row
  from public.warehouse_stock_check_requests r
  where r.id = p_id
  for update;

  if not found then
    raise exception '실사반영 항목을 찾을 수 없습니다';
  end if;

  if v_row.review_status <> 'applied' then
    raise exception '반영으로 판단한 항목만 MOPS 장부 반영 결과를 기록할 수 있습니다';
  end if;

  update public.warehouse_stock_check_requests r
  set playauto_status = v_status,
      playauto_sent_at = case when v_status = 'sent' then now() else r.playauto_sent_at end,
      playauto_message = v_message
  where r.id = p_id;

  perform public.warehouse_log_action(
    'stock_check_playauto',
    'stock_check',
    p_id::text,
    v_row.check_date,
    v_row.item_code,
    jsonb_build_object(
      'status', v_status,
      'counted_qty', v_row.counted_qty,
      'message', v_message
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

-- 실사반영(반영으로 판단한 건)을 MOPS 장부 실재고에 맞춘다. 플레이오토 전송을 대신한다.
--   * 비교 기준(base) = 실사 시점의 장부 실재고. 실사 뒤 판매·입고로 바뀐 만큼은 그대로 남긴다.
--     (a) 이 줄의 live_stock 이 재고 기준을 MOPS 로 바꾼 뒤(app_settings 'stock.authority.since') 기록된 값이면 그 값.
--     (b) 아니면 장부 이력(stock_ledger)에서 실사 시각(checked_at) 당시의 실재고(real_after).
--         전환 전 장부도 플레이오토를 10분마다 따라 쓴 기록이라 실사 시점 기준값으로 쓸 수 있다.
--     (c) 둘 다 없으면 비움(=지금 장부값 기준, 센 수량으로 맞춤).
--   * 같은 건을 두 번 보내도 장부에는 한 번만 반영된다(idem 키 'warenavi:count:<id>').
--   * 결과는 warehouse_set_stock_check_playauto 로 기록한다(기록 action 'stock_check_playauto', 응답 모양 그대로).
--     칸 이름(playauto_status 등)은 화면·서버와 맞추려고 그대로 둔다.
create or replace function public.warehouse_apply_count_to_mops(
  p_id uuid,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
-- 서버 권한(mops_api 스키마)과 상관없이 장부 창구를 부르도록 소유자 권한으로 실행한다.
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.warehouse_stock_check_requests%rowtype;
  v_since timestamptz;
  v_base integer;
  v_res jsonb;
  v_status text;
  v_message text;
begin
  if p_id is null then
    raise exception '실사반영 항목이 지정되지 않았습니다';
  end if;

  select r.*
    into v_row
  from public.warehouse_stock_check_requests r
  where r.id = p_id
  for update;

  if not found then
    raise exception '실사반영 항목을 찾을 수 없습니다';
  end if;

  if v_row.review_status <> 'applied' then
    raise exception '반영으로 판단한 항목만 MOPS 장부에 반영할 수 있습니다';
  end if;

  if v_row.playauto_status = 'sent' then
    raise exception '이미 MOPS 장부에 반영된 건입니다';
  end if;

  if v_row.counted_qty is null then
    raise exception '실재고 수량이 없어 반영할 수 없습니다';
  end if;

  -- 재고 기준을 MOPS 로 바꾼 시각(없거나 읽을 수 없으면 비움 → base 도 비움)
  begin
    select nullif(trim(s.value), '')::timestamptz
      into v_since
    from public.app_settings s
    where s.key = 'stock.authority.since';
  exception when others then
    v_since := null;
  end;

  -- (a) 전환 뒤 기록된 live_stock
  if v_row.live_stock is not null
     and v_since is not null
     and v_row.live_stock_at >= v_since then
    v_base := v_row.live_stock;
  else
    v_base := null;
  end if;

  -- (b) 장부 이력에서 실사 시각 당시 실재고(실사 시각이 없거나 그 전 이력이 없으면 비움)
  if v_base is null and v_row.checked_at is not null then
    select l.real_after
      into v_base
    from public.stock_ledger l
    where l.item_code = v_row.item_code
      and l.created_at <= v_row.checked_at
    order by l.created_at desc, l.id desc
    limit 1;
  end if;

  begin
    v_res := mops_api.stock_count(
      v_row.item_code,
      v_row.counted_qty,
      v_base,
      'warenavi',
      p_id::text,
      '창고네비 실사반영',
      p_actor_name,
      'warenavi:count:' || p_id::text,
      true
    );

    if v_res->>'ok' = 'true' and v_res->>'applied' = 'true' then
      v_status := 'sent';
      v_message := format('MOPS 장부 실재고 %s → %s', v_res->>'before', v_res->>'after')
        || case when v_base is not null then ' (실사 뒤 변동 유지)'
                else ' (실사 시점 기준 없음: 센 수량으로 맞춤)' end;
    elsif v_res->>'ok' = 'true' and v_res->>'reason' = 'already' then
      v_status := 'sent';
      v_message := '이미 MOPS 장부에 반영된 건입니다';
    elsif v_res->>'reason' = 'nochange' then
      v_status := 'sent';
      v_message := format('MOPS 장부 실재고가 이미 %s개입니다', v_res->>'real');
    elsif v_res->>'reason' = 'short' then
      v_status := 'failed';
      -- 원인별 문구: 출고대기 보호에 걸림 / 실재고가 0 또는 판매불가보다 적어짐
      -- (real_after = real + (counted - coalesce(base, real)), stock_count 가 계산해 돌려준 값)
      if coalesce((v_res->>'pending')::integer, 0) > 0
         and (v_res->>'real_after')::integer - (v_res->>'notsale')::integer < (v_res->>'pending')::integer then
        v_message := format('출고대기 %s개보다 적게 맞출 수 없습니다 (장부 실재고 %s)', v_res->>'pending', v_res->>'real');
      else
        v_message := format('장부 실재고가 0 또는 판매불가 수량보다 적어지게 됩니다 (장부 실재고 %s, 판매불가 %s, 계산 결과 %s) · 다시 세어 주세요',
                            v_res->>'real', v_res->>'notsale', v_res->>'real_after');
      end if;
    else
      -- 예상하지 못한 응답은 실패로 남기고 응답을 그대로 보여 준다
      v_status := 'failed';
      v_message := 'MOPS 장부 응답을 알 수 없습니다: ' || coalesce(v_res::text, '(없음)');
    end if;
  exception when others then
    -- 재고 기준이 플레이오토로 돌아갔거나 상품이 없을 때 등. 장부 쪽 변경은 이 블록에서 모두 취소된다.
    v_status := 'failed';
    v_message := sqlerrm;
  end;

  return public.warehouse_set_stock_check_playauto(
    p_id,
    v_status,
    v_message,
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );
end;
$$;

-- 소유자 권한 함수라 아무나 /rpc 로 장부를 바꾸지 못하게 서버(service_role)만 부를 수 있게 한다.
revoke all on function public.warehouse_apply_count_to_mops(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.warehouse_apply_count_to_mops(uuid, uuid, text, text) to service_role;

-- 사무실 PC 전송기(tools/playauto_worker.py)는 은퇴했다(재고 기준이 MOPS 장부로 바뀜, 2026-11-19).
-- 전송기가 아직 돌고 있어도 플레이오토로 아무것도 보내지 않도록 대기 목록을 항상 비워서 돌려준다.
-- 표·칸·다른 함수는 지우지 않는다(되돌릴 수 있게).
create or replace function public.warehouse_playauto_queue(p_limit integer default 20)
returns jsonb
language sql
stable
as $$
  select '[]'::jsonb;
$$;
