-- Link the designated couple account to the existing UID-based authorization
-- table. Frontend access continues to depend on auth.uid() and admins RLS.
create or replace function wedding_private.sync_designated_couple_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  couple_user_id uuid;
begin
  if tg_table_schema = 'auth' and tg_table_name = 'users' then
    if lower(new.email) = 'kamifit4chief@gmail.com' and new.email_confirmed_at is not null then
      insert into public.admins(user_id, wedding_id, role)
      select new.id, w.id, 'owner'
      from public.weddings w
      on conflict (user_id, wedding_id) do update set role = 'owner';
    elsif tg_op = 'UPDATE' and lower(old.email) = 'kamifit4chief@gmail.com' then
      delete from public.admins where user_id = new.id;
    end if;
  elsif tg_table_schema = 'public' and tg_table_name = 'weddings' then
    select u.id into couple_user_id
    from auth.users u
    where lower(u.email) = 'kamifit4chief@gmail.com'
      and u.email_confirmed_at is not null
    limit 1;
    if couple_user_id is not null then
      insert into public.admins(user_id, wedding_id, role)
      values(couple_user_id, new.id, 'owner')
      on conflict (user_id, wedding_id) do update set role = 'owner';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function wedding_private.sync_designated_couple_admin() from public, anon, authenticated;

-- Provision an already existing, verified Auth account against current weddings.
insert into public.admins(user_id, wedding_id, role)
select u.id, w.id, 'owner'
from auth.users u
cross join public.weddings w
where lower(u.email) = 'kamifit4chief@gmail.com'
  and u.email_confirmed_at is not null
on conflict (user_id, wedding_id) do update set role = 'owner';

drop trigger if exists sync_designated_couple_admin_auth on auth.users;
create trigger sync_designated_couple_admin_auth
after insert or update on auth.users
for each row execute function wedding_private.sync_designated_couple_admin();

drop trigger if exists sync_designated_couple_admin_wedding on public.weddings;
create trigger sync_designated_couple_admin_wedding
after insert on public.weddings
for each row execute function wedding_private.sync_designated_couple_admin();
