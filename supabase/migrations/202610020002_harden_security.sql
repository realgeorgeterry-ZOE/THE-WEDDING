-- Phase 1 hardening. Additive migration: preserve 001 and existing records.
-- Apply once after 202610020001_initial.sql. Public guest writes move to the
-- guest-submit Edge Function; direct anon/authenticated table/storage writes close.

create schema if not exists wedding_private;
revoke all on schema wedding_private from public, anon, authenticated;
grant usage on schema wedding_private to anon, authenticated, service_role;

alter table public.weddings add column if not exists guest_upload_enabled boolean not null default true;

create or replace function wedding_private.is_wedding_admin(target uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.wedding_id = target and a.user_id = (select auth.uid())
  );
$$;

create or replace function wedding_private.is_any_wedding_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

revoke all on function wedding_private.is_wedding_admin(uuid) from public;
revoke all on function wedding_private.is_any_wedding_admin() from public;
grant execute on function wedding_private.is_wedding_admin(uuid) to anon, authenticated;
grant execute on function wedding_private.is_any_wedding_admin() to anon, authenticated;

-- Preserve legacy rows. NOT VALID constraints still apply to new and changed
-- rows without requiring migration-time edits to old submissions.
alter table public.photo_submissions alter column uploader_name set default 'Anonymous Guest';
alter table public.photo_submissions alter column uploader_name set not null;
alter table public.photo_submissions add constraint photo_uploader_name_length check (char_length(uploader_name) between 1 and 120) not valid;
alter table public.photo_submissions add constraint photo_caption_length check (caption is null or char_length(caption) <= 300) not valid;
alter table public.photo_submissions add constraint photo_media_type_allowed check (media_type in ('image/jpeg','image/png','image/webp')) not valid;
-- HEIC uploads are not accepted by the hardened guest gateway. Leave this
-- constraint NOT VALID so any pre-existing HEIC rows remain readable; Postgres
-- still enforces it for every new or updated row.
alter table public.message_submissions alter column guest_name set default 'Anonymous Guest';
alter table public.message_submissions alter column guest_name set not null;
alter table public.message_submissions add column if not exists status text not null default 'visible';
alter table public.message_submissions add constraint message_status_allowed check (status in ('visible','hidden')) not valid;
alter table public.photo_submissions add constraint photo_path_matches_wedding check (
  storage_path ~ ('^weddings/' || wedding_id::text || '/photos/[0-9A-Fa-f-]+\.(jpg|png|webp)$') or
  storage_path ~ ('^' || wedding_id::text || '/photos/[0-9A-Fa-f-]+\.(jpg|png|webp)$')
) not valid;
alter table public.photo_submissions add constraint photo_size_gateway_limit check (file_size <= 5242880) not valid;
create index if not exists messages_public_visible_recent on public.message_submissions(wedding_id,created_at desc) where visibility='public' and status='visible';

-- Field-length checks run only when guest-controlled fields change so old
-- records can still be moderated even if they predate these limits.
create or replace function wedding_private.validate_guest_submission()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'photo_submissions' then
    if char_length(new.uploader_name) not between 1 and 120 or (new.caption is not null and char_length(new.caption)>300) then
      raise exception using errcode='22023', message='Photo metadata is too long';
    end if;
    if new.media_type not in ('image/jpeg','image/png','image/webp') or new.file_size>5242880 then
      raise exception using errcode='22023', message='Photo type or size is not allowed';
    end if;
  else
    if char_length(new.guest_name) not between 1 and 120 or char_length(new.message) not between 1 and 1000 then
      raise exception using errcode='22023', message='Message fields exceed the allowed length';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function wedding_private.validate_guest_submission() from public,anon,authenticated;
create trigger validate_photo_submission before insert or update of wedding_id,uploader_name,storage_path,thumbnail_path,caption,media_type,file_size on public.photo_submissions for each row execute function wedding_private.validate_guest_submission();
create trigger validate_message_submission before insert or update of guest_name,message on public.message_submissions for each row execute function wedding_private.validate_guest_submission();

-- Per-IP + per-browser-session rolling-window throttle. Only the Edge Function
-- service role can touch these records or invoke the atomic claim function.
create table if not exists wedding_private.submission_rate_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);
create index if not exists submission_rate_limits_updated on wedding_private.submission_rate_limits(updated_at);
alter table wedding_private.submission_rate_limits enable row level security;
revoke all on wedding_private.submission_rate_limits from public, anon, authenticated;
grant all on wedding_private.submission_rate_limits to service_role;

create or replace function public.claim_wedding_submission_slot(p_key_hash text, p_now timestamptz, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare claimed_count integer;
begin
  insert into wedding_private.submission_rate_limits(key_hash,window_started_at,request_count,updated_at)
  values(p_key_hash,p_now,1,p_now)
  on conflict(key_hash) do update set
    window_started_at = case when wedding_private.submission_rate_limits.window_started_at <= p_now - make_interval(secs => p_window_seconds) then p_now else wedding_private.submission_rate_limits.window_started_at end,
    request_count = case when wedding_private.submission_rate_limits.window_started_at <= p_now - make_interval(secs => p_window_seconds) then 1 else wedding_private.submission_rate_limits.request_count + 1 end,
    updated_at = p_now
  returning request_count into claimed_count;
  delete from wedding_private.submission_rate_limits where updated_at < p_now - interval '2 days';
  return claimed_count <= p_limit;
end;
$$;
revoke all on function public.claim_wedding_submission_slot(text,timestamptz,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_wedding_submission_slot(text,timestamptz,integer,integer) to service_role;

-- Remove broad read rules, then split guests from an authenticated admin session.
drop policy if exists "wedding public read" on public.weddings;
drop policy if exists "wedding admin update" on public.weddings;
create policy "weddings public guest read" on public.weddings for select to anon using (true);
create policy "weddings authenticated scoped read" on public.weddings for select to authenticated using (
  not (select wedding_private.is_any_wedding_admin()) or (select wedding_private.is_wedding_admin(id))
);
create policy "weddings admin scoped update" on public.weddings for update to authenticated
  using ((select wedding_private.is_wedding_admin(id))) with check ((select wedding_private.is_wedding_admin(id)));
create policy "weddings select hard boundary" on public.weddings as restrictive for select to anon,authenticated using (
  (select auth.role())='anon' or not (select wedding_private.is_any_wedding_admin()) or (select wedding_private.is_wedding_admin(id))
);
create policy "weddings update hard boundary" on public.weddings as restrictive for update to authenticated
  using ((select wedding_private.is_wedding_admin(id))) with check ((select wedding_private.is_wedding_admin(id)));

drop policy if exists "photos public read" on public.photo_submissions;
drop policy if exists "photos guest insert" on public.photo_submissions;
drop policy if exists "photos admin delete" on public.photo_submissions;
create policy "photos public guest read" on public.photo_submissions for select to anon using (true);
create policy "photos authenticated scoped read" on public.photo_submissions for select to authenticated using (
  (select wedding_private.is_wedding_admin(wedding_id)) or not (select wedding_private.is_any_wedding_admin())
);
create policy "photos admin scoped delete" on public.photo_submissions for delete to authenticated using ((select wedding_private.is_wedding_admin(wedding_id)));
create policy "photos select hard boundary" on public.photo_submissions as restrictive for select to anon,authenticated using (
  (select auth.role())='anon' or not (select wedding_private.is_any_wedding_admin()) or (select wedding_private.is_wedding_admin(wedding_id))
);
create policy "photos delete hard boundary" on public.photo_submissions as restrictive for delete to authenticated using ((select wedding_private.is_wedding_admin(wedding_id)));

drop policy if exists "messages visible read" on public.message_submissions;
drop policy if exists "messages guest insert" on public.message_submissions;
drop policy if exists "messages admin delete" on public.message_submissions;
create policy "messages public guest read" on public.message_submissions for select to anon using (visibility='public' and status='visible');
create policy "messages authenticated scoped read" on public.message_submissions for select to authenticated using (
  (select wedding_private.is_wedding_admin(wedding_id)) or
  (not (select wedding_private.is_any_wedding_admin()) and visibility='public' and status='visible')
);
create policy "messages admin scoped delete" on public.message_submissions for delete to authenticated using ((select wedding_private.is_wedding_admin(wedding_id)));
create policy "messages admin status update" on public.message_submissions for update to authenticated using ((select wedding_private.is_wedding_admin(wedding_id))) with check ((select wedding_private.is_wedding_admin(wedding_id)));
create policy "messages select hard boundary" on public.message_submissions as restrictive for select to anon,authenticated using (
  ((select auth.role())='anon' and visibility='public' and status='visible') or
  ((select auth.role())='authenticated' and (
    (select wedding_private.is_wedding_admin(wedding_id)) or
    (not (select wedding_private.is_any_wedding_admin()) and visibility='public' and status='visible')
  ))
);
create policy "messages write hard boundary" on public.message_submissions as restrictive for delete to authenticated using ((select wedding_private.is_wedding_admin(wedding_id)));
create policy "messages update hard boundary" on public.message_submissions as restrictive for update to authenticated using ((select wedding_private.is_wedding_admin(wedding_id))) with check ((select wedding_private.is_wedding_admin(wedding_id)));

-- Authenticated admins are wedding-scoped too. Public non-admin users may still
-- read public content across wedding slugs, as the public product requires.
drop policy if exists "admins self read" on public.admins;
create policy "admins self read scoped" on public.admins for select to authenticated using (
  user_id=(select auth.uid()) and (select wedding_private.is_wedding_admin(wedding_id))
);
create policy "admins read hard boundary" on public.admins as restrictive for select to authenticated using (
  user_id=(select auth.uid()) and (select wedding_private.is_wedding_admin(wedding_id))
);

-- Make photo rows available only after the Edge Function has validated and
-- stored bytes. Likewise, guest storage writes now go through that gateway.
drop policy if exists "wedding images guest upload" on storage.objects;
drop policy if exists "wedding images admin delete" on storage.objects;
create policy "wedding images admin scoped delete" on storage.objects for delete to authenticated using (
  bucket_id='wedding-media' and (
    (split_part(name,'/',1)='weddings' and split_part(name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
      (select wedding_private.is_wedding_admin(split_part(name,'/',2)::uuid))) or
    (split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
      (select wedding_private.is_wedding_admin(split_part(name,'/',1)::uuid)))
  )
);
update storage.buckets set file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp'] where id='wedding-media';

-- Uploaded object names are constrained to the weddings/<id>/photos/<uuid>.<ext> form.
drop policy if exists "wedding images public read" on storage.objects;
create policy "wedding images public object lookup" on storage.objects for select to anon,authenticated using (
  bucket_id='wedding-media' and (
    (split_part(name,'/',1)='weddings' and split_part(name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and split_part(name,'/',3)='photos' and
      exists (select 1 from public.weddings w where w.id=split_part(name,'/',2)::uuid)) or
    (split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and split_part(name,'/',2)='photos' and
      exists (select 1 from public.weddings w where w.id=split_part(name,'/',1)::uuid))
  )
);
create policy "wedding image lookup hard boundary" on storage.objects as restrictive for select to anon,authenticated using (
  bucket_id <> 'wedding-media' or (
    (split_part(name,'/',1)='weddings' and split_part(name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and split_part(name,'/',3)='photos' and
      exists (select 1 from public.weddings w where w.id=split_part(name,'/',2)::uuid)) or
    (split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and split_part(name,'/',2)='photos' and
      exists (select 1 from public.weddings w where w.id=split_part(name,'/',1)::uuid))
  )
);
-- Restrictive guardrails override any older permissive policies on this bucket
-- without changing access rules for unrelated buckets in the same project.
create policy "wedding media uploads only via gateway" on storage.objects as restrictive for insert to anon,authenticated with check (bucket_id <> 'wedding-media');
create policy "wedding media cannot be overwritten by clients" on storage.objects as restrictive for update to anon,authenticated using (bucket_id <> 'wedding-media') with check (bucket_id <> 'wedding-media');
create policy "wedding media delete scoped to wedding admin" on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'wedding-media' or (
    (split_part(name,'/',1)='weddings' and split_part(name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
      (select wedding_private.is_wedding_admin(split_part(name,'/',2)::uuid))) or
    (split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
      (select wedding_private.is_wedding_admin(split_part(name,'/',1)::uuid)))
  )
);
-- Public bucket reads are served without RLS checks by Storage; this policy also
-- limits authenticated listing and metadata operations to real wedding paths.

-- Explicit table privileges pair with RLS. Guest inserts happen only in the
-- service-side gateway; admins have only scoped deletes/status updates.
revoke all on public.weddings,public.admins,public.photo_submissions,public.message_submissions from public,anon,authenticated;
grant select on public.weddings,public.photo_submissions,public.message_submissions to anon,authenticated;
grant select on public.admins to authenticated;
grant insert on public.photo_submissions,public.message_submissions to service_role;
grant update on public.weddings to authenticated;
grant update(status) on public.message_submissions to authenticated;
grant delete on public.photo_submissions,public.message_submissions to authenticated;
drop function if exists public.is_wedding_admin(uuid);
