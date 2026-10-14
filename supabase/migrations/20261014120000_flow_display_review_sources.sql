-- 업무 흐름: 진열보충 → 재고실사 → (불일치) 실사반영 → (10개 미만) 품절처리
--   1) 진열보충 탭에서 '재고실사 요청'으로 상품을 재고실사(오늘)에 올린다: 출처 'display' 허용.
--   2) 실사반영 탭에서 '반영'한 실재고가 10개 미만이면 품절처리에 자동으로 올린다: 출처 'review' 허용.
--      이때 품절처리 날짜는 반영한 날(오늘)이다.

alter table public.warehouse_stock_check_requests
  drop constraint if exists warehouse_stock_check_requests_source_check;
alter table public.warehouse_stock_check_requests
  add constraint warehouse_stock_check_requests_source_check
  check (source in ('auto_low_stock', 'item', 'irregular', 'display'));

alter table public.warehouse_soldout_items
  drop constraint if exists warehouse_soldout_items_source_check;
alter table public.warehouse_soldout_items
  add constraint warehouse_soldout_items_source_check
  check (source in ('stock_check', 'display', 'review'));

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
