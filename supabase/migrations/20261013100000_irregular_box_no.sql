-- 이형포장 박스 번호(box_no): 포장한 박스에 적는 번호라 한 번 붙으면 바뀌지 않는다.
--   · 하루(work_date) 안에서 1부터 이어 붙인다. 오전·오후에 주문을 두 번 수집해도 겹치지 않고 누적된다.
--   · 번호가 없는 묶음끼리는 첫 상품 로케이션의 숫자 순(앞 글자 무시)으로 줄 세워 붙인다.
--   · 목록도 이 번호 순으로 내려준다.

alter table public.warehouse_irregular_bundles
  add column if not exists box_no integer;

create unique index if not exists warehouse_irregular_bundles_box_no_uidx
  on public.warehouse_irregular_bundles (work_date, box_no)
  where box_no is not null;

-- 로케이션 정렬 키: 글자는 버리고 숫자 묶음만 4자리씩 이어 붙인다. 'A-03-04-07(1)' → '0003000400070001'
-- 위치 미지정('' · '00')이나 숫자가 없는 값은 null(맨 뒤).
create or replace function public.warehouse_location_sort_key(p_location text)
returns text
language sql
immutable
as $$
  select case
    when trim(coalesce(p_location, '')) in ('', '00') then null
    else (
      select string_agg(lpad(m[1], 4, '0'), '' order by ord)
      from regexp_matches(p_location, '([0-9]+)', 'g') with ordinality as t(m, ord)
    )
  end
$$;

-- 그 날짜의 번호 없는 묶음에 번호를 붙인다(이미 붙은 번호는 건드리지 않는다).
create or replace function public.warehouse_assign_irregular_box_no(p_date date)
returns integer
language plpgsql
as $$
declare
  v_max integer;
  v_count integer := 0;
begin
  if p_date is null then
    return 0;
  end if;

  if not exists (
    select 1
    from public.warehouse_irregular_bundles b
    where b.work_date = p_date
      and b.box_no is null
  ) then
    return 0;
  end if;

  -- 같은 날짜에 동시에 두 번 붙이지 않도록 잠근다.
  perform pg_advisory_xact_lock(hashtextextended('warehouse_irregular_box_no:' || to_char(p_date, 'YYYY-MM-DD'), 0));

  select coalesce(max(b.box_no), 0)
    into v_max
  from public.warehouse_irregular_bundles b
  where b.work_date = p_date;

  with todo as (
    select
      b.id,
      row_number() over (
        order by k.sort_key asc nulls last, b.batch_key asc, b.bundle_no asc
      ) as rn
    from public.warehouse_irregular_bundles b
    left join lateral (
      select min(public.warehouse_location_sort_key(x.location_code)) as sort_key
      from public.warehouse_irregular_bundle_items x
      where x.bundle_id = b.id
    ) k on true
    where b.work_date = p_date
      and b.box_no is null
  )
  update public.warehouse_irregular_bundles b
  set box_no = v_max + todo.rn
  from todo
  where b.id = todo.id
    and b.box_no is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- IRREGULAR 묶음 모양 (box_no 추가, 묶음 안 상품도 로케이션 숫자 순)
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
          'stock_today', s.stock_today,
          'racks', public.warehouse_item_racks(x.item_code),
          'open_requests', public.warehouse_item_open_requests(x.item_code, p_row.work_date, v_today)
        )
        order by public.warehouse_location_sort_key(x.location_code) asc nulls last, x.location_code asc, x.item_code asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_irregular_bundle_items x
  left join public.item_stocks s on s.item_code = x.item_code
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

-- 목록을 내려주기 전에 번호 없는 묶음(방금 MOPS가 저장한 것)에 번호를 붙인다. 그래서 stable 이 아니다.
create or replace function public.warehouse_get_irregular_list(p_date date default null)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_bundles jsonb;
begin
  perform public.warehouse_assign_irregular_box_no(v_date);

  select coalesce(
      jsonb_agg(
        public.warehouse_irregular_bundle_json(b)
        order by b.box_no asc nulls last, b.batch_key asc, b.bundle_no asc
      ),
      '[]'::jsonb
    )
    into v_bundles
  from public.warehouse_irregular_bundles b
  where b.work_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'bundles', coalesce(v_bundles, '[]'::jsonb));
end;
$$;
