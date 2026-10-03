import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { deleteR2Object, r2Bucket, signR2Object, testR2Bucket } from '../_shared/r2-storage.ts';

const allowedOrigins = (Deno.env.get('ADMIN_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean);
const baseCorsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: Record<string, unknown>, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseCorsHeaders,
      ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.includes(origin)) return json({ error: 'Origin is not allowed.' }, 403, null);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...baseCorsHeaders, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) } });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, origin);

  try {
    const authorization = request.headers.get('authorization') || '';
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || (Deno.env.get('SUPABASE_SECRET_KEYS') ? JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!).default as string : '');
    if (!token || !supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Admin authorization is required.' }, 401, origin);

    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) return json({ error: 'Admin authorization is required.' }, 401, origin);

    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await request.json();
    const action = body?.action;
    const photoId = typeof body?.photo_id === 'string' ? body.photo_id : '';
    const weddingId = typeof body?.wedding_id === 'string' ? body.wedding_id : '';
    if (!['signed-url', 'delete', 'connectivity-test'].includes(action) || (action !== 'connectivity-test' && !/^[0-9a-f-]{36}$/i.test(photoId)) || !/^[0-9a-f-]{36}$/i.test(weddingId)) {
      return json({ error: 'The photo request is invalid.' }, 400, origin);
    }

    const { data: assignment, error: assignmentError } = await service.from('admins').select('id')
      .eq('user_id', user.id).eq('wedding_id', weddingId).limit(1).maybeSingle();
    if (assignmentError || !assignment) return json({ error: 'You are not authorized to access this wedding photo.' }, 403, origin);

    if (action === 'connectivity-test') {
      const [publicBucket, privateBucket] = await Promise.all([
        testR2Bucket('public').catch(() => ({ bucket_accessible: false, temporary_object_deleted: false, success: false })),
        testR2Bucket('private').catch(() => ({ bucket_accessible: false, temporary_object_deleted: false, success: false })),
      ]);
      const success = publicBucket.success && privateBucket.success;
      return json({ success, public_bucket: publicBucket, private_bucket: privateBucket }, success ? 200 : 502, origin);
    }

    const { data: photo, error: photoError } = await service.from('photo_submissions')
      .select('id,wedding_id,visibility,storage_provider,storage_key,storage_path,media_type')
      .eq('id', photoId).eq('wedding_id', weddingId).maybeSingle();
    if (photoError || !photo) return json({ error: 'The photo could not be found for this wedding.' }, 404, origin);
    if (photo.storage_provider !== 'r2' || typeof photo.storage_key !== 'string') return json({ error: 'This photo is not stored in R2.' }, 400, origin);
    const keyPattern = new RegExp(`^weddings/${weddingId}/${photo.visibility}/[0-9a-f-]{36}\\.(jpg|png|webp)$`, 'i');
    if (!['public', 'private'].includes(photo.visibility) || !keyPattern.test(photo.storage_key)) {
      return json({ error: 'The stored photo location is invalid.' }, 400, origin);
    }

    const bucket = r2Bucket(photo.visibility);
    if (action === 'signed-url') {
      const downloadName = typeof body?.download_name === 'string' && /^[a-z0-9_-]{1,120}\.(jpg|png|webp)$/i.test(body.download_name)
        ? body.download_name
        : undefined;
      const url = await signR2Object(bucket, photo.storage_key, 60, downloadName);
      return json({ url, expires_in: 60 }, 200, origin);
    }

    await deleteR2Object(bucket, photo.storage_key);
    const { data: deleted, error: deleteError } = await service.from('photo_submissions').delete()
      .eq('id', photoId).eq('wedding_id', weddingId).select('id');
    if (deleteError || !deleted?.some(row => row.id === photoId)) return json({ error: 'The R2 photo was removed but its database record could not be removed.' }, 500, origin);
    return json({ ok: true }, 200, origin);
  } catch (error) {
    console.error('photo_storage_admin_failure', { name: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'The photo request could not be completed. Please try again.' }, 500, origin);
  }
});
