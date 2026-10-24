-- Unique 9-digit employee numbers used for login and display.

create or replace function public.allocate_employee_number()
returns text
language plpgsql
as $function$
declare
  candidate text;
begin
  loop
    candidate := (100000000 + floor(random() * 900000000))::bigint::text;
    exit when not exists (
      select 1 from public.profiles where employee_number = candidate
    );
  end loop;
  return candidate;
end;
$function$;

create or replace function public.set_employee_number()
returns trigger
language plpgsql
as $function$
begin
  if new.employee_number is null or length(btrim(new.employee_number)) = 0 then
    new.employee_number := public.allocate_employee_number();
  end if;
  return new;
end;
$function$;

alter table public.profiles add column if not exists employee_number text;

do $fill$
declare
  person record;
begin
  for person in
    select id from public.profiles
    where employee_number is null or length(btrim(employee_number)) = 0
  loop
    update public.profiles
    set employee_number = public.allocate_employee_number()
    where id = person.id;
  end loop;
end;
$fill$;

alter table public.profiles alter column employee_number set not null;

create unique index if not exists profiles_employee_number_key
  on public.profiles (employee_number);

drop trigger if exists profiles_set_employee_number on public.profiles;
create trigger profiles_set_employee_number
  before insert on public.profiles
  for each row
  execute function public.set_employee_number();

select 'employee-numbers' as result;
