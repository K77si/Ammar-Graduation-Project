alter table public.ticket_events add column if not exists source text not null default 'يدوي';
alter table public.admin_audit add column if not exists source text not null default 'يدوي';
alter table public.admin_audit add column if not exists target_id uuid;

alter table public.ticket_events drop constraint if exists ticket_events_source_check;
alter table public.ticket_events add constraint ticket_events_source_check check (source in ('يدوي', 'سند'));
alter table public.admin_audit drop constraint if exists admin_audit_source_check;
alter table public.admin_audit add constraint admin_audit_source_check check (source in ('يدوي', 'سند'));

create index if not exists admin_audit_target_id_idx on public.admin_audit (target_id, created_at desc);

create or replace function public.stamp_sanad_source()
returns trigger
language plpgsql
as $$
begin
  if current_setting('sanad.source', true) = 'سند' then
    new.source := 'سند';
  elsif new.source is null or new.source not in ('يدوي', 'سند') then
    new.source := 'يدوي';
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_events_stamp_source on public.ticket_events;
create trigger ticket_events_stamp_source
  before insert on public.ticket_events
  for each row
  execute function public.stamp_sanad_source();

drop trigger if exists admin_audit_stamp_source on public.admin_audit;
create trigger admin_audit_stamp_source
  before insert on public.admin_audit
  for each row
  execute function public.stamp_sanad_source();

create or replace function public.log_ticket_opened()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
begin
  select coalesce(full_name, 'مستخدم') into actor from public.profiles where id = new.user_id;
  insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note, source)
  values (new.id, coalesce(actor, 'مستخدم'), 'مفتوحة', 'مفتوحة', 'فتح البلاغ', 'يدوي');
  return new;
end;
$$;

drop trigger if exists tickets_log_opened on public.tickets;
create trigger tickets_log_opened
  after insert on public.tickets
  for each row
  execute function public.log_ticket_opened();

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
  origin text := case when current_setting('sanad.source', true) = 'سند' then 'سند' else 'يدوي' end;
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
  insert into public.admin_audit (actor_id, actor_name, action, target_name, detail, target_id, source)
  values (actor, coalesce(actor_label, 'مدير'), 'تعديل حساب', new.full_name, btrim(detail), new.id, origin);
  return new;
end;
$$;

drop policy if exists admin_audit_own on public.admin_audit;
create policy admin_audit_own on public.admin_audit
  for select to authenticated
  using (target_id = auth.uid());

create or replace function public.ticket_action(ticket uuid, action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.tickets;
  me public.profiles;
  reason text := btrim(coalesce(payload->>'reason', ''));
  staff boolean;
  actor text;
begin
  perform set_config('sanad.source', case when payload->>'via' = 'sanad' then 'سند' else 'يدوي' end, true);
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'يلزم تسجيل الدخول.';
  end if;
  if me.is_approved is false then
    raise exception 'الحساب بانتظار الاعتماد.';
  end if;
  if me.must_change_password is true then
    raise exception 'يجب تغيير كلمة المرور قبل استخدام سند.';
  end if;
  select * into row from public.tickets where id = ticket;
  if row.id is null
     or not public.can_view_ticket(row.user_id, row.department, row.affected_department, row.is_private, row.is_outage) then
    raise exception 'البلاغ غير متاح.';
  end if;
  staff := me.role in ('admin', 'technician', 'manager');
  actor := coalesce(me.full_name, 'مستخدم');

  if action = 'cancel' then
    update public.tickets set status = 'ملغاة', cancel_reason = reason where id = ticket;
  elsif action = 'confirm' then
    if row.user_id <> me.id then
      raise exception 'تأكيد الإغلاق لصاحب البلاغ.';
    end if;
    update public.tickets set status = 'مغلقة' where id = ticket;
  elsif action = 'reopen' then
    if row.user_id <> me.id then
      raise exception 'إعادة الفتح لصاحب البلاغ.';
    end if;
    if length(reason) < 3 then
      raise exception 'اكتب سبب إعادة الفتح.';
    end if;
    update public.tickets set status = 'مفتوحة' where id = ticket;
    update public.ticket_events set note = reason
    where id = (select id from public.ticket_events where ticket_id = ticket order by created_at desc limit 1);
  elsif action = 'claim' then
    if me.role not in ('technician', 'manager') then
      raise exception 'الاستلام للفني.';
    end if;
    if row.assigned_technician is not null then
      raise exception 'البلاغ مع فني.';
    end if;
    if row.status <> 'مفتوحة' then
      raise exception 'يُستلم البلاغ وهو مفتوح.';
    end if;
    update public.tickets set status = 'قيد المعالجة', assigned_technician = me.id::text where id = ticket;
  elsif action = 'status' then
    if not staff then
      raise exception 'تغيير الحالة للفني أو لمدير النظام.';
    end if;
    update public.tickets
      set status = payload->>'status',
          resolution = case
            when payload->>'status' = 'منجزة' then coalesce(nullif(btrim(coalesce(payload->>'resolution', '')), ''), resolution)
            else resolution
          end
      where id = ticket;
  elsif action = 'assign' then
    if me.role <> 'admin' or not public.admin_can('tickets') then
      raise exception 'التعيين لمدير النظام.';
    end if;
    if coalesce(payload->>'technician_id', '') = '' then
      raise exception 'اختر الفني.';
    end if;
    if row.status in ('منجزة', 'مغلقة', 'ملغاة') then
      raise exception 'لا يُعيَّن فني على بلاغ منتهٍ.';
    end if;
    update public.tickets
      set assigned_technician = payload->>'technician_id',
          status = case when status = 'مفتوحة' then 'قيد المعالجة' else status end
      where id = ticket;
  elsif action = 'priority' then
    if not staff then
      raise exception 'تعديل الأهمية للفني أو لمدير النظام.';
    end if;
    update public.tickets
      set priority = payload->>'priority',
          priority_reason = case
            when payload->>'priority' = 'عاجل' then coalesce(nullif(reason, ''), priority_reason)
            else priority_reason
          end
      where id = ticket;
    insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
    values (ticket, actor, row.status, row.status, 'الأهمية: ' || coalesce(payload->>'priority', ''));
  elsif action = 'fault' then
    if not staff then
      raise exception 'تعديل نوع العطل للفني أو لمدير النظام.';
    end if;
    update public.tickets set fault_type = payload->>'fault_type' where id = ticket;
    insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
    values (ticket, actor, row.status, row.status, 'نوع العطل: ' || coalesce(payload->>'fault_type', ''));
  elsif action = 'note' then
    if not staff then
      raise exception 'الملاحظة الداخلية للفني ومدير النظام.';
    end if;
    if length(btrim(coalesce(payload->>'body', ''))) < 2 then
      raise exception 'اكتب الملاحظة.';
    end if;
    insert into public.ticket_notes (ticket_id, author_name, body)
    values (ticket, coalesce(me.full_name, 'فني'), btrim(payload->>'body'));
    insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
    values (ticket, actor, row.status, row.status, 'ملاحظة داخلية');
  else
    raise exception 'إجراء غير معروف.';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

select 'sanad-source' as result;
