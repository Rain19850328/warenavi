-- 업무 흐름 정리 2
--   1) 재고실사 자동 대상: 한 번 일치/불일치로 센 상품은 재고가 10개 이상으로 채워진 기록이 생기기 전까지 다시 올리지 않는다.
--   2) 진열보충 줄에 '재고실사 요청됨' 표시(stock_requested)를 내려 준다.
--   3) 오류 문구의 탭 이름을 새 이름(재고실사 · 실사반영 · 품절처리)으로 바꾼다. 동작은 그대로.

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

create or replace function public.warehouse_decide_soldout_item(
  p_soldout_id uuid,
  p_decision text,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_decision text := trim(coalesce(p_decision, ''));
  v_row public.warehouse_soldout_items;
begin
  if v_decision not in ('완료', '보류', '미반영') then
    raise exception '판단 값이 올바르지 않습니다: %', v_decision;
  end if;

  select so.*
    into v_row
  from public.warehouse_soldout_items so
  where so.id = p_soldout_id
  for update;

  if not found then
    raise exception '품절처리 항목을 찾을 수 없습니다';
  end if;

  update public.warehouse_soldout_items so
  set handled_as = v_decision,
      handled_at = now(),
      handled_by_name = trim(coalesce(p_actor_name, ''))
  where so.id = p_soldout_id;

  perform public.warehouse_log_action(
    'soldout_decide', 'soldout', p_soldout_id::text, v_row.soldout_date, v_row.item_code,
    jsonb_build_object('decision', v_decision, 'was', coalesce(v_row.handled_as, '')),
    'web', p_actor_user_id, p_actor_email, p_actor_name
  );

  return jsonb_build_object('ok', true, 'decision', v_decision);
end;
$$;

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
      raise exception '품절처리 항목을 찾을 수 없습니다';
    end if;
    if v_soldout_item <> v_code then
      raise exception '품절처리 항목과 상품코드가 일치하지 않습니다';
    end if;

    select ss.stock_status
      into v_current
    from public.sku_status ss
    where ss.sku_cd = v_code;

    if coalesce(trim(v_current), '') in ('주문완료', '단종') then
      raise exception '재고상태가 주문완료 또는 단종인 상품은 품절처리에서 변경할 수 없습니다';
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
    raise exception '품절처리 항목이 지정되지 않았습니다';
  end if;

  delete from public.warehouse_soldout_items so
  where so.id = p_id
  returning so.item_code, so.soldout_date, so.source
    into v_item_code, v_date, v_source;

  if not found then
    raise exception '품절처리 항목을 찾을 수 없습니다';
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
    raise exception '재고실사 항목이 지정되지 않았습니다';
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
    raise exception '재고실사 항목을 찾을 수 없습니다';
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

create or replace function public.warehouse_revert_soldout_status(
  p_soldout_id uuid,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_row public.warehouse_soldout_items;
begin
  select so.*
    into v_row
  from public.warehouse_soldout_items so
  where so.id = p_soldout_id
  for update;

  if not found then
    raise exception '품절처리 항목을 찾을 수 없습니다';
  end if;

  if coalesce(v_row.handled_as, '') = '' then
    raise exception '취소할 판단이 없습니다';
  end if;

  update public.warehouse_soldout_items so
  set handled_as = '',
      handled_at = null,
      handled_by_name = ''
  where so.id = p_soldout_id;

  perform public.warehouse_log_action(
    'soldout_decide', 'soldout', p_soldout_id::text, v_row.soldout_date, v_row.item_code,
    jsonb_build_object('decision', '', 'was', v_row.handled_as),
    'web', p_actor_user_id, p_actor_email, p_actor_name
  );

  return jsonb_build_object('ok', true, 'decision', '');
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
    raise exception '이미 플레이오토로 전송된 건은 되돌릴 수 없습니다';
  end if;

  select s.stock_today
    into v_live_stock
  from public.item_stocks s
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
    raise exception '반영으로 판단한 항목만 플레이오토 전송 결과를 기록할 수 있습니다';
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
