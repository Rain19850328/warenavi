drop function if exists public.warehouse_get_movements(integer, uuid);

create or replace function public.warehouse_get_movements(
  p_limit integer default 200,
  p_actor_user_id uuid default null,
  p_rack_code text default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'items',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', src.id,
          'movement_type', src.movement_type,
          'item_code', src.item_code,
          'item_name', src.item_name,
          'rack_code', src.rack_code,
          'from_rack', src.from_rack,
          'to_rack', src.to_rack,
          'quantity', src.quantity,
          'note', src.note,
          'actor_user_id', src.actor_user_id,
          'actor_email', src.actor_email,
          'actor_name', src.actor_name,
          'payload', src.payload,
          'created_at', src.created_at
        )
        order by src.created_at desc
      ),
      '[]'::jsonb
    )
  )
  from (
    select
      wm.id,
      wm.movement_type,
      wm.item_code,
      coalesce(i.name, '') as item_name,
      wm.rack_code,
      wm.from_rack,
      wm.to_rack,
      wm.quantity,
      wm.note,
      wm.actor_user_id,
      wm.actor_email,
      wm.actor_name,
      wm.payload,
      wm.created_at
    from public.warehouse_movements wm
    left join public.items i on i.code = wm.item_code
    where (p_actor_user_id is null or wm.actor_user_id = p_actor_user_id)
      and (
        p_rack_code is null
        or trim(p_rack_code) = ''
        or wm.rack_code = public.warehouse_to_canonical_code(p_rack_code)
        or wm.from_rack = public.warehouse_to_canonical_code(p_rack_code)
        or wm.to_rack = public.warehouse_to_canonical_code(p_rack_code)
        or (
          wm.movement_type = 'set_location'
          and wm.note = public.warehouse_to_canonical_code(p_rack_code)
        )
      )
    order by wm.created_at desc
    limit greatest(coalesce(p_limit, 200), 1)
  ) as src;
$$;
