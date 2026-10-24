-- Every ticket goes to technical support. The requester's department is kept
-- on the ticket so the department head can follow it.

update public.system_settings
set departments = array['الدعم التقني', 'الموارد البشرية', 'المالية', 'الإدارة', 'العمليات', 'التسويق']
where id = 'main_settings' and (departments is null or cardinality(departments) = 0);

revoke execute on function public.my_profile() from authenticated;

create or replace function public.guard_new_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  existing bigint;
begin
  if auth.uid() is null then
    return new;
  end if;
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'الحساب غير موجود.';
  end if;
  if me.is_approved is false then
    raise exception 'الحساب بانتظار الاعتماد.';
  end if;
  if new.user_id is distinct from me.id then
    raise exception 'البلاغ يُفتح باسم صاحبه فقط.';
  end if;
  if length(btrim(coalesce(new.title, ''))) < 5 then
    raise exception 'اكتب وصف المشكلة في 5 أحرف على الأقل.';
  end if;

  new.title := btrim(new.title);
  new.status := 'مفتوحة';
  new.assigned_technician := null;
  new.resolution := null;
  new.rating := null;
  new.rating_reason := null;
  new.cancel_reason := null;
  new.resolved_at := null;
  new.closed_at := null;
  new.department := 'الدعم التقني';
  new.affected_department := me.department;
  new.site_place := nullif(btrim(coalesce(new.site_place, '')), '');
  new.device_number := nullif(btrim(coalesce(new.device_number, '')), '');
  new.priority := case when new.priority = 'عاجل' then 'عاجل' else 'عادي' end;

  if new.is_outage then
    if me.role <> 'department_head' then
      raise exception 'بلاغ القسم يفتحه رئيس القسم فقط.';
    end if;
    if me.department is null then
      raise exception 'حدد قسمك قبل فتح بلاغ قسم.';
    end if;
    select ticket_number into existing
    from public.tickets
    where is_outage
      and affected_department = me.department
      and status in ('مفتوحة', 'قيد المعالجة', 'بانتظار الموظف')
    limit 1;
    if existing is not null then
      raise exception 'يوجد بلاغ قسم مفتوح لقسمك برقم #%. تابعه بدل فتح بلاغ جديد.', existing;
    end if;
    new.is_private := false;
    new.priority := 'عاجل';
    new.priority_reason := coalesce(nullif(btrim(coalesce(new.priority_reason, '')), ''), 'القسم متعطل');
    new.fault_type := coalesce(nullif(btrim(coalesce(new.fault_type, '')), ''), 'شبكة');
  else
    new.is_outage := false;
    if new.priority = 'عاجل' and length(btrim(coalesce(new.priority_reason, ''))) < 3 then
      raise exception 'البلاغ العاجل يحتاج سبب وقوف الشغل.';
    end if;
    if new.priority = 'عادي' then
      new.priority_reason := null;
    end if;
  end if;

  if coalesce(new.fault_type, '') not in ('طابعة', 'شبكة', 'حساب', 'جهاز', 'برامج', 'أخرى') then
    raise exception 'اختر نوع العطل.';
  end if;
  return new;
end;
$$;

create or replace function public.guard_ticket_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  actor text := 'النظام';
  staff boolean := false;
  tech boolean := false;
  event_note text;
begin
  if auth.uid() is null then
    return new;
  end if;

  select * into me from public.profiles where id = auth.uid();
  if me.id is not null then
    actor := coalesce(me.full_name, 'مستخدم');
  end if;
  tech := coalesce(me.role in ('technician', 'manager'), false);
  staff := tech or coalesce(me.role = 'admin', false);

  if new.user_id is distinct from old.user_id
     or new.title is distinct from old.title
     or new.is_outage is distinct from old.is_outage
     or new.is_private is distinct from old.is_private
     or new.affected_department is distinct from old.affected_department
     or new.department is distinct from old.department
     or new.created_at is distinct from old.created_at
     or new.ticket_number is distinct from old.ticket_number then
    raise exception 'بيانات البلاغ الأساسية لا تتغير بعد إرساله.';
  end if;

  if (new.rating is distinct from old.rating or new.rating_reason is distinct from old.rating_reason)
     and auth.uid() is distinct from old.user_id then
    raise exception 'التقييم لصاحب البلاغ فقط.';
  end if;

  if new.fault_type is distinct from old.fault_type
     or new.site_place is distinct from old.site_place
     or new.device_number is distinct from old.device_number then
    if not staff then
      raise exception 'تعديل نوع العطل للفني أو لمدير النظام.';
    end if;
    if coalesce(new.fault_type, '') not in ('طابعة', 'شبكة', 'حساب', 'جهاز', 'برامج', 'أخرى') then
      raise exception 'نوع العطل غير معروف.';
    end if;
  end if;

  if new.priority is distinct from old.priority or new.priority_reason is distinct from old.priority_reason then
    if not staff then
      raise exception 'تعديل الأهمية للفني أو لمدير النظام.';
    end if;
    if new.priority = 'عاجل' and length(btrim(coalesce(new.priority_reason, ''))) < 3 then
      raise exception 'العاجل يحتاج سبباً.';
    end if;
  end if;

  if new.resolution is distinct from old.resolution and not staff then
    raise exception 'الحل يكتبه الفني.';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'ملغاة' then
      raise exception 'البلاغ الملغى لا يعود للعمل.';
    end if;

    if new.status = 'مغلقة' and old.status = 'منجزة'
       and old.resolved_at is not null and old.resolved_at < now() - interval '3 days' then
      new.closed_at := now();
      actor := 'إغلاق تلقائي بعد 3 أيام';
    elsif new.status = 'ملغاة' then
      if old.status <> 'مفتوحة' or old.assigned_technician is not null
         or auth.uid() is distinct from old.user_id
         or length(btrim(coalesce(new.cancel_reason, ''))) < 3 then
        raise exception 'الإلغاء لصاحب البلاغ وهو مفتوح ولم يستلمه فني، مع سبب قصير.';
      end if;
    elsif auth.uid() = old.user_id and not staff then
      if new.status = 'مغلقة' and old.status = 'منجزة' then
        new.closed_at := now();
      elsif new.status = 'مفتوحة' and old.status in ('منجزة', 'مغلقة')
        and coalesce(old.resolved_at, old.closed_at, old.created_at) > now() - interval '7 days' then
        new.assigned_technician := null;
        new.resolved_at := null;
        new.closed_at := null;
        new.rating := null;
        new.rating_reason := null;
      elsif new.status = 'مفتوحة' and old.status in ('منجزة', 'مغلقة') then
        raise exception 'مرّت 7 أيام على الإنجاز. افتح بلاغاً جديداً.';
      elsif new.status = 'قيد المعالجة' and old.status = 'بانتظار الموظف' then
        null;
      else
        raise exception 'تغيير الحالة للفني أو لمدير النظام.';
      end if;
    elsif staff then
      if old.status = 'مغلقة' then
        raise exception 'البلاغ مغلق. صاحبه فقط يعيد فتحه خلال 7 أيام.';
      end if;
      if tech then
        if me.availability = 'خارج الدوام' and new.status <> 'مفتوحة' then
          raise exception 'حالتك خارج الدوام. غيّرها قبل العمل على البلاغ.';
        end if;
        if old.assigned_technician is not null and old.assigned_technician <> me.id::text then
          raise exception 'البلاغ مع فني آخر. مدير النظام يعيد تعيينه.';
        end if;
      elsif not public.admin_can('tickets') then
        raise exception 'لا تملك صلاحية البلاغات.';
      end if;

      if new.status = 'مغلقة' and old.status <> 'منجزة' then
        raise exception 'الإغلاق يكون بعد الإنجاز.';
      end if;
      if new.status = 'منجزة' then
        if length(btrim(coalesce(new.resolution, ''))) < 3 then
          raise exception 'اكتب الحل قبل جعل البلاغ منجزاً.';
        end if;
        new.resolution := btrim(new.resolution);
        new.resolved_at := now();
      elsif new.status = 'مغلقة' then
        new.closed_at := now();
      else
        new.resolved_at := null;
        new.closed_at := null;
      end if;
      if new.status = 'مفتوحة' then
        new.assigned_technician := null;
      elsif coalesce(new.assigned_technician, old.assigned_technician) is null then
        if tech then
          new.assigned_technician := me.id::text;
        else
          raise exception 'عيّن فنياً قبل تغيير الحالة.';
        end if;
      end if;
    else
      raise exception 'تغيير الحالة للفني أو لمدير النظام.';
    end if;

    event_note := case
      when new.status = 'منجزة' then new.resolution
      when new.status = 'ملغاة' then new.cancel_reason
      else null
    end;
    insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
    values (old.id, actor, old.status, new.status, event_note);
  elsif new.resolved_at is distinct from old.resolved_at or new.closed_at is distinct from old.closed_at then
    raise exception 'أوقات الإنجاز تتغير مع الحالة فقط.';
  end if;

  if new.assigned_technician is distinct from old.assigned_technician then
    if new.assigned_technician is not null then
      if not exists (
        select 1 from public.profiles t
        where t.id::text = new.assigned_technician
          and t.role in ('technician', 'manager')
          and t.availability <> 'خارج الدوام'
      ) then
        raise exception 'التعيين لفني متاح أو مشغول، وليس خارج الدوام.';
      end if;
      if tech and new.assigned_technician <> me.id::text then
        raise exception 'الفني يستلم البلاغ لنفسه فقط.';
      end if;
      if not staff then
        raise exception 'التعيين لمدير النظام.';
      end if;
      if not tech and not public.admin_can('tickets') then
        raise exception 'لا تملك صلاحية البلاغات.';
      end if;
      insert into public.ticket_events (ticket_id, actor_name, from_status, to_status, note)
      values (
        old.id, actor, new.status, new.status,
        'الفني: ' || coalesce((select full_name from public.profiles where id::text = new.assigned_technician), 'فني')
      );
    elsif new.status is not distinct from old.status and coalesce(me.role, '') <> 'admin' then
      raise exception 'إرجاع البلاغ للطابور يكون بتغيير حالته إلى مفتوحة.';
    end if;
  end if;

  return new;
end;
$$;

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
begin
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
  elsif action = 'fault' then
    if not staff then
      raise exception 'تعديل نوع العطل للفني أو لمدير النظام.';
    end if;
    update public.tickets set fault_type = payload->>'fault_type' where id = ticket;
  elsif action = 'note' then
    if not staff then
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

create or replace function public.guard_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  select status into current_status from public.tickets where id = new.ticket_id;
  if current_status in ('مغلقة', 'ملغاة') then
    raise exception 'البلاغ %. أعد فتحه إذا رجعت المشكلة.', current_status;
  end if;
  if length(btrim(coalesce(new.message, ''))) < 1 then
    raise exception 'اكتب الرد.';
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_replies_guard on public.ticket_replies;
create trigger ticket_replies_guard
  before insert on public.ticket_replies
  for each row
  execute function public.guard_ticket_reply();

create or replace function public.resume_after_owner_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tickets
  set status = 'قيد المعالجة'
  where id = new.ticket_id
    and status = 'بانتظار الموظف'
    and user_id = auth.uid();
  return new;
end;
$$;

drop trigger if exists ticket_replies_resume on public.ticket_replies;
create trigger ticket_replies_resume
  after insert on public.ticket_replies
  for each row
  execute function public.resume_after_owner_reply();

select 'single-queue' as result;
