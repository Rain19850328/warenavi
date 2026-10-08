-- 이형포장을 상품별 → 묶음(주문 1건)별로 바꾼다.
--   warehouse_irregular_bundles : 묶음 1건 = 카드 1장. 작업 상태·예상박스수는 여기에 한 번만 둔다.
--   warehouse_irregular_bundle_items : 묶음에 든 상품 줄(재고확인·진열 요청은 상품마다).

create table if not exists public.warehouse_irregular_bundles (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  batch_key text not null default '',
  bundle_no text not null,
  expected_box_count integer check (expected_box_count is null or expected_box_count >= 0),
  status text not null default '대기' check (status in ('대기', '작업중', '포장완료')),
  stale boolean not null default false,
  export_count integer not null default 1,
  last_exported_at timestamptz,
  status_changed_at timestamptz,
  status_changed_by_user_id uuid,
  status_changed_by_name text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists warehouse_irregular_bundles_batch_bundle_uidx
  on public.warehouse_irregular_bundles (work_date, batch_key, bundle_no);

drop trigger if exists warehouse_irregular_bundles_set_updated_at on public.warehouse_irregular_bundles;
create trigger warehouse_irregular_bundles_set_updated_at
before update on public.warehouse_irregular_bundles
for each row
execute function public.warehouse_set_updated_at();

alter table public.warehouse_irregular_bundles enable row level security;

-- 묶음에 든 상품 줄. 상품 DB에 없는 SKU도 묶음에서 빠지면 안 되므로(합포장 누락) items FK를 두지 않는다.
-- 기존 warehouse_irregular_items(상품별 집계)는 운영 중 잠금을 피하려고 그대로 두고 더 이상 쓰지 않는다.
create table if not exists public.warehouse_irregular_bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.warehouse_irregular_bundles(id) on delete cascade,
  item_code text not null,
  item_name text not null default '',
  location_code text not null default '',
  qty integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists warehouse_irregular_bundle_items_bundle_item_uidx
  on public.warehouse_irregular_bundle_items (bundle_id, item_code);

create index if not exists warehouse_irregular_bundle_items_item_code_idx
  on public.warehouse_irregular_bundle_items (item_code);

drop trigger if exists warehouse_irregular_bundle_items_set_updated_at on public.warehouse_irregular_bundle_items;
create trigger warehouse_irregular_bundle_items_set_updated_at
before update on public.warehouse_irregular_bundle_items
for each row
execute function public.warehouse_set_updated_at();

alter table public.warehouse_irregular_bundle_items enable row level security;

-- 이미 상품별로 저장된 행은 상품 1개짜리 묶음으로 옮긴다(상태·예상박스수 유지).
-- 같은 주문서를 MOPS에서 다시 출력하면 실제 묶음으로 대체된다.
insert into public.warehouse_irregular_bundles (
  work_date, batch_key, bundle_no, expected_box_count, status, stale, export_count,
  last_exported_at, status_changed_at, status_changed_by_user_id, status_changed_by_name,
  created_at, updated_at
)
select
  x.work_date, x.batch_key, '상품별 ' || x.item_code, x.expected_box_count, x.status, x.stale, x.export_count,
  x.last_exported_at, x.status_changed_at, x.status_changed_by_user_id, x.status_changed_by_name,
  x.created_at, x.updated_at
from public.warehouse_irregular_items x
on conflict (work_date, batch_key, bundle_no) do nothing;

insert into public.warehouse_irregular_bundle_items (bundle_id, item_code, item_name, location_code, qty)
select b.id, x.item_code, x.item_name, x.location_code, x.qty
from public.warehouse_irregular_items x
join public.warehouse_irregular_bundles b
  on b.work_date = x.work_date
 and b.batch_key = x.batch_key
 and b.bundle_no = '상품별 ' || x.item_code
on conflict (bundle_id, item_code) do nothing;

-- IRREGULAR 묶음 모양. open_requests 는 작업일 또는 오늘(KST)에 열려 있는 요청 기준.
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
        order by x.location_code asc, x.item_code asc
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

create or replace function public.warehouse_get_irregular_list(p_date date default null)
returns jsonb
language plpgsql
stable
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_bundles jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_irregular_bundle_json(b)
        order by b.batch_key asc, b.bundle_no asc
      ),
      '[]'::jsonb
    )
    into v_bundles
  from public.warehouse_irregular_bundles b
  where b.work_date = v_date;

  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'bundles', coalesce(v_bundles, '[]'::jsonb));
end;
$$;

-- p_id = 묶음 id. p_patch 키: status, expected_box_count (있는 키만 적용, expected_box_count:null = 비움)
create or replace function public.warehouse_update_irregular_item(
  p_id uuid,
  p_patch jsonb,
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_row public.warehouse_irregular_bundles%rowtype;
  v_new_status text;
  v_box_text text;
  v_new_box integer;
  v_status_dirty boolean := false;
  v_box_dirty boolean := false;
  v_code text;
  v_json jsonb;
begin
  if p_id is null then
    raise exception '이형포장 묶음이 지정되지 않았습니다';
  end if;

  if jsonb_typeof(v_patch) <> 'object' then
    raise exception '수정 내용 형식이 올바르지 않습니다';
  end if;

  select b.*
    into v_row
  from public.warehouse_irregular_bundles b
  where b.id = p_id
  for update;

  if not found then
    raise exception '이형포장 묶음을 찾을 수 없습니다. 새로고침 후 다시 시도하세요';
  end if;

  v_new_status := v_row.status;
  if v_patch ? 'status' then
    v_new_status := trim(coalesce(v_patch ->> 'status', ''));
    if v_new_status not in ('대기', '작업중', '포장완료') then
      raise exception '상태 값이 올바르지 않습니다: %', v_new_status;
    end if;
    v_status_dirty := v_new_status is distinct from v_row.status;
  end if;

  v_new_box := v_row.expected_box_count;
  if v_patch ? 'expected_box_count' then
    if jsonb_typeof(v_patch -> 'expected_box_count') = 'null' then
      v_new_box := null;
    else
      v_box_text := trim(coalesce(v_patch ->> 'expected_box_count', ''));
      if v_box_text = '' then
        v_new_box := null;
      elsif v_box_text !~ '^[0-9]{1,6}$' then
        raise exception '예상박스수량은 0 이상의 정수로 입력하세요';
      else
        v_new_box := v_box_text::integer;
      end if;
    end if;
    v_box_dirty := v_new_box is distinct from v_row.expected_box_count;
  end if;

  if v_status_dirty or v_box_dirty then
    update public.warehouse_irregular_bundles b
    set status = v_new_status,
        expected_box_count = v_new_box,
        status_changed_at = case when v_status_dirty then now() else b.status_changed_at end,
        status_changed_by_user_id = case when v_status_dirty then p_actor_user_id else b.status_changed_by_user_id end,
        status_changed_by_name = case
          when v_status_dirty then trim(coalesce(p_actor_name, ''))
          else b.status_changed_by_name
        end
    where b.id = p_id;

    -- 작업로그는 SKU로 검색하므로 묶음에 든 상품마다 한 줄씩 남긴다.
    for v_code in
      select x.item_code
      from public.warehouse_irregular_bundle_items x
      where x.bundle_id = p_id
      order by x.item_code
    loop
      if v_status_dirty then
        perform public.warehouse_log_action(
          'irregular_status', 'irregular', p_id::text, v_row.work_date, v_code,
          jsonb_build_object('old', v_row.status, 'new', v_new_status, 'bundle_no', v_row.bundle_no),
          'web', p_actor_user_id, p_actor_email, p_actor_name
        );
      end if;
      if v_box_dirty then
        perform public.warehouse_log_action(
          'irregular_box_count', 'irregular', p_id::text, v_row.work_date, v_code,
          jsonb_build_object('old', v_row.expected_box_count, 'new', v_new_box, 'bundle_no', v_row.bundle_no),
          'web', p_actor_user_id, p_actor_email, p_actor_name
        );
      end if;
    end loop;
  end if;

  select public.warehouse_irregular_bundle_json(b)
    into v_json
  from public.warehouse_irregular_bundles b
  where b.id = p_id;

  return jsonb_build_object('ok', true, 'bundle', v_json);
end;
$$;

-- MOPS 전용(HTTP 경로 없음). p_items = [{bundle_no, item_code, item_name, location_code, qty}] (묶음×상품 한 줄씩)
-- 엑셀 재출력에 안전: status / expected_box_count 는 절대 건드리지 않는다.
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

-- 탭 뱃지 건수 (이형포장은 묶음 수로 센다)
create or replace function public.warehouse_get_tab_counts(p_date date default null)
returns jsonb
language plpgsql
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_pending integer := 0;
  v_mismatch integer := 0;
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
    'display_open', v_display,
    'irregular_open', v_irregular,
    'soldout', v_soldout
  );
end;
$$;
