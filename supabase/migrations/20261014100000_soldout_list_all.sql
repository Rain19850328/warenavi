-- 품절관리 탭의 기본 화면: 날짜와 상관없이 등록된 품절 상품 전체를 내려 준다.
--   (하루치는 지금처럼 warehouse_get_soldout_list(p_date))
create or replace function public.warehouse_get_soldout_list_all()
returns jsonb
language plpgsql
stable
as $$
declare
  v_items jsonb;
begin
  select coalesce(
      jsonb_agg(
        public.warehouse_soldout_row_json(so)
        order by so.soldout_date asc, so.created_at asc, so.item_code asc
      ),
      '[]'::jsonb
    )
    into v_items
  from public.warehouse_soldout_items so;

  return jsonb_build_object('date', '', 'items', coalesce(v_items, '[]'::jsonb));
end;
$$;
