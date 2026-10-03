-- Assign the existing designated Auth account to the existing wedding.
-- The unique (user_id, wedding_id) constraint makes this safe to reapply.
do $$
declare
  designated_user_id uuid;
begin
  select u.id
    into designated_user_id
  from auth.users u
  where lower(u.email) = 'kamifit4chief@gmail.com';

  if designated_user_id is null then
    raise exception 'Supabase Auth account kamifit4chief@gmail.com was not found';
  end if;

  insert into public.admins(user_id, wedding_id, role)
  values (
    designated_user_id,
    'acff88e0-e038-4fdc-b3d2-e1777441a940'::uuid,
    'admin'
  )
  on conflict (user_id, wedding_id)
  do update set role = excluded.role;
end;
$$;
