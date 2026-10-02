import { supabase } from '../lib/supabase';

export async function getWedding(slug: string) {
  const { data, error } = await supabase.from('weddings').select('*').eq('slug', slug).maybeSingle();
  if (error) throw new Error('Could not load this wedding. Please try again.');
  return data;
}
export async function listWeddings() {
  const { data, error } = await supabase.from('weddings').select('id,slug,couple_name,wedding_date,venue').order('wedding_date').limit(50);
  if (error) throw new Error('Could not load weddings. Please try again.');
  return data ?? [];
}
export async function listPhotos(id: string) {
  const { data, error } = await supabase.from('photo_submissions').select('*').eq('wedding_id', id).eq('visibility', 'public').order('created_at', { ascending: false }).limit(80);
  if (error) { if (import.meta.env.DEV) console.error('Public photo query failed.', { code: error.code }); throw new Error('Could not load photos. Please refresh the page.'); }
  return data ?? [];
}
export async function listWishes(id: string) {
  const { data, error } = await supabase.from('message_submissions').select('*').eq('wedding_id', id).eq('visibility', 'public').eq('status', 'visible').order('created_at', { ascending: false }).limit(80);
  if (error) throw new Error('Could not load wishes. Please refresh the page.');
  return data ?? [];
}
export function guestSessionId() {
  const key = 'wedding-guest-session';
  let id = sessionStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
  return id;
}
function honeypotFields(form: FormData, sessionId: string, honeypot: string) {
  form.set('session_id', sessionId);
  form.set('website', honeypot);
}
async function invokeGuest(form: FormData) {
  const { data, error } = await supabase.functions.invoke('guest-submit', { body: form });
  if (error) {
    let message = 'Submission failed. Please try again.';
    try { const body = await error.context.json(); if (typeof body.error === 'string') message = body.error; if (import.meta.env.DEV && typeof body.diagnostic === 'string') console.error('Guest submission diagnostic.', body.diagnostic); } catch { if (import.meta.env.DEV) console.error('Guest submission failed before a diagnostic response was returned.'); }
    throw new Error(message);
  }
  if (!data?.ok) { if (import.meta.env.DEV && typeof data?.diagnostic === 'string') console.error('Guest submission diagnostic.', data.diagnostic); throw new Error(typeof data?.error === 'string' ? data.error : 'Submission failed. Please try again.'); }
}
export async function sendWish(id: string, name: string, message: string, visibility: 'public'|'private', sessionId: string, honeypot: string) {
  const form = new FormData();
  form.set('action','wish'); form.set('wedding_id',id); form.set('guest_name',name.trim());
  form.set('message',message.trim()); form.set('visibility',visibility); honeypotFields(form,sessionId,honeypot);
  await invokeGuest(form);
}

async function compressForUpload(input: File): Promise<File> {
  if (!['image/jpeg','image/png','image/webp'].includes(input.type)) throw new Error('Use a JPEG, PNG or WebP photo.');
  try {
    const bitmap = await createImageBitmap(input);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Photo compression is unavailable in this browser.');
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
    let quality = 0.9, blob: Blob | null = null;
    while (quality >= 0.65) { blob = await new Promise(resolve => canvas.toBlob(resolve,'image/webp',quality)); if (blob && blob.size <= 5*1024*1024) break; quality -= 0.08; }
    if (!blob || blob.size > 5*1024*1024) throw new Error('This photo is too large. Choose a smaller image.');
    return new File([blob], `wedding-memory-${crypto.randomUUID()}.webp`, { type:'image/webp', lastModified:Date.now() });
  } catch (error) {
    if (error instanceof Error && error.message.includes('too large')) throw error;
    if (input.size <= 5*1024*1024) return input;
    throw new Error('This photo could not be compressed. Choose a smaller JPEG, PNG or WebP image.');
  }
}
export async function uploadPhotos(id: string, files: File[], name: string, caption: string, visibility: 'public' | 'private', sessionId: string, honeypot: string) {
  if (files.length > 5) throw new Error('Please choose no more than 5 photos at a time.');
  let shared = 0;
  for (const original of files) {
    const file = await compressForUpload(original);
    const form = new FormData();
    form.set('action','photo'); form.set('wedding_id',id); form.set('guest_name',name.trim());
    form.set('caption',caption.trim()); form.set('visibility',visibility); form.set('photo',file); honeypotFields(form,sessionId,honeypot);
    try { await invokeGuest(form); shared++; }
    catch (error) {
      if (shared) throw new Error(`${shared} photo(s) were shared; the next photo failed. ${error instanceof Error?error.message:'Please try again.'}`);
      throw error;
    }
  }
}
export function photoUrl(path: string) {
  return supabase.storage.from('wedding-media').getPublicUrl(path,{transform:{width:1100,quality:78}}).data.publicUrl;
}
