-- The owner was recognised by a name containing «عمار». Any admin holding the
-- users permission could rename an account to that and gain owner rights.
-- The owner is now a flag that only the service role can set.

alter table public.profiles
  add column if not exists is_owner boolean not null default false;

do $$
declare
  matches int;
begin
  if not exists (select 1 from public.profiles where is_owner) then
    select count(*) into matches
    from public.profiles
    where role = 'admin'
      and (coalesce(full_name, '') like '%عمار%' or coalesce(username, '') = 'ammar');
    if matches <> 1 then
      raise exception 'expected exactly one owner account, found %', matches;
    end if;
    update public.profiles
    set is_owner = true
    where role = 'admin'
      and (coalesce(full_name, '') like '%عمار%' or coalesce(username, '') = 'ammar');
  end if;
end $$;

create unique index if not exists profiles_single_owner on public.profiles (is_owner) where is_owner;

create or replace function public.guard_profile_admin()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  actor text := coalesce(auth.role(), '');
begin
  if actor = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'admin' then
      raise exception 'تعيين مدير النظام يتم بعد تحقق المالك فقط';
    end if;
    new.admin_permissions := null;
    new.is_owner := false;
    return new;
  end if;

  if new.is_owner is distinct from old.is_owner then
    raise exception 'لا يمكن تغيير مالك النظام';
  end if;

  if old.is_owner and auth.uid() is distinct from old.id then
    if new.full_name is distinct from old.full_name
       or new.username is distinct from old.username
       or new.email is distinct from old.email
       or new.role is distinct from old.role
       or new.department is distinct from old.department
       or new.is_approved is distinct from old.is_approved
       or new.admin_permissions is distinct from old.admin_permissions
       or new.employee_number is distinct from old.employee_number
       or new.must_change_password is distinct from old.must_change_password then
      raise exception 'لا يمكن تعديل حساب المالك';
    end if;
  end if;

  if new.role = 'admin' and old.role is distinct from 'admin' then
    raise exception 'تعيين مدير النظام يتم بعد تحقق المالك فقط';
  end if;

  if new.admin_permissions is distinct from old.admin_permissions then
    new.admin_permissions := old.admin_permissions;
  end if;

  if new.is_approved is distinct from old.is_approved and not public.admin_can('approvals') then
    raise exception 'ليست لديك صلاحية الاعتمادات';
  end if;

  if auth.uid() is distinct from old.id
     and (
       new.full_name is distinct from old.full_name
       or new.department is distinct from old.department
       or new.role is distinct from old.role
       or new.email is distinct from old.email
       or new.username is distinct from old.username
     )
     and not public.admin_can('users') then
    raise exception 'ليست لديك صلاحية المستخدمين';
  end if;

  return new;
end;
$$;

create or replace function public.guard_owner_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and old.is_owner then
    raise exception 'لا يمكن حذف حساب المالك';
  end if;
  return old;
end;
$$;

revoke execute on function public.guard_profile_admin() from public, anon, authenticated;
revoke execute on function public.guard_owner_delete() from public, anon, authenticated;

-- Failed sign-in attempts, written and read by the server only.
create table if not exists public.login_attempts (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);

create index if not exists login_attempts_key_time on public.login_attempts (key, created_at desc);

alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;
revoke all on sequence public.login_attempts_id_seq from anon, authenticated;

select 'owner-flag' as result,
  (select count(*) from public.profiles where is_owner) as owners,
  (select relrowsecurity from pg_class where oid = 'public.login_attempts'::regclass) as attempts_rls;
