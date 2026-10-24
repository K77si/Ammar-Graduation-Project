-- Comments, assignee, technician role, and closed-ticket delete.

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
  check (role in ('admin', 'user', 'manager', 'technician'));

update public.profiles
  set must_change_password = false
  where must_change_password is true;

-- tickets.assigned_technician already exists as text and stores the profile id.

create table if not exists public.ticket_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  sender_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.ticket_replies enable row level security;

create or replace function public.is_helpdesk_staff()
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
      and role in ('admin', 'manager', 'technician')
  );
$$;

grant execute on function public.is_helpdesk_staff() to authenticated;

grant select, insert on public.ticket_replies to authenticated;

drop policy if exists ticket_replies_select on public.ticket_replies;
create policy ticket_replies_select on public.ticket_replies
  for select to authenticated
  using (
    public.is_helpdesk_staff()
    or exists (
      select 1 from public.tickets t
      where t.id = ticket_id and t.user_id = auth.uid()
    )
  );

drop policy if exists ticket_replies_insert on public.ticket_replies;
create policy ticket_replies_insert on public.ticket_replies
  for insert to authenticated
  with check (
    public.is_helpdesk_staff()
    or exists (
      select 1 from public.tickets t
      where t.id = ticket_id and t.user_id = auth.uid()
    )
  );

do $$
begin
  if exists (
    select 1 from pg_class
    where oid = 'public.tickets'::regclass and relrowsecurity
  ) then
    execute 'grant delete on table public.tickets to authenticated';
  end if;
end $$;

drop policy if exists tickets_delete_closed on public.tickets;
create policy tickets_delete_closed on public.tickets
  for delete to authenticated
  using (status = 'مغلقة' and public.is_helpdesk_staff());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tickets'
  ) then
    alter publication supabase_realtime add table public.tickets;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ticket_replies'
  ) then
    alter publication supabase_realtime add table public.ticket_replies;
  end if;
end $$;

do $$
declare
  r record;
  marker constant text := '---THREAD---';
  pos integer;
  problem text;
  payload jsonb;
  msg jsonb;
  assignee uuid;
begin
  for r in
    select id, title
    from public.tickets
    where title like '%---THREAD---%'
  loop
    pos := position(marker in r.title);
    problem := btrim(substring(r.title from 1 for pos - 1));
    begin
      payload := btrim(substring(r.title from pos + length(marker)))::jsonb;
    exception when others then
      payload := '{}'::jsonb;
    end;

    assignee := null;
    if coalesce(payload->>'assigneeId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.profiles p where p.id = (payload->>'assigneeId')::uuid) then
      assignee := (payload->>'assigneeId')::uuid;
    end if;

    update public.tickets
      set title = problem,
          assigned_technician = coalesce(assignee::text, assigned_technician)
      where id = r.id;

    if jsonb_typeof(payload->'messages') = 'array' then
      for msg in select value from jsonb_array_elements(payload->'messages')
      loop
        if length(btrim(coalesce(msg->>'message', msg->>'text', ''))) > 0 then
          insert into public.ticket_replies (ticket_id, sender_name, message, created_at)
          values (
            r.id,
            coalesce(nullif(msg->>'sender', ''), 'مستخدم'),
            btrim(coalesce(msg->>'message', msg->>'text', '')),
            coalesce(nullif(msg->>'created_at', '')::timestamptz, now())
          );
        end if;
      end loop;
    end if;
  end loop;
end $$;

select c.relname, c.relrowsecurity
from pg_class c
where c.oid in ('public.tickets'::regclass, 'public.ticket_replies'::regclass);
