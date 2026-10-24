-- Tighten profile reads, block work before a required password change,
-- and keep support technicians inside technical support.

create or replace function public.viewer_same_department(dept text)
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
      and role = 'department_head'
      and department is not null
      and department = dept
  );
$$;

revoke all on function public.viewer_same_department(text) from public;
grant execute on function public.viewer_same_department(text) to authenticated;

create or replace function public.staff_names()
returns table (id uuid, full_name text, department text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.department, p.role
  from public.profiles p
  where p.role in ('admin', 'manager', 'technician');
$$;

revoke all on function public.staff_names() from public;
grant execute on function public.staff_names() to authenticated;

do $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and upper(cmd) = 'SELECT'
  loop
    execute format('drop policy if exists %I on public.profiles', r.policyname);
  end loop;
end $$;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select to authenticated
  using (public.is_helpdesk_staff());

drop policy if exists profiles_select_department_head on public.profiles;
create policy profiles_select_department_head on public.profiles
  for select to authenticated
  using (public.viewer_same_department(department));

create or replace function public.reject_until_password_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and exists (
    select 1 from public.profiles
    where id = auth.uid() and must_change_password is true
  ) then
    raise exception 'يجب تغيير كلمة المرور قبل استخدام سند.';
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_require_password on public.tickets;
create trigger tickets_require_password
  before insert or update on public.tickets
  for each row
  execute function public.reject_until_password_changed();

drop trigger if exists replies_require_password on public.ticket_replies;
create trigger replies_require_password
  before insert on public.ticket_replies
  for each row
  execute function public.reject_until_password_changed();

create or replace function public.guard_technician_department()
returns trigger
language plpgsql
as $$
declare
  dept text := lower(btrim(coalesce(new.department, '')));
  tech boolean := dept in ('الدعم التقني', 'الدعم التقني (it)', 'تقنية المعلومات', 'it', 'information technology');
begin
  if new.role in ('technician', 'manager') then
    if not tech then
      raise exception 'فني الدعم يتبع قسم الدعم التقني فقط.';
    end if;
    new.department := 'الدعم التقني';
  elsif tech and dept <> 'الدعم التقني' then
    new.department := 'الدعم التقني';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_technician_department on public.profiles;
create trigger profiles_guard_technician_department
  before insert or update on public.profiles
  for each row
  execute function public.guard_technician_department();

update public.profiles
set department = 'الدعم التقني'
where role in ('technician', 'manager')
   or lower(btrim(department)) in ('الدعم التقني (it)', 'تقنية المعلومات', 'it', 'information technology');

update public.tickets
set department = 'الدعم التقني'
where lower(btrim(department)) in ('الدعم التقني (it)', 'تقنية المعلومات', 'it', 'information technology');

do $$
begin
  if not exists (
    select 1
    from public.profiles
    group by lower(email)
    having count(*) > 1
  ) then
    create unique index if not exists profiles_email_lower_key
      on public.profiles (lower(email));
  end if;
end $$;

select 'audit-role-guards' as result;
