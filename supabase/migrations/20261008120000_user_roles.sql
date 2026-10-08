-- 계정별 권한(직원 staff / 매니저 manager / 관리자 admin).
-- 계정 원본은 auth.users 에 있고, 여기에는 권한만 둔다(표에 없는 계정은 직원).
-- 관리자가 아직 한 명도 없으면(처음 설정 전) 모든 계정을 관리자로 취급한다.
-- 그 상태에서 저장한 권한은 기록만 되고, 관리자가 지정되는 순간부터 적용된다.

create table if not exists public.warehouse_user_roles (
  user_id uuid primary key,
  role text not null check (role in ('staff', 'manager', 'admin')),
  email text not null default '',
  display_name text not null default '',
  updated_by_user_id uuid,
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.warehouse_user_roles enable row level security;

create or replace function public.warehouse_get_user_role(p_user_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_assigned text;
  v_has_admin boolean;
begin
  select exists (select 1 from public.warehouse_user_roles r where r.role = 'admin')
    into v_has_admin;

  select r.role
    into v_assigned
  from public.warehouse_user_roles r
  where r.user_id = p_user_id;

  return jsonb_build_object(
    'role', case when v_has_admin then coalesce(v_assigned, 'staff') else 'admin' end,
    'assigned', v_assigned,
    'bootstrap', not v_has_admin
  );
end;
$$;

create or replace function public.warehouse_list_user_roles()
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'has_admin', exists (select 1 from public.warehouse_user_roles r where r.role = 'admin'),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'role', r.role,
        'updated_at', r.updated_at,
        'updated_by_name', r.updated_by_name
      ))
      from public.warehouse_user_roles r
    ), '[]'::jsonb)
  );
$$;

create or replace function public.warehouse_set_user_role(
  p_user_id uuid,
  p_role text,
  p_email text default '',
  p_display_name text default '',
  p_actor_user_id uuid default null,
  p_actor_email text default '',
  p_actor_name text default ''
)
returns jsonb
language plpgsql
as $$
declare
  v_role text := trim(coalesce(p_role, ''));
  v_old text;
  v_admins integer;
begin
  if p_user_id is null then
    raise exception '계정이 지정되지 않았습니다.';
  end if;
  if v_role not in ('staff', 'manager', 'admin') then
    raise exception '권한 값이 올바르지 않습니다.';
  end if;

  -- 마지막 관리자 확인이 동시에 두 번 통과하지 않도록 표 전체를 잠근다(행이 몇 개뿐인 표).
  lock table public.warehouse_user_roles in share row exclusive mode;

  if (public.warehouse_get_user_role(p_actor_user_id) ->> 'role') <> 'admin' then
    raise exception '관리자만 권한을 바꿀 수 있습니다.';
  end if;

  select r.role into v_old
  from public.warehouse_user_roles r
  where r.user_id = p_user_id;

  select count(*) into v_admins
  from public.warehouse_user_roles r
  where r.role = 'admin';

  if v_old = 'admin' and v_role <> 'admin' and v_admins <= 1 then
    raise exception '마지막 관리자는 권한을 낮출 수 없습니다. 먼저 다른 계정을 관리자로 지정하세요.';
  end if;

  if v_old is not distinct from v_role then
    return jsonb_build_object('ok', true, 'changed', false, 'user_id', p_user_id, 'role', v_role, 'old_role', v_old);
  end if;

  insert into public.warehouse_user_roles (
    user_id, role, email, display_name, updated_by_user_id, updated_by_name
  )
  values (
    p_user_id, v_role, trim(coalesce(p_email, '')), trim(coalesce(p_display_name, '')),
    p_actor_user_id, trim(coalesce(p_actor_name, ''))
  )
  on conflict (user_id) do update
    set role = excluded.role,
        email = excluded.email,
        display_name = excluded.display_name,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_by_name = excluded.updated_by_name,
        updated_at = now();

  perform public.warehouse_log_action(
    'user_role_change',
    'user_role',
    p_user_id::text,
    null,
    null,
    jsonb_build_object(
      'target_email', trim(coalesce(p_email, '')),
      'target_name', trim(coalesce(p_display_name, '')),
      'old', v_old,
      'new', v_role
    ),
    'web',
    p_actor_user_id,
    p_actor_email,
    p_actor_name
  );

  return jsonb_build_object('ok', true, 'changed', true, 'user_id', p_user_id, 'role', v_role, 'old_role', v_old);
end;
$$;
