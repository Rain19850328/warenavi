-- 확인요청 탭: 불일치로 기록된 건을 판단 여부와 상관없이 모두 내려 준다.
--   p_all = true 면 날짜 전체(화면의 기본), 아니면 p_date 하루치.
--   화면에서 대기 / 보류 / 반영 / 미반영으로 나눠 본다.
--   매니저가 재고확인 탭에서 '처리완료'로 닫았고 관리자 판단이 없는 건은 지금처럼 빼 둔다.
create or replace function public.warehouse_get_stock_review_list_by_date(
  p_date date default null,
  p_all boolean default false
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_date date := coalesce(p_date, public.warehouse_kst_today());
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_stock_check_row_json(r)
        order by r.location_code asc, r.item_code asc, r.created_at asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_stock_check_requests r
  where (p_all or r.check_date = v_date)
    and r.status = 'mismatch'
    and (not r.resolved or r.review_status <> '');

  return jsonb_build_object(
    'date', case when p_all then '' else to_char(v_date, 'YYYY-MM-DD') end,
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$$;
