-- 플레이오토 현재 재고를 필요할 때 1건씩 조회해 쓴다(진열보충의 재고실사 요청, 재고실사의 일치/불일치).
--   * 조회한 값과 시각을 재고실사 줄에 저장한다. 실사반영 · 품절처리는 이 저장값을 쓴다(추가 조회 없음).
--   * 플레이오토 호출 횟수를 하루(오전 9시 초기화) 단위로 센다. 하루 한도는 12,000회이고 이 앱은 일부만 쓴다.

alter table public.warehouse_stock_check_requests
  add column if not exists live_stock integer,
  add column if not exists live_stock_at timestamptz;

create table if not exists public.warehouse_playauto_usage (
  usage_day date primary key,
  calls integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.warehouse_playauto_usage enable row level security;

-- 플레이오토의 하루는 한국 시각 오전 9시에 바뀐다.
create or replace function public.warehouse_playauto_usage_day()
returns date
language sql
stable
as $$
  select ((now() at time zone 'Asia/Seoul') - interval '9 hours')::date;
$$;

-- 호출 p_calls 번을 기록한다. p_limit 이 있으면 넘길 때 기록하지 않고 ok=false.
create or replace function public.warehouse_playauto_take(p_calls integer default 1, p_limit integer default null)
returns jsonb
language plpgsql
as $$
declare
  v_day date := public.warehouse_playauto_usage_day();
  v_calls integer;
begin
  insert into public.warehouse_playauto_usage as u (usage_day, calls)
  values (v_day, 0)
  on conflict (usage_day) do nothing;

  select u.calls into v_calls
  from public.warehouse_playauto_usage u
  where u.usage_day = v_day
  for update;

  if p_limit is not null and v_calls + coalesce(p_calls, 1) > p_limit then
    return jsonb_build_object('ok', false, 'calls', v_calls, 'limit', p_limit);
  end if;

  update public.warehouse_playauto_usage u
  set calls = u.calls + coalesce(p_calls, 1),
      updated_at = now()
  where u.usage_day = v_day
  returning u.calls into v_calls;

  return jsonb_build_object('ok', true, 'calls', v_calls, 'limit', p_limit);
end;
$$;

create or replace function public.warehouse_playauto_usage()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'day', to_char(public.warehouse_playauto_usage_day(), 'YYYY-MM-DD'),
    'calls', coalesce((select u.calls from public.warehouse_playauto_usage u
                       where u.usage_day = public.warehouse_playauto_usage_day()), 0)
  );
$$;

-- 인자가 늘어서 예전 모양은 지우고 다시 만든다(같은 이름이 둘이면 호출이 모호해진다).
drop function if exists public.warehouse_record_stock_check(uuid, text, integer, text, uuid, text, text);
drop function if exists public.warehouse_request_stock_check(text, text, text, date, uuid, text, text);

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
  ) || jsonb_build_object(
    'review_status', p_row.review_status,
    'review_note', p_row.review_note,
    'reviewed_at', p_row.reviewed_at,
    'reviewed_by_name', p_row.reviewed_by_name,
    'playauto_status', p_row.playauto_status,
    'playauto_sent_at', p_row.playauto_sent_at,
    'playauto_message', p_row.playauto_message
  ) || jsonb_build_object(
    -- 진열보충 요청 · 재고실사 기록 때 조회한 플레이오토 재고(없으면 하루 한 번 숫자로 비교한 것)
    'live_stock', p_row.live_stock,
    'live_stock_at', p_row.live_stock_at
  );
end;
$$;

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

  select s.stock_today
    into v_live_stock
  from public.item_stocks s
  where s.item_code = v_row.item_code;

  v_db_stock := coalesce(v_live_stock, v_row.db_stock);

  -- 플레이오토 현재 재고를 받았으면 센 수량을 그 값과 비교해 일치/불일치를 정한다
  -- (하루 한 번 바뀌는 총 재고는 그날 팔린 만큼 차이가 나기 때문).
  --   일치 버튼 = 화면의 총 재고만큼 있었다는 뜻, 불일치 버튼 = 입력한 수량만큼 있었다는 뜻.
  if v_result in ('match', 'mismatch') and p_live_stock is not null then
    if v_result = 'match' then
      v_qty := coalesce(p_counted_qty, v_db_stock);
    end if;
    if v_qty is not null then
      if v_qty = p_live_stock then
        v_result := 'match';
        v_reason := '';
      else
        v_result := 'mismatch';
        if v_reason = '' then
          v_reason := format('플레이오토 재고 %s개와 다름', p_live_stock);
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

  -- 비교에 쓴 플레이오토 재고(못 받았으면 비움)
  if v_result <> 'pending' then
    update public.warehouse_stock_check_requests r
    set live_stock = p_live_stock,
        live_stock_at = case when p_live_stock is null then null else now() end
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
      'live_stock', p_live_stock,
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
    p_live_stock,
    case when p_live_stock is null then null else now() end
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
