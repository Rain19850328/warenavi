-- warehouse_get_items_with_stock: 재고 출처를 daily_stock.stock_cnt_real -> item_stocks.stock_today 로 교체
-- 응답 스키마(stock_qty 포함)는 변경 없음. daily_stock 테이블은 다른 MOPS 컬럼이 살아 있어 손대지 않는다.

create or replace function public.warehouse_get_items_with_stock(p_q text default '', p_limit integer default 300)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 5000);
begin
  return jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', t.code,
          'name', t.name,
          'w', t.volume_width,
          'l', t.volume_length,
          'h', t.volume_height,
          'unit_cm3', (
            greatest(t.volume_width, 0::numeric) *
            greatest(t.volume_length, 0::numeric) *
            greatest(t.volume_height, 0::numeric)
          )::integer,
          'location', coalesce(t.location_code, ''),
          'stock_qty', coalesce(s.stock_today, 0)
        )
        order by t.code, t.name
      )
      from (
        select *
        from public.items i
        where v_q = ''
          or i.code ilike '%' || v_q || '%'
          or i.name ilike '%' || v_q || '%'
          or i.location_code ilike '%' || v_q || '%'
        order by i.code asc, i.name asc
        limit v_limit
      ) t
      left join public.item_stocks s on s.item_code = t.code
    ), '[]'::jsonb)
  );
end;
$$;
