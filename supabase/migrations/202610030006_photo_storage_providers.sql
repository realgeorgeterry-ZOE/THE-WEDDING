-- Keep existing object paths and rows untouched. Existing photos default to
-- Supabase Storage; R2 rows additionally carry their stable object key.
alter table public.photo_submissions
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists storage_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.photo_submissions'::regclass
      and conname = 'photo_storage_provider_allowed'
  ) then
    alter table public.photo_submissions
      add constraint photo_storage_provider_allowed
      check (storage_provider in ('supabase', 'r2')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.photo_submissions'::regclass
      and conname = 'photo_storage_key_matches_provider'
  ) then
    alter table public.photo_submissions
      add constraint photo_storage_key_matches_provider
      check (
        (storage_provider = 'supabase' and storage_key is null) or
        (storage_provider = 'r2' and storage_key is not null and char_length(storage_key) between 1 and 1024)
      ) not valid;
  end if;
end;
$$;
