-- The old role name manager is the same job as technician.
update public.profiles
set role = 'technician'
where role = 'manager';
