-- 이전 MOPS(상품별 집계, 묶음번호 없음)가 엑셀 출력을 하면 그날 묶음 목록이 지워지는 것을 막는다.
-- MOPS 전용(HTTP 경로 없음). p_items = [{bundle_no, item_code, item_name, location_code, qty}]
create or replace function public.warehouse_import_irregular_items(
  p_date date,
  p_batch_key text,
  p_items jsonb,
  p_actor_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_batch text := trim(coalesce(p_batch_key, ''));
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_bundle_nos text[] := '{}'::text[];
  v_unknown text[] := '{}'::text[];
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_stale integer := 0;
  v_lines integer := 0;
begin
  if p_date is null then
    raise exception '날짜가 필요합니다';
  end if;

  if jsonb_typeof(v_items) <> 'array' then
    raise exception '이형 목록 형식이 올바르지 않습니다';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('warehouse_irregular_import:' || to_char(p_date, 'YYYY-MM-DD') || ':' || v_batch, 0)
  );

  drop table if exists tmp_irregular_src;
  create temporary table tmp_irregular_src on commit drop as
  select
    trim(coalesce(e.bundle_no, '')) as bundle_no,
    trim(coalesce(e.item_code, '')) as code,
    max(trim(coalesce(e.item_name, ''))) as src_name,
    max(trim(coalesce(e.location_code, ''))) as src_location,
    coalesce(sum(round(coalesce(e.qty, 0))), 0)::integer as src_qty
  from jsonb_to_recordset(v_items) as e(
    bundle_no text,
    item_code text,
    item_name text,
    location_code text,
    qty numeric
  )
  where trim(coalesce(e.bundle_no, '')) <> ''
    and trim(coalesce(e.item_code, '')) <> ''
  group by 1, 2;

  select coalesce(array_agg(distinct s.bundle_no), '{}'::text[]), count(*)
    into v_bundle_nos, v_lines
  from tmp_irregular_src s;

  -- 묶음번호 없이 상품별로 보내던 이전 MOPS가 호출하면 목록이 통째로 비워지므로 막는다.
  if v_lines = 0 and jsonb_array_length(v_items) > 0 then
    raise exception '이형리스트에 묶음번호가 없습니다. MOPS를 최신 버전으로 업데이트한 뒤 다시 출력하세요';
  end if;

  select coalesce(array_agg(distinct s.code order by s.code), '{}'::text[])
    into v_unknown
  from tmp_irregular_src s
  where not exists (select 1 from public.items i where i.code = s.code);

  with up as (
    insert into public.warehouse_irregular_bundles as t (
      work_date, batch_key, bundle_no, status, stale, export_count, last_exported_at
    )
    select p_date, v_batch, s.bundle_no, '대기', false, 1, now()
    from tmp_irregular_src s
    group by s.bundle_no
    on conflict (work_date, batch_key, bundle_no)
    do update set
      last_exported_at = excluded.last_exported_at,
      export_count = t.export_count + 1,
      stale = false
    returning (t.xmax = 0) as was_inserted
  )
  select
    count(*) filter (where up.was_inserted),
    count(*) filter (where not up.was_inserted)
    into v_inserted, v_updated
  from up;

  insert into public.warehouse_irregular_bundle_items as t (
    bundle_id, item_code, item_name, location_code, qty
  )
  select
    b.id,
    s.code,
    coalesce(nullif(s.src_name, ''), i.name, ''),
    coalesce(nullif(s.src_location, ''), i.location_code, ''),
    s.src_qty
  from tmp_irregular_src s
  join public.warehouse_irregular_bundles b
    on b.work_date = p_date and b.batch_key = v_batch and b.bundle_no = s.bundle_no
  left join public.items i on i.code = s.code
  on conflict (bundle_id, item_code)
  do update set
    qty = excluded.qty,
    item_name = excluded.item_name,
    location_code = excluded.location_code;

  -- 묶음은 남았는데 이번 출력에서 빠진 상품 줄은 지운다.
  delete from public.warehouse_irregular_bundle_items x
  using public.warehouse_irregular_bundles b
  where x.bundle_id = b.id
    and b.work_date = p_date
    and b.batch_key = v_batch
    and b.bundle_no = any (v_bundle_nos)
    and not exists (
      select 1 from tmp_irregular_src s where s.bundle_no = b.bundle_no and s.code = x.item_code
    );

  -- 같은 (날짜, 주문서)인데 이번 출력에서 빠진 묶음: 손대지 않은 대기 건은 삭제, 나머지는 제외 표시
  delete from public.warehouse_irregular_bundles b
  where b.work_date = p_date
    and b.batch_key = v_batch
    and not (b.bundle_no = any (v_bundle_nos))
    and b.status = '대기'
    and b.expected_box_count is null;
  get diagnostics v_deleted = row_count;

  update public.warehouse_irregular_bundles b
  set stale = true
  where b.work_date = p_date
    and b.batch_key = v_batch
    and not (b.bundle_no = any (v_bundle_nos));
  get diagnostics v_stale = row_count;

  perform public.warehouse_log_action(
    'irregular_import',
    'irregular',
    v_batch,
    p_date,
    null,
    jsonb_build_object(
      'batch_key', v_batch,
      'inserted', v_inserted,
      'updated', v_updated,
      'stale', v_stale,
      'deleted', v_deleted,
      'lines', v_lines,
      'skipped', to_jsonb(v_unknown)
    ),
    'mops',
    null,
    '',
    p_actor_name
  );

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'stale', v_stale,
    'deleted', v_deleted,
    'lines', v_lines,
    'skipped', to_jsonb(v_unknown)
  );
end;
$$;
