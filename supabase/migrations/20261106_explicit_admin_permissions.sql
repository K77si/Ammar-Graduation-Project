-- Null permissions used to mean every permission. That stays true only for the owner.
-- Any other admin with a null list is given the full explicit list first, so nobody loses access,
-- then a null list no longer grants anything.

update public.profiles
set admin_permissions = array[
  'overview',
  'tickets',
  'users',
  'approvals',
  'analytics',
  'settings',
  'delete_users',
  'reset_password'
]
where role = 'admin'
  and is_owner = false
  and admin_permissions is null;

create or replace function public.admin_can(permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and (
        is_owner
        or (admin_permissions is not null and permission = any (admin_permissions))
      )
  );
$$;
