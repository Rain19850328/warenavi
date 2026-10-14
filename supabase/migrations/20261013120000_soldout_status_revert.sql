-- 품절관리: 관리자가 줄마다 완료 / 보류 / 미반영으로 판단한다(확인요청 탭과 같은 배치).
--   판단은 표시만 남긴다. 재고상태(sku_status)는 여기서 바꾸지 않는다.
--   완료·미반영은 판단을 마친 것이고, 보류는 아직 판단 전으로 남는다.
-- 목록 줄에는 스토리지렉 위치별 수량(racks)도 함께 내려 준다.
alter table public.warehouse_soldout_items
  add column if not exists handled_as text not null default '',
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by_name text not null default '';

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

-- 판단 버튼: 완료 | 보류 | 미반영. 판단 표시만 남기고 재고상태는 건드리지 않는다.
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
    raise exception '품절관리 항목을 찾을 수 없습니다';
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

-- 판단 취소 / 보류 해제: 판단 표시만 지워 판단 전으로 되돌린다. 재고상태는 건드리지 않는다.
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
    raise exception '품절관리 항목을 찾을 수 없습니다';
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
