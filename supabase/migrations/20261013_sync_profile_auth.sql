-- Profile insert must not fail when the login account already exists.
-- The app creates the Auth user first, then the profile row.

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
       and length(new.temp_password) > 0 then
      update auth.users
      set encrypted_password = crypt(new.temp_password, gen_salt('bf')),
          updated_at = now()
      where id = new.id;
    end if;
  end if;
  return new;
end;
$function$;
