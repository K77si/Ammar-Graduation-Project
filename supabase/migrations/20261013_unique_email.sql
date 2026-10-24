create unique index if not exists profiles_email_lower_key
  on public.profiles (lower(email));

select 'unique-email' as result;
