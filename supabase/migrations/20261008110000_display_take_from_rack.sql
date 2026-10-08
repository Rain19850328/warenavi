-- 진열보충: 완료할 때 가져온 스토리지렉 위치와 수량을 받아 그 위치 재고를 차감한다.
-- 되돌리면 차감했던 수량을 같은 위치에 다시 넣는다.

alter table public.warehouse_display_requests
  add column if not exists taken_rack_code text not null default '',
  add column if not exists taken_qty integer check (taken_qty is null or taken_qty > 0);

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
    'in_soldout', exists (
      select 1
      from public.warehouse_soldout_items so
      where so.item_code = p_row.item_code
        and so.soldout_date = p_row.request_date
    )
  );
end;
$$;

-- 인자가 늘어 기존 시그니처와 겹치지 않도록 지우고 다시 만든다.
drop function if exists public.warehouse_set_display_request_status(uuid, text, uuid, text, text);

-- p_rack_code / p_qty: 완료(done)일 때만 쓴다. 비우면 재고 차감 없이 완료.
create or replace function public.warehouse_set_display_request_status(
  p_id uuid,
  p_status text,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default '',
  p_rack_code text default null,
  p_qty integer default null
)
returns jsonb
language plpgsql
as $$
declare
  v_status text := lower(trim(coalesce(p_status, '')));
  v_row public.warehouse_display_requests%rowtype;
  v_rack text := nullif(trim(coalesce(p_rack_code, '')), '');
  v_current integer;
  v_detail jsonb := '{}'::jsonb;
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
      if v_rack is not null then
        v_rack := public.warehouse_to_canonical_code(v_rack);

        if coalesce(p_qty, 0) <= 0 then
          raise exception '가져올 수량을 1 이상으로 입력하세요';
        end if;

        select coalesce(sum(wr.quantity), 0)::integer
          into v_current
        from public.warehouse_racks wr
        where wr.rack_code = v_rack
          and wr.item_code = v_row.item_code;

        if v_current < p_qty then
          raise exception '% 위치의 재고가 부족합니다 (현재 %개)', v_rack, v_current;
        end if;

        perform public.warehouse_post_outbound(
          v_rack, v_row.item_code, p_qty, p_actor_user_id, p_actor_email, p_actor_name
        );
        v_detail := jsonb_build_object('rack_code', v_rack, 'qty', p_qty);
      end if;

      update public.warehouse_display_requests d
      set status = 'done',
          done_at = now(),
          done_by_user_id = p_actor_user_id,
          done_by_name = trim(coalesce(p_actor_name, '')),
          taken_rack_code = coalesce(v_rack, ''),
          taken_qty = case when v_rack is not null then p_qty else null end
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

      -- 완료 때 차감했던 재고를 같은 위치에 되돌린다.
      if v_row.taken_rack_code <> '' and coalesce(v_row.taken_qty, 0) > 0 then
        perform public.warehouse_post_inbound(
          v_row.taken_rack_code, v_row.item_code, v_row.taken_qty,
          p_actor_user_id, p_actor_email, p_actor_name, '진열 완료 취소'
        );
        v_detail := jsonb_build_object('rack_code', v_row.taken_rack_code, 'qty', v_row.taken_qty);
      end if;

      update public.warehouse_display_requests d
      set status = 'open',
          done_at = null,
          done_by_user_id = null,
          done_by_name = '',
          taken_rack_code = '',
          taken_qty = null
      where d.id = p_id;
    end if;

    perform public.warehouse_log_action(
      case when v_status = 'done' then 'display_done' else 'display_reopen' end,
      'display',
      p_id::text,
      v_row.request_date,
      v_row.item_code,
      v_detail,
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
