-- Clear sequential ticket numbers, starting at 1001.

create sequence if not exists public.tickets_ticket_number_seq as bigint start with 1001;

alter table public.tickets
  add column if not exists ticket_number bigint;

with ordered as (
  select id, row_number() over (order by created_at nulls last, id) as n
  from public.tickets
  where ticket_number is null
)
update public.tickets as ticket
set ticket_number = 1000 + ordered.n
from ordered
where ticket.id = ordered.id
  and ticket.ticket_number is null;

select setval(
  'public.tickets_ticket_number_seq',
  greatest(1000, coalesce((select max(ticket_number) from public.tickets), 1000))
);

alter table public.tickets
  alter column ticket_number set default nextval('public.tickets_ticket_number_seq');

alter table public.tickets
  alter column ticket_number set not null;

create unique index if not exists tickets_ticket_number_key
  on public.tickets (ticket_number);

grant usage, select on sequence public.tickets_ticket_number_seq to anon, authenticated, service_role;
