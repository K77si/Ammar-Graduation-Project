-- Pre-launch hardening: no function is callable without login, functions have
-- a fixed search_path, ticket lookups are indexed, leftovers are removed, and
-- the first real ticket starts at #1001.

drop function if exists public.rate_own_ticket(uuid, integer);
drop function if exists public.my_profile();

revoke execute on all functions in schema public from anon, public;
alter default privileges in schema public revoke execute on functions from anon, public;

grant execute on function
  public.staff_names(),
  public.rate_ticket(uuid, integer, text),
  public.ticket_action(uuid, text, jsonb),
  public.close_stale_tickets(),
  public.admin_can(text),
  public.is_helpdesk_staff(),
  public.can_view_ticket(uuid, text, text, boolean, boolean),
  public.can_follow_ticket(uuid),
  public.viewer_same_department(text),
  public.is_tech_department(text)
to authenticated;

do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.proconfig is null
  loop
    execute format('alter function %s set search_path = public', fn.signature);
  end loop;
end $$;

-- Trigger functions fire on their own; nobody needs to call them directly.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and pg_get_function_result(p.oid) in ('trigger', 'event_trigger')
  loop
    execute format('revoke execute on function %s from authenticated, anon, public', fn.signature);
  end loop;
end $$;

create index if not exists tickets_user_id_idx on public.tickets (user_id);
create index if not exists tickets_assigned_technician_idx on public.tickets (assigned_technician);
create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_affected_department_idx on public.tickets (affected_department);
create index if not exists tickets_created_at_idx on public.tickets (created_at desc);
create index if not exists ticket_replies_ticket_id_idx on public.ticket_replies (ticket_id);
create index if not exists ticket_events_ticket_id_idx on public.ticket_events (ticket_id);
create index if not exists ticket_notes_ticket_id_idx on public.ticket_notes (ticket_id);
create index if not exists ticket_attachments_ticket_id_idx on public.ticket_attachments (ticket_id);
create index if not exists profiles_department_idx on public.profiles (department);
create index if not exists profiles_role_idx on public.profiles (role);

do $$
declare t text;
declare n bigint;
begin
  foreach t in array array['analytics_logs', 'knowledge_base', 'notifications'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n = 0 then
        execute format('drop table public.%I', t);
      end if;
    end if;
  end loop;
end $$;

do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('public.tickets', 'ticket_number');
  if seq is null then
    select schemaname || '.' || sequencename into seq from pg_sequences where sequencename like '%ticket_number%' limit 1;
  end if;
  if seq is not null and not exists (select 1 from public.tickets) then
    perform setval(seq, 1000, true);
  end if;
end $$;

select 'launch-readiness' as result,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')) as anon_callable_functions,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proconfig is null) as functions_without_search_path,
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity) as tables_without_rls,
  (select last_value from pg_sequences where sequencename like '%ticket_number%' limit 1) as ticket_counter;
