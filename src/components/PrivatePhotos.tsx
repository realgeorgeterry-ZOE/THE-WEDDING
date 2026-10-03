import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, LockKeyhole, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { createPhotoArchive } from '../services/photoArchive';
import { deleteR2Photo, getR2PhotoUrl } from '../services/photoStorage';

type PrivatePhoto = Record<string, any> & { signedUrl?: string };

async function createPrivateUrl(path: string, download?: string) {
  const { data, error } = await supabase.storage
    .from('wedding-private-media')
    .createSignedUrl(path, download ? 60 : 60 * 60, { download: download || false });
  if (error || !data?.signedUrl) throw new Error(download ? 'The private photo could not be prepared for download. Please try again.' : 'A private photo could not be opened. Refresh and try again.');
  return data.signedUrl;
}

export default function PrivatePhotos({ weddingId, coupleName }: { weddingId: string; coupleName: string }) {
  const [photos, setPhotos] = useState<PrivatePhoto[]>([]);
  const [active, setActive] = useState<PrivatePhoto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState('');

  async function refresh() {
    setError('');
    const { data, error: queryError } = await supabase.from('photo_submissions')
      .select('id,wedding_id,uploader_name,storage_path,thumbnail_path,caption,media_type,file_size,visibility,storage_provider,storage_key,created_at')
      .eq('wedding_id', weddingId)
      .eq('visibility', 'private')
      .order('created_at', { ascending: false })
      .limit(100);
    if (queryError) throw new Error('Could not load private photos. Please refresh and try again.');

    const signedPhotos = await Promise.all((data || []).map(async photo => {
      try { return { ...photo, signedUrl: photo.storage_provider === 'r2'
        ? await getR2PhotoUrl(photo.id, weddingId)
        : await createPrivateUrl(photo.thumbnail_path || photo.storage_path) }; }
      catch { return { ...photo, signedUrl: undefined }; }
    }));
    setPhotos(signedPhotos);
    setSelected(new Set());
  }

  useEffect(() => {
    let live = true;
    refresh().catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load private photos.'); });
    return () => { live = false; };
  }, [weddingId]);

  async function openPhoto(photo: PrivatePhoto) {
    setError('');
    try {
      const signedUrl = photo.storage_provider === 'r2'
        ? await getR2PhotoUrl(photo.id, weddingId)
        : await createPrivateUrl(photo.storage_path);
      setActive({ ...photo, signedUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A private photo could not be opened.');
    }
  }

  async function downloadPhoto(photo: PrivatePhoto) {
    setError('');
    setDownloading(photo.id);
    try {
      const extension = String(photo.storage_path).match(/\.(jpg|png|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
      const filename = `private-memory-${photo.id}.${extension}`;
      const signedUrl = photo.storage_provider === 'r2'
        ? await getR2PhotoUrl(photo.id, weddingId, filename)
        : await createPrivateUrl(photo.storage_path, filename);
      const link = document.createElement('a');
      link.href = signedUrl;
      link.rel = 'noreferrer';
      link.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo could not be downloaded.');
    } finally {
      setDownloading('');
    }
  }

  async function downloadSelectedPhotos() {
    if (!selected.size || bulkProgress || busy) return;
    setError(''); setNotice('');
    const items = photos.filter(photo => selected.has(photo.id));
    const files: { name: string; blob: Blob }[] = [];
    const failed: string[] = [];
    try {
      for (let index = 0; index < items.length; index++) {
        const photo = items[index];
        setBulkProgress(`Preparing ${index + 1} of ${items.length} downloads…`);
        const extension = String(photo.storage_path).match(/\.(jpg|png|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
        const filename = `private-memory-${photo.id}.${extension}`;
        try {
          const signedUrl = photo.storage_provider === 'r2'
            ? await getR2PhotoUrl(photo.id, weddingId, filename)
            : await createPrivateUrl(photo.storage_path, filename);
          const response = await fetch(signedUrl);
          if (!response.ok) throw new Error('Download failed');
          files.push({ name: filename, blob: await response.blob() });
        } catch { failed.push(photo.id); }
      }
      if (files.length) {
        setBulkProgress('Packing selected photos…');
        const archive = await createPhotoArchive(files);
        const url = URL.createObjectURL(archive);
        const link = document.createElement('a');
        link.href = url;
        link.download = `kofi-kamilia-private-memories-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        setNotice(`Prepared ${files.length} private photo${files.length === 1 ? '' : 's'} in one download.`);
      }
      if (failed.length) setError(`${failed.length} selected private photo${failed.length === 1 ? '' : 's'} could not be downloaded (${failed.join(', ')}).${files.length ? ' The other photos are included in the ZIP.' : ' Please try again.'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Selected private photos could not be prepared. Please try again.');
    } finally { setBulkProgress(''); }
  }

  async function deleteSelectedPhotos() {
    const items = photos.filter(photo => selected.has(photo.id));
    if (!items.length || busy || bulkProgress || !window.confirm(`Permanently delete ${items.length} private photo${items.length === 1 ? '' : 's'}?`)) return;
    setBusy(true); setError(''); setNotice('');
    const deleted: string[] = [], failed: string[] = [];
    for (const photo of items) {
      if (photo.storage_provider === 'r2') {
        try { await deleteR2Photo(photo.id, weddingId); deleted.push(photo.id); }
        catch { failed.push(photo.id); }
        continue;
      }
      const { error: storageError } = await supabase.storage.from('wedding-private-media').remove([photo.storage_path]);
      if (storageError) { failed.push(photo.id); continue; }
      const { data, error: rowError } = await supabase.from('photo_submissions').delete()
        .eq('id', photo.id).eq('wedding_id', weddingId).eq('visibility', 'private').select('id');
      if (rowError || !data?.some(row => row.id === photo.id)) { failed.push(photo.id); continue; }
      deleted.push(photo.id);
    }
    setPhotos(current => current.filter(photo => !deleted.includes(photo.id)));
    setSelected(current => new Set([...current].filter(id => !deleted.includes(id))));
    if (active && deleted.includes(active.id)) setActive(null);
    setBusy(false);
    if (failed.length) setError(`${deleted.length} deleted; ${failed.length} could not be deleted (${failed.join(', ')}).`);
    else setNotice(`${deleted.length} private photo${deleted.length === 1 ? '' : 's'} deleted.`);
  }

  async function deletePhoto(photo: PrivatePhoto) {
    if (!window.confirm('Permanently delete this private photo?')) return;
    setBusy(true); setError(''); setNotice('');
    if (photo.storage_provider === 'r2') {
      try {
        await deleteR2Photo(photo.id, weddingId);
        setPhotos(current => current.filter(row => row.id !== photo.id));
        setSelected(current => { const next = new Set(current); next.delete(photo.id); return next; });
        if (active?.id === photo.id) setActive(null);
        setNotice('Private photo deleted.');
      } catch (e) { setError(e instanceof Error ? e.message : 'The private photo could not be deleted. Please retry.'); }
      finally { setBusy(false); }
      return;
    }
    const { error: storageError } = await supabase.storage.from('wedding-private-media').remove([photo.storage_path]);
    if (storageError) {
      setBusy(false);
      setError('The private photo file could not be deleted. Its record was kept. Please retry.');
      return;
    }
    const { data, error: rowError } = await supabase.from('photo_submissions')
      .delete().eq('id', photo.id).eq('wedding_id', weddingId).eq('visibility', 'private').select('id');
    setBusy(false);
    if (rowError || !data?.some(row => row.id === photo.id)) {
      setError('The file was removed, but its private photo record could not be deleted. Refresh and contact support if it remains.');
      return;
    }
    setPhotos(current => current.filter(row => row.id !== photo.id));
    setSelected(current => { const next = new Set(current); next.delete(photo.id); return next; });
    if (active?.id === photo.id) setActive(null);
    setNotice('Private photo deleted.');
  }

  return <main className="dash">
    <Link className="back" to={`/admin/dashboard`}>← Dashboard</Link>
    <h1>Private photos 🔒</h1>
    <p>{coupleName} · Visible only to the couple</p>
    {error && <div className="alert" role="status">{error}</div>}
    {notice && <div className="alert" role="status">{notice}</div>}
    {photos.length > 0 && <div className="bulkbar">
      <label><input type="checkbox" checked={selected.size === photos.length} disabled={busy || !!bulkProgress} onChange={event => setSelected(event.target.checked ? new Set(photos.map(photo => photo.id)) : new Set())}/> {selected.size === photos.length ? 'All photos selected' : 'Select all'}</label>
      {selected.size > 0 && <>
        <span className="bulk-selected-count">{selected.size} selected</span>
        <button type="button" className="btn bulk-download-btn" disabled={busy || !!downloading || !!bulkProgress} onClick={() => void downloadSelectedPhotos()}>{bulkProgress || 'Download selected'}</button>
        <button type="button" className="btn" disabled={busy || !!downloading || !!bulkProgress} onClick={() => void deleteSelectedPhotos()}>Delete selected ({selected.size})</button>
      </>}
    </div>}
    {photos.map(photo => <article className="adminrow" key={photo.id}>
      <input type="checkbox" checked={selected.has(photo.id)} disabled={busy || !!bulkProgress} onChange={() => setSelected(current => { const next = new Set(current); next.has(photo.id) ? next.delete(photo.id) : next.add(photo.id); return next; })} aria-label="Select private photo"/>
      {photo.signedUrl
        ? <button type="button" className="private-photo-thumb" onClick={() => openPhoto(photo)} aria-label="Open private photo"><img src={photo.signedUrl} alt={photo.caption || 'Private wedding photo'} referrerPolicy="no-referrer"/></button>
        : <div className="private-photo-thumb unavailable">Photo unavailable</div>}
      <div><b><LockKeyhole size={13}/> Private memory{photo.caption ? ` · ${photo.caption}` : ''}</b>
        <small>{photo.uploader_name} · {new Date(photo.created_at).toLocaleString()}</small></div>
      <button type="button" className="photo-download-btn" disabled={busy||!!downloading} onClick={() => downloadPhoto(photo)} aria-label="Download private photo"><Download size={15}/>{downloading===photo.id?'Preparing…':'Download'}</button>
      <button type="button" disabled={busy || !!bulkProgress} onClick={() => deletePhoto(photo)}>Delete</button>
    </article>)}
    {!photos.length && !error && <p className="empty">No private photos have been sent yet.</p>}
    {active && <div className="overlay" role="dialog" aria-modal="true" onClick={() => setActive(null)}>
      <button aria-label="Close" onClick={() => setActive(null)}><X/></button>
      <img src={active.signedUrl} alt={active.caption || 'Private wedding photo'} referrerPolicy="no-referrer"/>
      <p>{active.caption || 'A private memory'} — {active.uploader_name}</p>
      <button type="button" className="photo-download-btn private-viewer-download" disabled={!!downloading} onClick={event => { event.stopPropagation(); void downloadPhoto(active); }}><Download size={15}/>{downloading===active.id?'Preparing…':'Download'}</button>
    </div>}
  </main>;
}
