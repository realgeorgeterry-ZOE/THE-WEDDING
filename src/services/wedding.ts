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

async function decodePhoto(input: File): Promise<{source: CanvasImageSource;width:number;height:number;close?:()=>void}> {
  if (typeof createImageBitmap === 'function') {
    try { const bitmap=await createImageBitmap(input,{imageOrientation:'from-image'}); return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()}; } catch { /* Try the browser's image decoder below. */ }
  }
  try {
    const url=URL.createObjectURL(input); const image=new Image(); image.src=url;
    try { await image.decode(); } finally { URL.revokeObjectURL(url); }
    if(!image.naturalWidth||!image.naturalHeight)throw new Error();
    return {source:image,width:image.naturalWidth,height:image.naturalHeight};
  } catch { throw new Error('We couldn’t prepare this photo. Please try another image. HEIC/HEIF photos may need to be saved as JPEG first.'); }
}
async function compressForUpload(input: File): Promise<File> {
  const decoded=await decodePhoto(input);
  try {
    const longest=Math.max(decoded.width,decoded.height);const targetSides=[3000,2700,2400,2100,1800,1500,1200];const qualities=[0.9,0.82,0.74,0.66,0.58];
    for(const side of targetSides){const scale=Math.min(1,side/longest);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(decoded.width*scale));canvas.height=Math.max(1,Math.round(decoded.height*scale));const context=canvas.getContext('2d');if(!context)throw new Error('canvas');context.drawImage(decoded.source,0,0,canvas.width,canvas.height);
      for(const quality of qualities){let blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(!blob||blob.type!=='image/webp')blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(!blob)continue;const mime=blob.type==='image/webp'?'image/webp':blob.type==='image/jpeg'?'image/jpeg':null;if(!mime)continue;if(blob.size<=4.75*1024*1024){const extension=mime==='image/webp'?'webp':'jpg';return new File([blob],`wedding-memory-${crypto.randomUUID()}.${extension}`,{type:mime,lastModified:Date.now()})}}
    }
    throw new Error('size');
  } catch(error) {
    if(error instanceof Error&&error.message==='size')throw new Error('We couldn’t prepare this photo small enough to upload. Please try another photo.');
    if(error instanceof Error&&error.message.startsWith('We couldn’t'))throw error;
    throw new Error('We couldn’t prepare this photo. Please try another image.');
  } finally { decoded.close?.(); }
}
export async function uploadPhotos(id: string, files: File[], name: string, caption: string, visibility: 'public' | 'private', sessionId: string, honeypot: string, onProgress?:(stage:'preparing'|'uploading',index:number,total:number)=>void) {
  if (files.length > 5) throw new Error('Please choose no more than 5 photos at a time.');
  let shared = 0;
  for (const [index,original] of files.entries()) {
    onProgress?.('preparing',index+1,files.length);
    const file = await compressForUpload(original);
    if(file.size>5*1024*1024)throw new Error('We couldn’t prepare this photo small enough to upload. Please try another photo.');
    const form = new FormData();
    form.set('action','photo'); form.set('wedding_id',id); form.set('guest_name',name.trim());
    form.set('caption',caption.trim()); form.set('visibility',visibility); form.set('photo',file); honeypotFields(form,sessionId,honeypot);
    try { onProgress?.('uploading',index+1,files.length);await invokeGuest(form); shared++; }
    catch (error) {
      if (shared) throw new Error(`${shared} photo(s) were shared; the next photo failed. ${error instanceof Error?error.message:'Please try again.'}`);
      throw error;
    }
  }
}
export type PhotoLocation = { storage_path?: string; thumbnail_path?: string | null; storage_provider?: 'supabase' | 'r2'; storage_key?: string | null };
const r2PublicBase = 'https://pub-eb1ab26ee35f45ddaf2de0ceb3355bc2.r2.dev';

export function photoUrl(photo: PhotoLocation | string, thumbnail = true) {
  if (typeof photo === 'string') return supabase.storage.from('wedding-media').getPublicUrl(photo,{transform:{width:1100,quality:78}}).data.publicUrl;
  const path = (thumbnail ? photo.thumbnail_path || photo.storage_path : photo.storage_path) || '';
  if (photo.storage_provider === 'r2') return r2PublicBase && photo.storage_key
    ? `${r2PublicBase}/${photo.storage_key.split('/').map(encodeURIComponent).join('/')}`
    : '';
  return supabase.storage.from('wedding-media').getPublicUrl(path,{...(thumbnail ? {transform:{width:1100,quality:78}} : {})}).data.publicUrl;
}
