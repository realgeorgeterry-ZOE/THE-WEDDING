import { supabase } from '../lib/supabase';

async function requestR2Photo(action: 'signed-url' | 'delete', photoId: string, weddingId: string, downloadName?: string) {
  const { data, error } = await supabase.functions.invoke('photo-storage-admin', {
    body: { action, photo_id: photoId, wedding_id: weddingId, ...(downloadName ? { download_name: downloadName } : {}) },
  });
  if (error) {
    let message: string | undefined;
    try { const payload = await error.context.json(); if (typeof payload?.error === 'string') message = payload.error; } catch { /* Use the safe fallback below. */ }
    throw new Error(message || 'The photo request could not be authorized. Please sign in again and retry.');
  }
  if (action === 'signed-url') {
    if (typeof data?.url !== 'string') throw new Error('A temporary photo link could not be created. Please try again.');
    return data.url as string;
  }
  if (data?.ok !== true) throw new Error('The photo could not be deleted. Please try again.');
  return true;
}

export function getR2PhotoUrl(photoId: string, weddingId: string, downloadName?: string) {
  return requestR2Photo('signed-url', photoId, weddingId, downloadName) as Promise<string>;
}

export async function deleteR2Photo(photoId: string, weddingId: string) {
  await requestR2Photo('delete', photoId, weddingId);
}
