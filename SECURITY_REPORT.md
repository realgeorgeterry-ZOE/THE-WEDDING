# Phase 1B Supabase verification

Date: 2026-10-02

## Environment status

- Frontend build: **PASS** (`npm run build`). Vite emitted a chunk-size warning for the 509.52 kB main bundle.
- Local `.env`: created from `.env.example`; Supabase URL and anon key remain blank because project values were not available. It is covered by `.gitignore`.
- Supabase CLI: **unavailable** (`supabase` is not installed or on PATH; `npx --no-install supabase` could not run offline and hit a local npm cache permission error).
- Remote project: not linked or inspected. No `supabase db push --dry-run` was run. No migration, secret, storage, account, wedding, or Edge Function changes were made remotely.

## Test results

“NOT RUN” means the live test could not be performed without a linked Supabase project, valid public project values, and test admin accounts. It is not a passing result.

| Test | Result | Notes |
| --- | --- | --- |
| Guest photo upload | NOT RUN | Needs deployed `guest-submit` and remote Storage/database. |
| Public wish | NOT RUN | Needs deployed `guest-submit` and remote project. |
| Private wish isolation | NOT RUN | Anonymous/Admin A/Admin B matrix not available. |
| Cross-wedding isolation | NOT RUN | Two weddings and two authenticated admins not available. |
| Storage security | NOT RUN | Remote policies and object access not inspected. |
| Invalid file rejection | NOT RUN | Gateway not deployed; malicious upload cases not exercised. |
| Rate limiting | NOT RUN | `RATE_LIMIT_SALT` and live gateway unavailable. |
| Honeypot | NOT RUN | Gateway not deployed. |
| Delete | NOT RUN | Remote Storage/database authorization not exercised. |
| Bulk delete | NOT RUN | Requires seeded remote records and two admins. |
| Hide/restore | NOT RUN | Remote RLS not exercised. |
| Settings | NOT RUN | Remote settings update and public refresh not exercised. |
| QR PNG | NOT RUN | Requires Wedding A and browser interaction. |
| QR SVG | NOT RUN | Requires Wedding A and browser interaction. |
| Realtime | NOT RUN | Publication and live client behavior not inspected. |
| PWA | NOT RUN | Build generates the service worker; install/offline/login behavior was not verified on a browser/device. |
| Logout/protected routes | NOT RUN | Requires an authenticated test account and browser session. |

## Required next steps

1. Provide/link the existing Supabase project and set the public project URL and anon/publishable key in local `.env`.
2. Install/authenticate Supabase CLI, link the project, inspect remote schema and migration history, then run `supabase db push --dry-run` and review its output. Do not push until the 001/002 comparison is understood; never rerun 001 if it was manually applied.
3. Configure/verify Auth, Storage, Realtime, `wedding-media`, and `RATE_LIMIT_SALT`; deploy `guest-submit` and confirm its server credentials.
4. Create two test weddings and linked admin users, then execute the live test matrix above, including phone/browser PWA installation.

Production readiness is **not established**. No remote Supabase verification or live security test passed in this phase because the project was not accessible from this workspace.
