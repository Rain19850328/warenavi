-- 확인요청: 재고확인에서 불일치로 기록된 건을 관리자가 반영 / 보류 / 미반영으로 판단한다.
-- 반영한 건은 플레이오토로 보내야 하므로 전송 상태를 함께 둔다(전송 자체는 이 파일에 없다).
-- 총 재고(item_stocks)는 여기서 바꾸지 않는다.

alter table public.warehouse_stock_check_requests
  add column if not exists review_status text not null default '',
  add column if not exists review_note text not null default '',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by_user_id uuid,
  add column if not exists reviewed_by_name text not null default '',
  add column if not exists playauto_status text not null default '',
  add column if not exists playauto_sent_at timestamptz,
  add column if not exists playauto_message text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'warehouse_stock_check_requests_review_status_check'
  ) then
    alter table public.warehouse_stock_check_requests
      add constraint warehouse_stock_check_requests_review_status_check
      check (review_status in ('', 'applied', 'held', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'warehouse_stock_check_requests_playauto_status_check'
  ) then
    alter table public.warehouse_stock_check_requests
      add constraint warehouse_stock_check_requests_playauto_status_check
      check (playauto_status in ('', 'pending', 'sent', 'failed'));
  end if;
end;
$$;

create index if not exists warehouse_stock_check_requests_reviewed_idx
  on public.warehouse_stock_check_requests (reviewed_at desc)
  where review_status in ('applied', 'rejected');

-- 판단의 근거가 바뀌면 판단을 지운다:
-- 불일치가 아니게 됐거나, 실재고 수량을 고쳤거나, 재고확인에서 처리취소를 누른 경우.
create or replace function public.warehouse_stock_check_clear_review()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'mismatch'
     or new.counted_qty is distinct from old.counted_qty
     or (old.resolved and not new.resolved and new.review_status in ('applied', 'rejected')) then
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

drop trigger if exists warehouse_stock_check_requests_clear_review on public.warehouse_stock_check_requests;
create trigger warehouse_stock_check_requests_clear_review
before update on public.warehouse_stock_check_requests
for each row
execute function public.warehouse_stock_check_clear_review();

-- CHECK 모양 (판단 · 플레이오토 전송 상태 추가)
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
  );
end;
$$;

-- 확인요청 목록. p_scope = 'open'(판단 전 + 보류) | 'done'(반영 · 미반영, 최근 200건)
create or replace function public.warehouse_get_stock_review_list(p_scope text default 'open')
returns jsonb
language plpgsql
stable
as $$
declare
  v_scope text := lower(trim(coalesce(p_scope, 'open')));
  v_items jsonb;
begin
  if v_scope = 'done' then
    select coalesce(
        jsonb_agg(public.warehouse_stock_check_row_json(t.req) order by t.reviewed_at desc),
        '[]'::jsonb
      )
      into v_items
    from (
      select r as req, r.reviewed_at
      from public.warehouse_stock_check_requests r
      where r.status = 'mismatch'
        and r.review_status in ('applied', 'rejected')
      order by r.reviewed_at desc
      limit 200
    ) t;
  else
    v_scope := 'open';

    select coalesce(
        jsonb_agg(
          public.warehouse_stock_check_row_json(r)
          order by r.check_date asc, r.location_code asc, r.item_code asc, r.created_at asc
        ),
        '[]'::jsonb
      )
      into v_items
    from public.warehouse_stock_check_requests r
    where r.status = 'mismatch'
      and not r.resolved
      and r.review_status in ('', 'held');
  end if;

  return jsonb_build_object('scope', v_scope, 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;

-- 판단 기록. p_decision = 'applied'(반영) | 'held'(보류) | 'rejected'(미반영) | 'pending'(판단 취소)
-- 반영 · 미반영은 불일치를 처리완료로 닫는다. 보류 · 판단 취소는 미처리로 둔다.
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
    raise exception '확인요청 항목이 지정되지 않았습니다';
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
    raise exception '확인요청 항목을 찾을 수 없습니다';
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

-- 탭 뱃지 건수 (확인요청: 아직 판단하지 않은 불일치 건수 추가)
create or replace function public.warehouse_get_tab_counts(p_date date default null)
returns jsonb
language plpgsql
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_pending integer := 0;
  v_mismatch integer := 0;
  v_review integer := 0;
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
    into v_review
  from public.warehouse_stock_check_requests r
  where r.status = 'mismatch'
    and not r.resolved
    and r.review_status = '';

  select count(*)
    into v_display
  from public.warehouse_display_requests d
  where d.request_date = v_date
    and d.status = 'open';

  select count(*)
    into v_irregular
  from public.warehouse_irregular_bundles b
  where b.work_date = v_date
    and b.status <> '포장완료'
    and not b.stale;

  select count(*)
    into v_soldout
  from public.warehouse_soldout_items so
  where so.soldout_date = v_date;

  return jsonb_build_object(
    'stock_check_pending', v_pending,
    'mismatch_open', v_mismatch,
    'review_open', v_review,
    'display_open', v_display,
    'irregular_open', v_irregular,
    'soldout', v_soldout
  );
end;
$$;

-- 재고확인 한 건(플레이오토로 보낼 상품코드 · 실재고를 서버가 읽는다)
create or replace function public.warehouse_get_stock_check_item(p_id uuid)
returns jsonb
language sql
stable
as $$
  select public.warehouse_stock_check_row_json(r)
  from public.warehouse_stock_check_requests r
  where r.id = p_id;
$$;

-- 플레이오토 전송 결과 기록. p_status = 'sent' | 'failed' | 'pending'(아직 못 보냄)
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
    raise exception '확인요청 항목이 지정되지 않았습니다';
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
    raise exception '확인요청 항목을 찾을 수 없습니다';
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
