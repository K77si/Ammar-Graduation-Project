-- Rating save, no default password, Arabic departments, and a real password-change setting.

alter table public.system_settings
  add column if not exists force_password_change boolean not null default true;

create or replace function public.rate_own_ticket(ticket_id uuid, new_rating integer)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  updated integer;
begin
  if new_rating < 1 or new_rating > 5 then
    raise exception 'التقييم يجب أن يكون بين 1 و 5';
  end if;

  update public.tickets
  set rating = new_rating
  where id = ticket_id
    and user_id = auth.uid()
    and status in ('منجزة', 'مغلقة');

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'يُتاح التقييم بعد إنجاز البلاغ أو إغلاقه، ولصاحب البلاغ فقط';
  end if;
  return new_rating;
end;
$function$;

grant execute on function public.rate_own_ticket(uuid, integer) to authenticated;

create or replace function public.sync_profile_to_auth()
returns trigger
language plpgsql
security definer
as $function$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from auth.users where id = new.id)
       and new.temp_password is not null
       and length(btrim(new.temp_password)) > 0 then
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000',
        new.id,
        'authenticated',
        'authenticated',
        new.email,
        crypt(new.temp_password, gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}',
        '{}',
        now(),
        now()
      );
    end if;
  elsif tg_op = 'UPDATE' then
    if new.temp_password is not null
       and new.temp_password is distinct from old.temp_password
       and length(btrim(new.temp_password)) > 0 then
      update auth.users
      set encrypted_password = crypt(new.temp_password, gen_salt('bf')),
          updated_at = now()
      where id = new.id;
    end if;
  end if;
  return new;
end;
$function$;

update public.profiles
set department = case lower(btrim(department))
  when 'hr' then 'الموارد البشرية'
  when 'human resources' then 'الموارد البشرية'
  when 'finance' then 'المالية'
  when 'it' then 'الدعم التقني (IT)'
  when 'information technology' then 'الدعم التقني (IT)'
  when 'operations' then 'العمليات'
  when 'marketing' then 'التسويق'
  else department
end
where lower(btrim(department)) in (
  'hr', 'human resources', 'finance', 'it', 'information technology', 'operations', 'marketing'
);

select 'platform-fixes' as result;
