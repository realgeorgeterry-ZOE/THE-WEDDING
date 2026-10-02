import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, LockKeyhole, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

type PrivatePhoto = Record<string, any> & { signedUrl?: string };

async function createPrivateUrl(path: string) {
  const { data, error } = await supabase.storage
    .from('wedding-private-media')
    .createSignedUrl(path, 60 * 60, { download: false });
  if (error || !data?.signedUrl) throw new Error('A private photo could not be opened. Refresh and try again.');
  return data.signedUrl;
}

export default function PrivatePhotos({ weddingId, coupleName }: { weddingId: string; coupleName: string }) {
  const [photos, setPhotos] = useState<PrivatePhoto[]>([]);
  const [active, setActive] = useState<PrivatePhoto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setError('');
    const { data, error: queryError } = await supabase.from('photo_submissions')
      .select('id,wedding_id,uploader_name,storage_path,thumbnail_path,caption,media_type,file_size,visibility,created_at')
      .eq('wedding_id', weddingId)
      .eq('visibility', 'private')
      .order('created_at', { ascending: false })
      .limit(100);
    if (queryError) throw new Error('Could not load private photos. Please refresh and try again.');

    const signedPhotos = await Promise.all((data || []).map(async photo => {
      try { return { ...photo, signedUrl: await createPrivateUrl(photo.thumbnail_path || photo.storage_path) }; }
      catch { return { ...photo, signedUrl: undefined }; }
    }));
    setPhotos(signedPhotos);
  }

  useEffect(() => {
    let live = true;
    refresh().catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load private photos.'); });
    return () => { live = false; };
  }, [weddingId]);

  async function openPhoto(photo: PrivatePhoto) {
    setError('');
    try {
      const signedUrl = await createPrivateUrl(photo.storage_path);
      setActive({ ...photo, signedUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A private photo could not be opened.');
    }
  }

  async function downloadPhoto(photo: PrivatePhoto) {
    setError('');
    try {
      const signedUrl = await createPrivateUrl(photo.storage_path);
      const link = document.createElement('a');
      link.href = signedUrl;
      link.download = `private-memory-${photo.id}`;
      link.rel = 'noreferrer';
      link.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo could not be downloaded.');
    }
  }

  async function deletePhoto(photo: PrivatePhoto) {
    if (!window.confirm('Permanently delete this private photo?')) return;
    setBusy(true); setError(''); setNotice('');
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
    if (active?.id === photo.id) setActive(null);
    setNotice('Private photo deleted.');
  }

  return <main className="dash">
    <Link className="back" to={`/admin/dashboard`}>← Dashboard</Link>
    <h1>Private photos 🔒</h1>
    <p>{coupleName} · Visible only to the couple</p>
    {error && <div className="alert" role="status">{error}</div>}
    {notice && <div className="alert" role="status">{notice}</div>}
    {photos.map(photo => <article className="adminrow" key={photo.id}>
      {photo.signedUrl
        ? <button type="button" className="private-photo-thumb" onClick={() => openPhoto(photo)} aria-label="Open private photo"><img src={photo.signedUrl} alt={photo.caption || 'Private wedding photo'} referrerPolicy="no-referrer"/></button>
        : <div className="private-photo-thumb unavailable">Photo unavailable</div>}
      <div><b><LockKeyhole size={13}/> Private memory{photo.caption ? ` · ${photo.caption}` : ''}</b>
        <small>{photo.uploader_name} · {new Date(photo.created_at).toLocaleString()}</small></div>
      <button type="button" disabled={busy} onClick={() => downloadPhoto(photo)} aria-label="Download private photo"><Download size={16}/></button>
      <button type="button" disabled={busy} onClick={() => deletePhoto(photo)}>Delete</button>
    </article>)}
    {!photos.length && !error && <p className="empty">No private photos have been sent yet.</p>}
    {active && <div className="overlay" role="dialog" aria-modal="true" onClick={() => setActive(null)}>
      <button aria-label="Close" onClick={() => setActive(null)}><X/></button>
      <img src={active.signedUrl} alt={active.caption || 'Private wedding photo'} referrerPolicy="no-referrer"/>
      <p>{active.caption || 'A private memory'} — {active.uploader_name}</p>
    </div>}
  </main>;
}
