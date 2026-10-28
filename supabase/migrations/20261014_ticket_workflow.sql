-- Ticket workflow: priority, outage, private, history, notes, FAQ, templates.

alter table public.tickets add column if not exists priority text not null default 'عادي';
alter table public.tickets add column if not exists priority_reason text;
alter table public.tickets add column if not exists site_place text;
alter table public.tickets add column if not exists device_number text;
alter table public.tickets add column if not exists fault_type text;
alter table public.tickets add column if not exists resolution text;
alter table public.tickets add column if not exists rating_reason text;
alter table public.tickets add column if not exists is_private boolean not null default false;
alter table public.tickets add column if not exists is_outage boolean not null default false;
alter table public.tickets add column if not exists affected_department text;
alter table public.tickets add column if not exists cancel_reason text;
alter table public.tickets add column if not exists resolved_at timestamptz;
alter table public.tickets add column if not exists closed_at timestamptz;

alter table public.profiles add column if not exists availability text not null default 'متاح';
alter table public.system_settings add column if not exists departments text[];

update public.system_settings
set departments = array['الدعم التقني', 'الموارد البشرية', 'المالية', 'الإدارة', 'العمليات', 'التسويق']
where id = 'main_settings' and (departments is null or cardinality(departments) = 0);

do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.tickets'::regclass
      and c.contype = 'c'
      and a.attname = 'status'
  loop
    execute format('alter table public.tickets drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check
  check (status in ('مفتوحة', 'قيد المعالجة', 'بانتظار الموظف', 'منجزة', 'مغلقة', 'ملغاة'));

alter table public.tickets drop constraint if exists tickets_priority_check;
alter table public.tickets add constraint tickets_priority_check
  check (priority in ('عادي', 'عاجل'));

alter table public.profiles drop constraint if exists profiles_availability_check;
alter table public.profiles add constraint profiles_availability_check
  check (availability in ('متاح', 'مشغول', 'خارج الدوام'));

create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  actor_name text not null default 'النظام',
  from_status text,
  to_status text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.faq_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  sort_order integer not null default 0
);

create table if not exists public.reply_templates (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  sort_order integer not null default 0
);

insert into public.faq_items (title, body, sort_order)
select * from (values
  ('الطابعة لا تطبع', 'تأكد من تشغيل الطابعة ومن الورق، ثم أعد تشغيلها. إذا استمر العطل افتح بلاغاً وجهته الدعم التقني ونوعه طابعة.', 1),
  ('لا أستطيع الدخول', 'تأكد من البريد أو رقم الموظف ومن كلمة المرور. إذا كان الحساب بانتظار الاعتماد لن يفتح حتى يوافق مدير النظام.', 2),
  ('الشبكة قاطعة على القسم', 'إذا كان العطل على القسم كله، يفتحه رئيس القسم كبلاغ قسم ويصل للدعم التقني عاجلاً.', 3)
) as seed(title, body, sort_order)
where not exists (select 1 from public.faq_items);

insert into public.reply_templates (body, sort_order)
select * from (values
  ('أعد تشغيل الجهاز ثم أخبرنا بالنتيجة.', 1),
  ('نحتاج رقم الجهاز ومكان المكتب لإكمال المعالجة.', 2),
  ('تم حل المشكلة. جرّبها من فضلك ثم أكّد الإغلاق.', 3)
) as seed(body, sort_order)
where not exists (select 1 from public.reply_templates);

create or replace function public.is_tech_department(dept text)
returns boolean
language sql
immutable
as $$
  select lower(btrim(coalesce(dept, ''))) in ('الدعم التقني', 'الدعم التقني (it)', 'تقنية المعلومات', 'it', 'information technology');
$$;

create or replace function public.my_profile()
returns public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profiles where id = auth.uid();
$$;

revoke all on function public.my_profile() from public;
grant execute on function public.my_profile() to authenticated;

create or replace function public.can_view_ticket(
  owner_id uuid,
  dept text,
  affected text,
  private_ticket boolean,
  outage boolean
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and (
        me.role = 'admin'
        or owner_id = me.id
        or (
          me.role in ('technician', 'manager')
          and public.is_tech_department(dept)
        )
        or (
          outage
          and not private_ticket
          and me.department is not null
          and me.department = affected
        )
        or (
          me.role = 'department_head'
          and not private_ticket
          and me.department is not null
          and (
            dept = me.department
            or affected = me.department
            or exists (
              select 1 from public.profiles owner
              where owner.id = owner_id and owner.department = me.department
            )
          )
        )
      )
  );
$$;

revoke all on function public.can_view_ticket(uuid, text, text, boolean, boolean) from public;
grant execute on function public.can_view_ticket(uuid, text, text, boolean, boolean) to authenticated;

create or replace function public.guard_availability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.availability is distinct from old.availability then
    if auth.uid() is distinct from old.id and not public.admin_can('users') and coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'لا يمكن تغيير حالة الفني.';
    end if;
  end if;
  if new.role not in ('technician', 'manager') then
    new.availability := 'متاح';
  end if;
  if new.availability not in ('متاح', 'مشغول', 'خارج الدوام') then
    new.availability := 'متاح';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_availability on public.profiles;
create trigger profiles_guard_availability
  before insert or update on public.profiles
  for each row
  execute function public.guard_availability();

create or replace function public.guard_new_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  allowed text[];
begin
  if auth.uid() is null then
    return new;
  end if;
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'الحساب غير موجود.';
  end if;
  if new.user_id is distinct from me.id then
    raise exception 'البلاغ يُفتح باسم صاحبه فقط.';
  end if;
  new.status := 'مفتوحة';
  new.priority := case when new.priority = 'عاجل' then 'عاجل' else 'عادي' end;
  if new.priority = 'عاجل' and length(btrim(coalesce(new.priority_reason, ''))) < 3 and not new.is_outage then
    raise exception 'بلاغ العاجل يحتاج سبب وقوف الشغل.';
  end if;

  select departments into allowed from public.system_settings where id = 'main_settings';
  if allowed is null or cardinality(allowed) = 0 then
    allowed := array['الدعم التقني', 'الموارد البشرية', 'المالية', 'الإدارة', 'العمليات', 'التسويق'];
  end if;

  if new.is_outage then
    if me.role <> 'department_head' then
      raise exception 'بلاغ القسم يفتحه رئيس القسم فقط.';
    end if;
    new.is_private := false;
    new.priority := 'عاجل';
    new.priority_reason := coalesce(nullif(btrim(coalesce(new.priority_reason, '')), ''), 'القسم متعطل');
    new.affected_department := me.department;
    new.department := 'الدعم التقني';
    new.fault_type := coalesce(nullif(btrim(coalesce(new.fault_type, '')), ''), 'شبكة');
  elsif new.is_private then
    new.department := 'الدعم التقني';
  end if;

  if not (new.department = any (allowed)) and not public.is_tech_department(new.department) then
    raise exception 'وجهة البلاغ غير معروفة.';
  end if;
  if public.is_tech_department(new.department) then
    new.department := 'الدعم التقني';
    if coalesce(new.fault_type, '') not in ('طابعة', 'شبكة', 'حساب', 'جهاز') then
      raise exception 'اختر نوع العطل: طابعة أو شبكة أو حساب أو جهاز.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_guard_new on public.tickets;
create trigger tickets_guard_new
  before insert on public.tickets
  for each row
  execute function public.guard_new_ticket();

create or replace function public.guard_ticket_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  actor text := 'النظام';
begin
  if new.status is not distinct from old.status
     and new.department is not distinct from old.department
     and new.priority is not distinct from old.priority
     and new.assigned_technician is not distinct from old.assigned_technician
     and new.resolution is not distinct from old.resolution then
    return new;
  end if;

  select * into me from public.profiles where id = auth.uid();
  if me.id is not null then
    actor := coalesce(me.full_name, 'مستخدم');
  end if;

  if new.status is distinct from old.status then
    if new.status = 'مغلقة' and old.status = 'منجزة' and old.resolved_at is not null and old.resolved_at < now() - interval '3 days' then
      new.closed_at := coalesce(new.closed_at, now());
    elsif new.status = 'ملغاة' then
      if old.status <> 'مفتوحة' or auth.uid() is distinct from old.user_id or length(btrim(coalesce(new.cancel_reason, ''))) < 3 then
        raise exception 'الإلغاء لصاحب البلاغ، والحالة مفتوحة، مع سبب قصير.';
      end if;
    elsif new.status = 'مغلقة' and old.status = 'منجزة' and auth.uid() = old.user_id then
      new.closed_at := now();
    elsif new.status = 'مفتوحة' and old.status in ('منجزة', 'مغلقة') and auth.uid() = old.user_id
      and coalesce(old.resolved_at, old.closed_at, old.created_at) > now() - interval '7 days' then
      new.assigned_technician := null;
      new.resolved_at := null;
      new.closed_at := null;
    elsif me.role = 'admin' or (me.role in ('technician', 'manager') and public.is_tech_department(old.department)) then
      if me.role in ('technician', 'manager') and me.availability = 'خارج الدوام' and new.status <> old.status and new.status <> 'مفتوحة' then
        raise exception 'حالتك خارج الدوام. غيّرها قبل أخذ البلاغ.';
      end if;
      if new.status = 'منجزة' and length(btrim(coalesce(new.resolution, old.resolution, ''))) < 3 then
        raise exception 'اكتب الحل قبل جعل البلاغ منجزاً.';
      end if;
      if new.status = 'منجزة' then
        new.resolution := btrim(coalesce(new.resolution, old.resolution));
        new.resolved_at := coalesce(old.resolved_at, now());
      end if;
      if new.status = 'قيد المعالجة' and coalesce(new.assigned_technician, old.assigned_technician) is null then
        new.assigned_technician := me.id::text;
      end if;
      if new.status = 'مفتوحة' then
        new.assigned_technician := null;
      end if;
      if new.status = 'مغلقة' and old.status <> 'منجزة' then
        raise exception 'الإغلاق يكون بعد الإنجاز، أو بتأكيد صاحب البلاغ.';
      end if;
    else
      raise exception 'تغيير الحالة للفني أو لمدير النظام.';
    end if;

    insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
    values (old.id, actor, old.status, new.status, nullif(btrim(coalesce(new.resolution, new.cancel_reason, '')), ''));
  end if;

  if new.priority is distinct from old.priority and auth.uid() is not null then
    if me.role not in ('admin', 'technician', 'manager') then
      raise exception 'تعديل الأهمية للفني أو لمدير النظام.';
    end if;
    if new.priority = 'عاجل' and length(btrim(coalesce(new.priority_reason, ''))) < 3 then
      raise exception 'العاجل يحتاج سبباً.';
    end if;
  end if;

  if new.department is distinct from old.department and coalesce(me.role, '') <> 'admin' and auth.uid() is not null then
    raise exception 'تحويل الوجهة لمدير النظام.';
  end if;

  if new.assigned_technician is distinct from old.assigned_technician and auth.uid() is not null and me.role = 'admin' then
    if new.assigned_technician is not null and exists (
      select 1 from public.profiles tech
      where tech.id::text = new.assigned_technician
        and (tech.role not in ('technician', 'manager') or tech.availability = 'خارج الدوام')
    ) then
      raise exception 'التعيين لفني متاح أو مشغول، وليس خارج الدوام.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tickets_guard_transition on public.tickets;
create trigger tickets_guard_transition
  before update on public.tickets
  for each row
  execute function public.guard_ticket_transition();

create or replace function public.ticket_action(ticket uuid, action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.tickets;
  me public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'يلزم تسجيل الدخول.';
  end if;
  if me.must_change_password is true then
    raise exception 'يجب تغيير كلمة المرور قبل استخدام سند.';
  end if;
  select * into row from public.tickets where id = ticket;
  if row.id is null then
    raise exception 'البلاغ غير موجود.';
  end if;
  if not public.can_view_ticket(row.user_id, row.department, row.affected_department, row.is_private, row.is_outage)
     and me.role <> 'admin' then
    raise exception 'البلاغ غير متاح.';
  end if;
  if action in ('assign', 'transfer', 'status', 'priority') and row.status = 'ملغاة' then
    raise exception 'البلاغ الملغى لا يُعاد للعمل.';
  end if;
  if action = 'transfer' and row.status = 'مغلقة' then
    raise exception 'لا يُحوَّل بلاغ مغلق.';
  end if;

  if action = 'cancel' then
    update public.tickets set status = 'ملغاة', cancel_reason = payload->>'reason' where id = ticket;
  elsif action = 'confirm' then
    update public.tickets set status = 'مغلقة' where id = ticket;
  elsif action = 'reopen' then
    update public.tickets set status = 'مفتوحة' where id = ticket;
  elsif action = 'status' then
    update public.tickets
      set status = payload->>'status',
          resolution = coalesce(nullif(payload->>'resolution', ''), resolution)
      where id = ticket;
  elsif action = 'assign' then
    update public.tickets
      set assigned_technician = payload->>'technician_id',
          status = case when status = 'مفتوحة' then 'قيد المعالجة' else status end
      where id = ticket;
  elsif action = 'transfer' then
    update public.tickets
      set department = payload->>'department',
          fault_type = coalesce(nullif(payload->>'fault_type', ''), fault_type, 'جهاز')
      where id = ticket;
  elsif action = 'priority' then
    update public.tickets
      set priority = payload->>'priority',
          priority_reason = coalesce(nullif(payload->>'reason', ''), priority_reason)
      where id = ticket;
  elsif action = 'note' then
    if me.role not in ('admin', 'technician', 'manager') then
      raise exception 'الملاحظة الداخلية للفني ومدير النظام.';
    end if;
    if length(btrim(coalesce(payload->>'body', ''))) < 2 then
      raise exception 'اكتب الملاحظة.';
    end if;
    insert into public.ticket_notes (ticket_id, author_name, body)
    values (ticket, coalesce(me.full_name, 'فني'), btrim(payload->>'body'));
  else
    raise exception 'إجراء غير معروف.';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.ticket_action(uuid, text, jsonb) from public;
grant execute on function public.ticket_action(uuid, text, jsonb) to authenticated;

create or replace function public.close_stale_tickets()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  update public.tickets
  set status = 'مغلقة', closed_at = now()
  where status = 'منجزة'
    and resolved_at is not null
    and resolved_at < now() - interval '3 days';
  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.close_stale_tickets() from public;
grant execute on function public.close_stale_tickets() to authenticated;

create or replace function public.rate_ticket(ticket_id uuid, new_rating integer, reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  if new_rating < 1 or new_rating > 5 then
    raise exception 'التقييم يجب أن يكون بين 1 و 5';
  end if;
  if length(btrim(coalesce(reason, ''))) < 2 then
    raise exception 'اكتب سبب التقييم.';
  end if;
  update public.tickets
  set rating = new_rating, rating_reason = btrim(reason)
  where id = ticket_id
    and user_id = auth.uid()
    and status in ('منجزة', 'مغلقة');
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'يُتاح التقييم بعد إنجاز البلاغ أو إغلاقه، ولصاحب البلاغ فقط';
  end if;
  return new_rating;
end;
$$;

revoke all on function public.rate_ticket(uuid, integer, text) from public;
grant execute on function public.rate_ticket(uuid, integer, text) to authenticated;

do $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'tickets'
  loop
    execute format('drop policy if exists %I on public.tickets', r.policyname);
  end loop;
end $$;

create policy tickets_select_visible on public.tickets
  for select to authenticated
  using (public.can_view_ticket(user_id, department, affected_department, is_private, is_outage));

create policy tickets_insert_own on public.tickets
  for insert to authenticated
  with check (user_id = auth.uid());

create policy tickets_update_staff on public.tickets
  for update to authenticated
  using (
    exists (
      select 1 from public.profiles me
      where me.id = auth.uid()
        and (
          me.role = 'admin'
          or (me.role in ('technician', 'manager') and public.is_tech_department(tickets.department))
        )
    )
  )
  with check (
    exists (
      select 1 from public.profiles me
      where me.id = auth.uid()
        and (
          me.role = 'admin'
          or (me.role in ('technician', 'manager') and public.is_tech_department(tickets.department))
        )
    )
  );

create policy tickets_delete_closed on public.tickets
  for delete to authenticated
  using (status = 'مغلقة' and public.is_helpdesk_staff());

drop policy if exists ticket_replies_insert on public.ticket_replies;
create policy ticket_replies_insert on public.ticket_replies
  for insert to authenticated
  with check (
    exists (
      select 1 from public.tickets t
      join public.profiles me on me.id = auth.uid()
      where t.id = ticket_id
        and (
          t.user_id = me.id
          or me.role = 'admin'
          or (me.role in ('technician', 'manager') and public.is_tech_department(t.department))
        )
    )
  );

alter table public.ticket_events enable row level security;
alter table public.ticket_notes enable row level security;
alter table public.faq_items enable row level security;
alter table public.reply_templates enable row level security;

drop policy if exists ticket_events_select on public.ticket_events;
create policy ticket_events_select on public.ticket_events
  for select to authenticated
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_id
        and public.can_view_ticket(t.user_id, t.department, t.affected_department, t.is_private, t.is_outage)
    )
  );

drop policy if exists ticket_notes_select on public.ticket_notes;
create policy ticket_notes_select on public.ticket_notes
  for select to authenticated
  using (public.is_helpdesk_staff());

drop policy if exists faq_select on public.faq_items;
create policy faq_select on public.faq_items
  for select to authenticated
  using (true);

drop policy if exists faq_write on public.faq_items;
create policy faq_write on public.faq_items
  for all to authenticated
  using (public.admin_can('settings'))
  with check (public.admin_can('settings'));

drop policy if exists templates_select on public.reply_templates;
create policy templates_select on public.reply_templates
  for select to authenticated
  using (public.is_helpdesk_staff() or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists templates_write on public.reply_templates;
create policy templates_write on public.reply_templates
  for all to authenticated
  using (public.admin_can('settings'))
  with check (public.admin_can('settings'));

grant select on public.ticket_events, public.faq_items, public.reply_templates to authenticated;
grant select, insert on public.ticket_notes to authenticated;
grant insert, update, delete on public.faq_items, public.reply_templates to authenticated;

select 'ticket-workflow' as result;
