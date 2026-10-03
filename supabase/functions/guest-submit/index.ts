import { createClient } from '@supabase/supabase-js';
import { deleteR2Object, r2Bucket, uploadR2Object } from '../_shared/r2-storage.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const maxBytes = 5 * 1024 * 1024;
const mimeExt: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
const privateKey = secretKeys ? JSON.parse(secretKeys).default as string : Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const client = createClient(Deno.env.get('SUPABASE_URL')!, privateKey, { auth: { persistSession: false, autoRefreshToken: false } });

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const isDevelopment = !Deno.env.get('DENO_DEPLOYMENT_ID');
function safeSqlState(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
function photoInsertDiagnostic(code: string) {
  switch (code) {
    case '42703': return 'missing_photo_visibility_column';
    case '23514': return 'photo_check_constraint';
    case '23502': return 'photo_required_field_constraint';
    case '42501': return 'photo_insert_permission_or_rls';
    case '42P01': return 'photo_table_missing';
    case '23505': return 'photo_unique_constraint';
    default: return 'photo_database_insert_failed';
  }
}
async function digest(input: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function validImageSignature(type: string, bytes: Uint8Array) {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n);
  if (type === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  return false;
}
function clientIp(req: Request) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
}
async function readBoundedBody(req: Request, limit: number): Promise<ArrayBuffer | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const body = new ArrayBuffer(size);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const part of parts) { view.set(part,offset); offset += part.byteLength; }
  return body;
}
async function claimSlot(key: string, limit: number, now: string, salt: string) {
  const { data, error } = await client.rpc('claim_wedding_submission_slot', {
    p_key_hash: await digest(`${salt}:${key}`), p_now: now, p_limit: limit, p_window_seconds: 600,
  });
  if (error) { console.error('submission_rate_limit_check_failed', { code: safeSqlState(error) }); return null; }
  return Boolean(data);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  try {
    const ip = clientIp(req);
    if (!ip) return response({ error: 'Submission could not be verified. Please try again.' }, 503);
    const salt = Deno.env.get('RATE_LIMIT_SALT');
    if (!salt || salt.length < 32) return response({ error: 'Guest submissions are temporarily unavailable.' }, 503);
    const now = new Date().toISOString();
    const ipAllowed = await claimSlot(`ip:${ip}`,32,now,salt);
    if (ipAllowed === null) return response({ error: 'Guest submissions are temporarily unavailable.' }, 503);
    if (!ipAllowed) return response({ error: 'Please wait a few minutes before sharing more.' }, 429);
    const bytes = await readBoundedBody(req,maxBytes+256*1024);
    if (!bytes) return response({ error: 'Each photo must be 5 MB or smaller.' }, 413);
    const form = await new Response(bytes,{headers:{'Content-Type':req.headers.get('content-type')||''}}).formData();
    // Quietly absorb honeypot submissions; don't reveal the field or rate-limit behavior.
    if (String(form.get('website') || '').trim()) return response({ ok: true });
    const action = String(form.get('action') || '');
    const weddingId = String(form.get('wedding_id') || '');
    const sessionId = String(form.get('session_id') || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(weddingId) || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return response({ error: 'Please reload the wedding page and try again.' }, 400);
    }
    const { data: wedding, error: weddingError } = await client.from('weddings').select('id,guest_upload_enabled').eq('id', weddingId).maybeSingle();
    if (weddingError) console.error('submission_wedding_lookup_failed', { code: safeSqlState(weddingError) });
    if (weddingError || !wedding) return response({ error: 'This wedding link is no longer available.' }, 404);
    if (action === 'photo' && !wedding.guest_upload_enabled) return response({ error: 'Photo uploads are turned off for this wedding.' }, 403);

    const sessionAllowed = await claimSlot(`session:${ip}:${sessionId}`,10,now,salt);
    if (sessionAllowed === null) return response({ error: 'Guest submissions are temporarily unavailable.' }, 503);
    if (!sessionAllowed) return response({ error: 'Please wait a few minutes before sharing more.' }, 429);

    const guestName = String(form.get('guest_name') || '').trim() || 'Anonymous Guest';
    if (guestName.length > 120) return response({ error: 'Names must be 120 characters or fewer.' }, 400);

    if (action === 'wish') {
      const message = String(form.get('message') || '').trim();
      const visibility = String(form.get('visibility') || 'public');
      if (!message || message.length > 1000 || !['public','private'].includes(visibility)) return response({ error: 'Check your message and try again.' }, 400);
      const { error } = await client.from('message_submissions').insert({ wedding_id: weddingId, guest_name: guestName, message, visibility, status: 'visible' });
      if (error) return response({ error: 'Your wish could not be saved. Please try again.' }, 500);
      return response({ ok: true });
    }

    if (action === 'photo') {
      const photoEntries = form.getAll('photo');
      if (photoEntries.length > 5) return response({ error: 'Choose no more than 5 photos at a time.' }, 400);
      const file = photoEntries[0];
      if (!(file instanceof File)) return response({ error: 'Choose a photo and try again.' }, 400);
      const visibilityValue = form.get('visibility');
      const visibility = visibilityValue === null ? 'public' : String(visibilityValue);
      if (visibility !== 'public' && visibility !== 'private') return response({ error: 'Choose who can see this photo.' }, 400);
      const ext = mimeExt[file.type];
      const name = file.name.toLowerCase();
      const extensionMatches = file.type === 'image/jpeg' ? /\.jpe?g$/.test(name) : ext ? name.endsWith(`.${ext}`) : false;
      if (!ext || !extensionMatches) return response({ error: 'Use a JPEG, PNG or WebP photo.' }, 415);
      if (file.size < 1 || file.size > maxBytes) return response({ error: 'Each photo must be 5 MB or smaller.' }, 413);
      const caption = String(form.get('caption') || '').trim();
      if (caption.length > 300) return response({ error: 'Captions must be 300 characters or fewer.' }, 400);
      const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!validImageSignature(file.type, bytes)) return response({ error: 'This file is not a valid supported image.' }, 415);
      const provider = Deno.env.get('PHOTO_STORAGE_PROVIDER') || 'supabase';
      if (provider !== 'supabase' && provider !== 'r2') return response({ error: 'Photo uploads are temporarily unavailable.' }, 503);
      const objectId = crypto.randomUUID();
      // Preserve the established constrained storage_path formats for compatibility;
      // storage_key records the independently generated R2 key when applicable.
      const path = visibility === 'private'
        ? `${weddingId}/private/photos/${objectId}.${ext}`
        : `weddings/${weddingId}/photos/${objectId}.${ext}`;
      const r2Key = `weddings/${weddingId}/${visibility}/${objectId}.${ext}`;
      let bucket: string | undefined;
      let uploadError: unknown = null;
      try {
        if (provider === 'r2') {
          bucket = r2Bucket(visibility);
          await uploadR2Object(bucket, r2Key, new Uint8Array(await file.arrayBuffer()), file.type, visibility);
        } else {
          bucket = visibility === 'private' ? 'wedding-private-media' : 'wedding-media';
          const result = await client.storage.from(bucket).upload(path, file, { contentType: file.type, cacheControl: visibility === 'private' ? '0' : undefined, upsert: false });
          uploadError = result.error;
        }
      } catch (error) { uploadError = error; }
      if (uploadError) {
        console.error('photo_storage_upload_failed', { code: safeSqlState(uploadError) });
        return response({ error: 'Something went wrong while uploading your memory. Please try again.', ...(isDevelopment ? { diagnostic: 'photo_storage_upload_failed' } : {}) }, 500);
      }
      const { error: insertError } = await client.from('photo_submissions').insert({ wedding_id: weddingId, uploader_name: guestName, storage_path: path, thumbnail_path: path, storage_provider: provider, storage_key: provider === 'r2' ? r2Key : null, caption: caption || null, media_type: file.type, file_size: file.size, visibility });
      if (insertError) {
        const code = safeSqlState(insertError);
        const diagnostic = photoInsertDiagnostic(code);
        console.error('photo_submission_insert_failed', { code, diagnostic });
        try {
          if (provider === 'r2' && bucket) await deleteR2Object(bucket, r2Key);
          else if (bucket) {
            const { error: cleanupError } = await client.storage.from(bucket).remove([path]);
            if (cleanupError) console.error('Photo upload cleanup failed.', { code: cleanupError.name || 'storage_cleanup_failed' });
          }
        } catch (cleanupError) { console.error('Photo upload cleanup failed.', { code: cleanupError instanceof Error ? cleanupError.name : 'storage_cleanup_failed' }); }
        return response({ error: 'Something went wrong while uploading your memory. Please try again.', ...(isDevelopment ? { diagnostic } : {}) }, 500);
      }
      return response({ ok: true });
    }
    return response({ error: 'Unsupported submission.' }, 400);
  } catch (error) {
    console.error('guest_submission_unhandled_failure', {
      name: error instanceof Error ? error.name : 'unknown',
      code: safeSqlState(error),
    });
    return response({ error: 'Submission failed. Please try again.', ...(isDevelopment ? { diagnostic: 'guest_submission_unhandled_failure' } : {}) }, 400);
  }
});
