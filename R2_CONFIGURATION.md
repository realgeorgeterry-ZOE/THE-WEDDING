# Cloudflare R2 setup

Supabase remains the source of truth for authentication and photo metadata. Existing photos keep their current Supabase Storage locations. Set `PHOTO_STORAGE_PROVIDER` only when ready to direct new guest photo uploads to R2; it defaults to `supabase`.

## Buckets

Create two R2 buckets:

- `R2_PUBLIC_BUCKET_NAME`: enable a Cloudflare custom domain for this bucket and set `VITE_R2_PUBLIC_BASE_URL` to that domain's base URL. Public gallery objects are stored under `weddings/{wedding_id}/public/{uuid}.{ext}`.
- `R2_BUCKET_NAME`: leave public development URL access disabled and do not attach a public custom domain. This bucket stores private objects under `weddings/{wedding_id}/private/{uuid}.{ext}`. Private images are delivered only through short-lived signed URLs after the admin Edge Function confirms the authenticated user's `admins` assignment and photo wedding ID.

Do not point a public domain at the private bucket. R2 public bucket/custom-domain access exposes objects in that bucket; separate buckets keep public delivery from exposing private memories. Cloudflare supports serving a bucket through a custom domain and recommends custom domains for production delivery: [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

## Supabase Edge Function secrets

Set these server-side in the existing Supabase project (never in Vite `.env` or frontend code):

```text
PHOTO_STORAGE_PROVIDER=supabase
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_BUCKET_NAME=...
ADMIN_ALLOWED_ORIGINS=http://localhost:5173,https://your-production-wedding-domain.example
```

Change `PHOTO_STORAGE_PROVIDER` to `r2` only after both buckets, the migration, secrets, function deployments, public custom domain, and CORS rules are ready. This switch applies only to future uploads; it does not move existing objects. The S3-compatible client uses Cloudflare's account endpoint and `auto` region as documented in [R2's S3 API guide](https://developers.cloudflare.com/r2/api/s3/) and [presigned URL guide](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Set `VITE_R2_PUBLIC_BASE_URL` in the frontend build environment to the public bucket's custom-domain origin, for example `https://media.example.com`. This is a public delivery address, not a credential. Never create `VITE_R2_ACCESS_KEY_ID` or `VITE_R2_SECRET_ACCESS_KEY`.

`ADMIN_ALLOWED_ORIGINS` is an exact comma-separated origin allowlist for the authenticated photo-storage Edge Function. Include local development and the deployed wedding site's origin, without path segments.

## Temporary R2 connectivity check

The admin dashboard's **Test R2 connection** control checks both configured buckets by writing and deleting a tiny uniquely named text object. It requires an authenticated wedding admin, does not inspect photo records, and does not depend on `PHOTO_STORAGE_PROVIDER`; keep that setting as `supabase` while testing. Deploy the updated function and frontend before running it:

```sh
supabase functions deploy photo-storage-admin --project-ref ggegisltxvdhsynhenxn
npm.cmd run build
```

Publish the resulting frontend build through your normal hosting workflow, sign in to `/admin/dashboard` as an assigned admin, and select **Test R2 connection**. A successful result says both **Public bucket: object created; temporary object deleted** and **Private bucket: object created; temporary object deleted**, along with **Both R2 buckets passed the connectivity test**. If a bucket fails, its status identifies whether creation or cleanup failed. A cleanup failure means the temporary object may need removal from that bucket; its random key is intentionally not exposed in the browser response.

## R2 CORS

Configure CORS separately on **both** buckets so the browser can fetch image bytes for admin downloads. Replace the production example with the exact origin serving the wedding site. Do not use `*`.

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "https://your-production-wedding-domain.example"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

The private bucket remains private; CORS only permits browser reads when an authorized short-lived signed URL is supplied. It does not grant anonymous object access. Do not enable `r2.dev` or a public custom domain on the private bucket.

## Deploy sequence

1. Create/configure both buckets, public custom domain, CORS, and the Edge Function secrets above. Keep `PHOTO_STORAGE_PROVIDER=supabase` initially.
2. Review and apply `supabase/migrations/202610030006_photo_storage_providers.sql` through the normal database release process.
3. Deploy `guest-submit` and `photo-storage-admin` Edge Functions.
4. Set the frontend build variable `VITE_R2_PUBLIC_BASE_URL`, build/release the frontend, and verify both public and private R2 access with an authorized test wedding.
5. Set `PHOTO_STORAGE_PROVIDER=r2` when ready for new uploads to use R2.

Nothing in this repository deploys the migration or Edge Functions automatically.
