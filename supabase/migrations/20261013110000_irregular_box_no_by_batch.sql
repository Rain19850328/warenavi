-- 이형포장 박스 번호를 수집 회차(주문서, batch_key) 순서대로 잇는다.
--   첫 회차가 1~20이면 다음 회차는 21부터. 두 회차가 한꺼번에 번호를 받더라도 섞이지 않는다.
--   회차 순서 = 그 회차 묶음이 처음 저장된 시각 순. 회차 안에서는 첫 상품 로케이션의 숫자 순.
--   이미 붙은 번호는 건드리지 않는다.
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

  with batch_order as (
    select o.batch_key, min(o.created_at) as first_seen
    from public.warehouse_irregular_bundles o
    where o.work_date = p_date
    group by o.batch_key
  ),
  todo as (
    select
      b.id,
      row_number() over (
        order by bo.first_seen asc, b.batch_key asc, k.sort_key asc nulls last, b.bundle_no asc
      ) as rn
    from public.warehouse_irregular_bundles b
    join batch_order bo on bo.batch_key = b.batch_key
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
