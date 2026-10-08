-- 1) 품절관리 목록에서 단종 상품을 지운다(한 번만 실행되는 정리).
--    재고확인에서 일치를 누르면 단종 상품까지 자동 등록되던 시기에 쌓인 건이다.
--    품절관리 화면에서 사람이 재고상태를 바꾼 건(last_set_at 있음)은 처리 기록이므로 남긴다.
do $$
declare
  r record;
begin
  for r in
    select so.id, so.soldout_date, so.item_code, so.source
    from public.warehouse_soldout_items so
    join public.sku_status ss on ss.sku_cd = so.item_code
    where (ss.stock_status = '단종' or ss.item_status = '단종')
      and so.last_set_at is null
    order by so.soldout_date, so.item_code
  loop
    delete from public.warehouse_soldout_items so where so.id = r.id;

    perform public.warehouse_log_action(
      'soldout_remove',
      'soldout',
      r.id::text,
      r.soldout_date,
      r.item_code,
      jsonb_build_object('source', r.source, 'reason', 'discontinued_cleanup'),
      'system',
      null,
      '',
      '단종 정리'
    );
  end loop;
end;
$$;

-- 2) 변경 표시: 화면이 주기적으로 이 값을 받아, 달라졌을 때만 목록을 새로 불러온다.
--    웹의 모든 변경은 작업로그에, 스토리지렉 입출고·이동은 이동기록에 남으므로 두 표의 마지막 번호면 충분하다.
create or replace function public.warehouse_get_change_stamp()
returns text
language sql
stable
as $$
  select
    coalesce((select max(l.id) from public.warehouse_action_logs l), 0)::text
    || '.' ||
    coalesce((select max(m.id) from public.warehouse_movements m), 0)::text;
$$;
