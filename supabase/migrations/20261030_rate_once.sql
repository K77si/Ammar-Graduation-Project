-- A ticket owner can rate once. A later change of the same rating is rejected.
-- Reopening still clears the rating so the next cycle can be rated once.

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
  if exists (
    select 1 from public.tickets
    where id = ticket_id and user_id = auth.uid() and rating is not null
  ) then
    raise exception 'تم تقييم هذا البلاغ من قبل، ولا يمكن تغييره.';
  end if;
  update public.tickets
  set rating = new_rating, rating_reason = btrim(reason)
  where id = ticket_id
    and user_id = auth.uid()
    and status in ('منجزة', 'مغلقة')
    and rating is null;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'يُتاح التقييم بعد إنجاز البلاغ أو إغلاقه، ولصاحب البلاغ فقط';
  end if;
  return new_rating;
end;
$$;

create or replace function public.guard_rating_once()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.rating is not null
     and new.rating is not null
     and (new.rating is distinct from old.rating or new.rating_reason is distinct from old.rating_reason) then
    raise exception 'تم تقييم هذا البلاغ من قبل، ولا يمكن تغييره.';
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_rating_once on public.tickets;
create trigger tickets_rating_once
before update on public.tickets
for each row execute function public.guard_rating_once();
