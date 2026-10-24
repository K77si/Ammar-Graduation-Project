-- Department head can follow tickets raised by their department
-- or sent to their department. They cannot change ticket status.

do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.profiles'::regclass
      and c.contype = 'c'
      and a.attname = 'role'
  loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'user', 'manager', 'technician', 'department_head'));

create or replace function public.can_follow_ticket(ticket uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tickets t
    join public.profiles me on me.id = auth.uid()
    left join public.profiles owner on owner.id = t.user_id
    where t.id = ticket
      and (
        public.is_helpdesk_staff()
        or t.user_id = auth.uid()
        or (
          me.role = 'department_head'
          and me.department is not null
          and (
            t.department = me.department
            or owner.department = me.department
          )
        )
      )
  );
$$;

grant execute on function public.can_follow_ticket(uuid) to authenticated;

drop policy if exists tickets_select_department_head on public.tickets;
create policy tickets_select_department_head on public.tickets
  for select to authenticated
  using (
    exists (
      select 1
      from public.profiles me
      left join public.profiles owner on owner.id = tickets.user_id
      where me.id = auth.uid()
        and me.role = 'department_head'
        and me.department is not null
        and (
          tickets.department = me.department
          or owner.department = me.department
        )
    )
  );

drop policy if exists ticket_replies_select on public.ticket_replies;
create policy ticket_replies_select on public.ticket_replies
  for select to authenticated
  using (public.can_follow_ticket(ticket_id));

drop policy if exists ticket_replies_insert on public.ticket_replies;
create policy ticket_replies_insert on public.ticket_replies
  for insert to authenticated
  with check (public.can_follow_ticket(ticket_id));

select 'department-head' as result;
