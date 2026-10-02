# Wedding Memories

Mobile-first React + TypeScript wedding guestbook backed by Supabase. The guest pages share photos and public/private wishes; the couple dashboard is authenticated and wedding-scoped by Postgres RLS. Google backup is intentionally deferred.

## Local app setup

1. Install Node.js 20+ and run `npm install`.
2. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Project Settings → API. The second variable may contain the project's anon key or publishable key. Both are public browser credentials. Never place a service-role/secret key in a `VITE_` variable.
3. Run `npm run dev`; open the URL printed by Vite.

## Apply the existing migrations safely

The existing schema is in `supabase/migrations/202610020001_initial.sql`. Phase 1 is additive in `202610020002_harden_security.sql`; do not edit or rerun the original file against an existing schema.

1. In Supabase Dashboard → Database → Table Editor, check whether `weddings`, `admins`, `photo_submissions`, and `message_submissions` already exist. Also check Storage → `wedding-media`, its policies, and Realtime publication tables.
2. If starting with a genuinely empty Supabase project, install the Supabase CLI, run `supabase login`, `supabase link --project-ref <project-ref>`, then `supabase db push --dry-run` and review the plan before `supabase db push`. This applies 001 then 002 and records migration history.
3. If migration 001 was already applied through the SQL Editor, first inspect the actual schema and policies. Do not run 001 again. After verifying it matches the baseline, reconcile its migration-history entry with `supabase migration repair --status applied 202610020001`; then dry-run and push 002. Migration repair only changes history; it does not run SQL.
4. If the schema is partially applied or differs from 001, stop and inspect the database before using `db push`. Do not run these create-table policies against existing objects to “see what happens.”

Migration 002 adds `weddings.guest_upload_enabled`, public-message `status` (`visible`/`hidden`), new-row data validation, a server-only rate-limit table/function, wedding-scoped read/update/delete policies, explicit table grants, a 5 MB MIME allow-list, and removes direct guest table/storage upload paths. It preserves 001 and existing rows; metadata constraints are initially unvalidated to avoid rewriting old submissions. The Edge Function is the only guest-write path after migration 002.

## Supabase Dashboard setup

These items require your Supabase account:

1. Create a project if you do not already have one. Copy the project URL and anon/publishable key into local `.env`.
2. Authentication → Sign In / Providers: enable Email. Disable public sign-ups; use Authentication → Users to add or invite the couple account. Configure the Site URL and redirect allow-list for localhost and your deployed origin.
3. Run the migration workflow above. It creates the `wedding-media` public bucket, size/type restrictions, Storage policies, RLS policies, and Realtime publication entries. Verify these in Storage → Policies and Database → Publications; do not manually create duplicates.
4. Create a `weddings` record with `couple_name`, `slug`, date/venue and other details. Then find the new account UUID under Authentication → Users and add one `admins` row mapping that `user_id` to the wedding `id`, role `owner`.
5. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to your Vercel project environment variables before deployment.

The app has no sample wedding or account. The landing page lists configured wedding records; `/wedding/:slug` loads the record by its slug and unknown slugs show a not-found page.

## Guest submission gateway

Guest writes go through `supabase/functions/guest-submit/index.ts`. The function verifies the wedding and upload setting, checks a browser session token, applies an atomic IP + session rate limit, checks a honeypot, caps each image at 5 MB, allow-lists JPEG/PNG/WebP, checks file extensions and file signatures, creates the storage path itself, uploads with the server key, then creates the metadata row. A failed metadata insert triggers storage cleanup. Direct anon/authenticated inserts and direct guest object uploads are closed by migration 002.

In Supabase Dashboard → Edge Functions → Secrets, set `RATE_LIMIT_SALT` to a randomly generated value of at least 32 characters. The Edge Function reads Supabase's server-side secret key from its environment; never add that key to `.env` or the browser. Deploy with the Supabase CLI: `supabase functions deploy guest-submit`. The project config disables gateway JWT verification only for this no-account guest endpoint; rate limits, honeypot and server validation then gate submissions. Test the function after deployment before sharing the wedding QR link.

Rate limit defaults are 32 requests per IP per 10 minutes and 10 per browser session per 10 minutes. These limits are intentionally conservative and should be reviewed for the event's expected usage. The UI compresses images client-side for performance, but trust is placed in the Edge Function's independent checks, not the browser MIME claim.

## Authorization and photo visibility

- Guests can read public wedding pages, public photo metadata and visible public wishes. They can submit public or private wishes through the Edge Function.
- Private wishes are selected only by an authenticated admin linked to that wedding. Hidden public wishes remain couple-visible but are excluded from guest queries.
- Authenticated users that administer a wedding are restricted to their assigned wedding rows. Public users without an admin membership retain public content access across wedding slugs.
- Admin deletes and settings updates are wedding-scoped in RLS. Message status updates grant only the `status` column.
- `wedding-media` remains public because every stored guest photo is immediately public product content. Public Storage URLs are CDN-friendly but anyone who has a URL can open/copy it. Never put private/admin documents in this bucket; use a separate private bucket and short-lived signed URLs for any future private media.

Run authorization tests with two weddings and two admin accounts before production. Specifically confirm anon cannot select private rows or `admins`, direct writes fail, Admin A cannot query or mutate Wedding B records, and only its own admin can select a private wish. SQL source review is not a substitute for those live checks.

## Admin features

- Email/password sign-in; React route protection plus RLS.
- Per-wedding photo and wish lists; checked Storage + database delete responses; bulk deletion reports partial failures.
- Public wishes can be hidden/restored without an approval state. Private wishes remain private.
- Couple settings update names, date, venue, description, slug, hero URL, and guest photo upload toggle.
- QR page shows the wedding-specific guest URL and downloads PNG/SVG or copies the link.
- Public gallery/wall and couple notification subscriptions are filtered by wedding; row policies remain the authorization boundary.

## PWA and deployment

`vite-plugin-pwa` generates a manifest and service worker. It precaches the app shell/static assets only; no runtime data cache is configured. The SVG icon is in `public/wedding-icon.svg`. The dashboard PWA still requires installation testing over HTTPS on target devices. Deploy the Vite app to Vercel with the two browser-public variables. Configure SPA fallback to `index.html` if required by your hosting configuration.

## Verification status

Run `npm run build` for the browser app. The Deno Edge Function is not included in that TypeScript project; check it with `deno check supabase/functions/guest-submit/index.ts` and deploy it with the Supabase CLI. Live guest/auth/RLS/Storage/Realtime tests require configured Supabase credentials and separate Wedding A/Admin A and Wedding B/Admin B accounts. Do not treat the app as production-ready until the two-account matrix, invalid/oversized upload attempts, deletes, hide/restore, settings, QR and PWA install tests all pass.

Google OAuth/Sheets, analytics, approval queues and major visual redesigns are not part of Phase 1.
