create table if not exists public.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  content_type text not null,
  size_bytes integer not null,
  uploaded_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists ticket_attachments_ticket_id_idx
  on public.ticket_attachments (ticket_id);

alter table public.ticket_attachments enable row level security;

drop policy if exists ticket_attachments_select on public.ticket_attachments;
create policy ticket_attachments_select on public.ticket_attachments
  for select to authenticated
  using (
    public.is_helpdesk_staff()
    or exists (
      select 1 from public.tickets t
      where t.id = ticket_id and t.user_id = auth.uid()
    )
    or public.can_follow_ticket(ticket_id)
  );

grant select on public.ticket_attachments to authenticated;

create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_name text not null,
  action text not null,
  target_name text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_at_idx
  on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;

drop policy if exists admin_audit_select on public.admin_audit;
create policy admin_audit_select on public.admin_audit
  for select to authenticated
  using (public.admin_can('users'));

grant select on public.admin_audit to authenticated;

create or replace function public.audit_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  actor_label text;
  detail text := '';
begin
  if actor is null or tg_op <> 'UPDATE' then
    return new;
  end if;
  if new.role is not distinct from old.role
     and new.department is not distinct from old.department
     and new.is_approved is not distinct from old.is_approved
     and new.admin_permissions is not distinct from old.admin_permissions then
    return new;
  end if;
  select coalesce(full_name, 'مدير') into actor_label from public.profiles where id = actor;
  if new.role is distinct from old.role then
    detail := detail || 'تغير الدور. ';
  end if;
  if new.department is distinct from old.department then
    detail := detail || 'تغير القسم. ';
  end if;
  if new.is_approved is distinct from old.is_approved then
    detail := detail || case when new.is_approved then 'تم اعتماد الحساب. ' else 'تم إيقاف الحساب. ' end;
  end if;
  if new.admin_permissions is distinct from old.admin_permissions then
    detail := detail || 'تغيرت صلاحيات مدير النظام. ';
  end if;
  insert into public.admin_audit (actor_id, actor_name, action, target_name, detail)
  values (actor, coalesce(actor_label, 'مدير'), 'تعديل حساب', new.full_name, btrim(detail));
  return new;
end;
$$;

drop trigger if exists profiles_audit_change on public.profiles;
create trigger profiles_audit_change
  after update on public.profiles
  for each row
  execute function public.audit_profile_change();

insert into storage.buckets (id, name, public)
values ('ticket-files', 'ticket-files', false)
on conflict (id) do nothing;

select 'attachments-audit' as result;
