-- 플레이오토가 등록된 IP(사무실)에서만 API를 받게 되어, 재고 전송을 사무실 PC의 전송기(tools/playauto_worker.py)가 맡는다.
--   1) 전송 대기 목록: 반영으로 판단했고 플레이오토 전송이 '대기'인 건.
--   2) 전송기 작동 기록: 전송기가 주기적으로 남겨 화면에서 "마지막 확인 시각"을 보여 준다.
--   3) 플레이오토 사용량 응답에 전송기 마지막 확인 시각을 붙인다.

create table if not exists public.warehouse_worker_status (
  worker text primary key,
  last_seen timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);
alter table public.warehouse_worker_status enable row level security;

create or replace function public.warehouse_playauto_queue(p_limit integer default 20)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(q order by q.reviewed_at), '[]'::jsonb)
  from (
    select r.id, r.item_code, r.item_name, r.counted_qty, r.live_stock, r.reviewed_at
    from public.warehouse_stock_check_requests r
    where r.review_status = 'applied'
      and r.playauto_status = 'pending'
    order by r.reviewed_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) q;
$$;

create or replace function public.warehouse_worker_ping(p_worker text, p_info jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_worker text := left(trim(coalesce(p_worker, '')), 50);
begin
  if v_worker = '' then
    raise exception '전송기 이름이 필요합니다';
  end if;

  insert into public.warehouse_worker_status as w (worker, last_seen, info)
  values (v_worker, now(), coalesce(p_info, '{}'::jsonb))
  on conflict (worker) do update
    set last_seen = now(),
        info = coalesce(excluded.info, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'worker', v_worker);
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
                       where u.usage_day = public.warehouse_playauto_usage_day()), 0),
    'worker_seen_at', (select w.last_seen from public.warehouse_worker_status w where w.worker = 'playauto'),
    'worker_info', (select w.info from public.warehouse_worker_status w where w.worker = 'playauto'),
    'queue', (select count(*) from public.warehouse_stock_check_requests r
              where r.review_status = 'applied' and r.playauto_status = 'pending')
  );
$$;
