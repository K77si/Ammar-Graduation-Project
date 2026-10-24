-- Limited system-admin permissions. Null means the existing full admin keeps every permission.
-- Granting role=admin or changing the permission list is allowed for the service role only.

alter table public.profiles
  add column if not exists admin_permissions text[];

create or replace function public.admin_can(permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and (admin_permissions is null or permission = any (admin_permissions))
  );
$$;

revoke all on function public.admin_can(text) from public;
grant execute on function public.admin_can(text) to authenticated, service_role;

create or replace function public.guard_profile_admin()
returns trigger
language plpgsql
as $$
declare
  actor text := coalesce(auth.role(), '');
  owner_row boolean;
begin
  if actor = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'admin' then
      raise exception 'تعيين مدير النظام يتم بعد تحقق المالك فقط';
    end if;
    new.admin_permissions := null;
    return new;
  end if;

  owner_row := old.role = 'admin'
    and (coalesce(old.full_name, '') like '%عمار%' or coalesce(old.username, '') = 'ammar');

  if owner_row and auth.uid() is distinct from old.id then
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

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before insert or update on public.profiles
  for each row
  execute function public.guard_profile_admin();

create or replace function public.guard_owner_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and old.role = 'admin'
     and (coalesce(old.full_name, '') like '%عمار%' or coalesce(old.username, '') = 'ammar') then
    raise exception 'لا يمكن حذف حساب المالك';
  end if;
  return old;
end;
$$;

drop trigger if exists profiles_guard_owner_delete on public.profiles;
create trigger profiles_guard_owner_delete
  before delete on public.profiles
  for each row
  execute function public.guard_owner_delete();

create or replace function public.guard_settings_admin()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;
  if not public.admin_can('settings') then
    raise exception 'ليست لديك صلاحية الإعدادات';
  end if;
  return new;
end;
$$;

drop trigger if exists system_settings_guard_admin on public.system_settings;
create trigger system_settings_guard_admin
  before insert or update on public.system_settings
  for each row
  execute function public.guard_settings_admin();

create or replace function public.guard_admin_ticket_reply()
returns trigger
language plpgsql
as $$
declare
  actor_role text;
  perms text[];
begin
  if coalesce(auth.role(), '') in ('service_role', '') or auth.uid() is null then
    return new;
  end if;
  select role, admin_permissions into actor_role, perms
  from public.profiles
  where id = auth.uid();
  if actor_role = 'admin' and perms is not null and not ('tickets' = any (perms)) then
    raise exception 'ليست لديك صلاحية البلاغات';
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_replies_guard_admin on public.ticket_replies;
create trigger ticket_replies_guard_admin
  before insert on public.ticket_replies
  for each row
  execute function public.guard_admin_ticket_reply();

select 'admin-permissions' as result;
