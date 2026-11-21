-- 옛 재고 전송 연동 부품 정리, 2026-11-20.
-- 재고 기준이 MOPS 장부로 바뀐 뒤(2026-11-19) 더 쓰지 않는 표·함수를 지우고,
-- 확인요청 표의 반영 결과 칸 이름을 mops_* 로 바꾼다. 화면에 보이는 동작은 그대로다.
--   1) 옛 전송 대기 목록·호출 수 기록 함수와 표를 지운다.
--   2) 사무실 PC 전송기만 쓰던 상태 기록 함수와 표를 지운다.
--   3) 칸 이름: 전송 상태 → mops_status, 전송 시각 → mops_applied_at, 전송 메시지 → mops_message.
--   4) 전송 상태 검사 제약 이름도 mops_status 에 맞춘다(허용 값은 그대로).
--   5) 그 칸을 쓰는 함수 다섯 개를 새 칸 이름으로 다시 만든다(동작·문구·권한은 그대로).
--      반영 결과 기록 함수는 warehouse_set_stock_check_mops 로 이름을 바꾸고, 기록 action 은 'stock_check_mops' 로 남긴다.
--   6) 옛 이름의 반영 결과 기록 함수를 지운다.
--   7) 옛 이름이 남아 있지 않은지 마지막에 확인한다.
-- 재고 표(stock_current · stock_ledger · item_stocks · daily_stock · sku_status)는 건드리지 않는다.

-- 1)
drop function if exists public.warehouse_playauto_queue(integer);
drop function if exists public.warehouse_playauto_usage();
drop function if exists public.warehouse_playauto_take(integer, integer);
drop function if exists public.warehouse_playauto_usage_day();
drop table if exists public.warehouse_playauto_usage;

-- 2)
drop function if exists public.warehouse_worker_ping(text, jsonb);
drop table if exists public.warehouse_worker_status;

-- 3)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'playauto_status'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'mops_status'
  ) then
    alter table public.warehouse_stock_check_requests rename column playauto_status to mops_status;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'playauto_sent_at'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'mops_applied_at'
  ) then
    alter table public.warehouse_stock_check_requests rename column playauto_sent_at to mops_applied_at;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'playauto_message'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_check_requests' and column_name = 'mops_message'
  ) then
    alter table public.warehouse_stock_check_requests rename column playauto_message to mops_message;
  end if;
end;
$$;

-- 4)
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'warehouse_stock_check_requests_playauto_status_check'
  ) and not exists (
    select 1 from pg_constraint
    where conname = 'warehouse_stock_check_requests_mops_status_check'
  ) then
    alter table public.warehouse_stock_check_requests
      rename constraint warehouse_stock_check_requests_playauto_status_check
      to warehouse_stock_check_requests_mops_status_check;
  end if;
end;
$$;

-- 5)
-- 확인요청 한 줄을 화면용 JSON 으로 만든다(반영 결과 키 이름만 mops_* 로 바뀜).
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
    'mops_status', p_row.mops_status,
    'mops_applied_at', p_row.mops_applied_at,
    'mops_message', p_row.mops_message
  ) || jsonb_build_object(
    -- 진열보충 요청 · 재고실사 기록 때 비교에 쓴 재고(2026-11-19 이후는 MOPS 장부 실재고, 그 전 값은 예전 외부 재고 조회값)
    'live_stock', p_row.live_stock,
    'live_stock_at', p_row.live_stock_at
  );
end;
$$;

-- 확인요청 판단(반영 / 보류 / 미반영).
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

  if v_row.mops_status = 'sent' and v_decision <> 'applied' then
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
        mops_status = case
          when v_decision = 'applied' and r.mops_status = 'sent' then 'sent'
          when v_decision = 'applied' then 'pending'
          else ''
        end,
        mops_applied_at = case when v_decision = 'applied' then r.mops_applied_at else null end,
        mops_message = case when v_decision = 'applied' then r.mops_message else '' end,
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
        mops_status = '',
        mops_applied_at = null,
        mops_message = '',
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

-- 판단 지우기 트리거 함수(트리거는 그대로 이 함수를 부른다).
create or replace function public.warehouse_stock_check_clear_review()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'mismatch'
     or new.counted_qty is distinct from old.counted_qty
     or (old.resolved and not new.resolved and new.review_status in ('applied', 'rejected')) then
    if old.mops_status = 'sent' then
      raise exception '이미 MOPS 장부에 반영된 건은 되돌릴 수 없습니다';
    end if;
    new.review_status := '';
    new.review_note := '';
    new.reviewed_at := null;
    new.reviewed_by_user_id := null;
    new.reviewed_by_name := '';
    new.mops_status := '';
    new.mops_applied_at := null;
    new.mops_message := '';
  end if;
  return new;
end;
$$;

-- 실사반영 결과 기록(옛 이름에서 바뀐 새 이름).
create or replace function public.warehouse_set_stock_check_mops(
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
  set mops_status = v_status,
      mops_applied_at = case when v_status = 'sent' then now() else r.mops_applied_at end,
      mops_message = v_message
  where r.id = p_id;

  perform public.warehouse_log_action(
    'stock_check_mops',
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

-- 실사반영(반영으로 판단한 건)을 MOPS 장부 실재고에 맞춘다. 결과는 warehouse_set_stock_check_mops 로 기록한다.
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

  if v_row.mops_status = 'sent' then
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
    -- 재고 기준이 MOPS 가 아니게 됐거나 상품이 없을 때 등. 장부 쪽 변경은 이 블록에서 모두 취소된다.
    v_status := 'failed';
    v_message := sqlerrm;
  end;

  return public.warehouse_set_stock_check_mops(
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

-- 6)
drop function if exists public.warehouse_set_stock_check_playauto(uuid, text, text, uuid, text, text);

-- 7)
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname ilike '%playauto%' or p.prosrc ilike '%playauto%')
  ) then
    raise exception 'public 함수에 옛 이름(playauto)이 남아 있습니다';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and column_name like 'playauto%'
  ) then
    raise exception 'public 표에 옛 칸 이름(playauto*)이 남아 있습니다';
  end if;

  if to_regclass('public.warehouse_playauto_usage') is not null then
    raise exception '옛 호출 수 기록 표가 남아 있습니다';
  end if;
end;
$$;
