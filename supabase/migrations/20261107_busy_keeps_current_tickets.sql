-- A busy technician keeps tickets already assigned, and does not receive new ones.

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
        if me.availability = 'مشغول' and coalesce(old.assigned_technician, '') <> me.id::text and new.status <> 'مفتوحة' then
          raise exception 'حالتك مشغول. البلاغات التي بيديك تبقى، والجديدة لا تُسند إليك.';
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
      if not staff then
        raise exception 'التعيين لمدير النظام.';
      end if;
      if tech then
        if new.assigned_technician <> me.id::text then
          raise exception 'الفني يستلم البلاغ لنفسه فقط.';
        end if;
        if old.assigned_technician is not null then
          raise exception 'البلاغ مع فني آخر. مدير النظام يعيد تعيينه.';
        end if;
        if new.status is not distinct from old.status then
          raise exception 'الاستلام يكون من زر «استلام البلاغ».';
        end if;
      elsif not public.admin_can('tickets') then
        raise exception 'لا تملك صلاحية البلاغات.';
      end if;
      if not exists (
        select 1 from public.profiles t
        where t.id::text = new.assigned_technician
          and t.role in ('technician', 'manager')
          and t.availability = 'متاح'
      ) then
        raise exception 'لا يُسنَد بلاغ جديد إلا لفني حالته «متاح».';
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

