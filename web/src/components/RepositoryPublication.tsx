import { useState } from 'react';
import { api } from '../lib/transport.js';

export function RepositoryPublication({ runId }: { runId: string }) {
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState<{ repository: string; baseCommit: string; digest: string; files: Array<{path:string;content:string|null;encoding?:string;sha256?:string}> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  async function act(publish: boolean) {
    setBusy(true); setError('');
    try {
      if (publish && preview) {
        const result = await api.systemAction('repository-publish', { runId, approvedDigest: preview.digest });
        setUrl(result.url);
      } else setPreview(await api.systemAction('repository-preview', { runId, base, title }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (url) return <a href={url} target="_blank" rel="noreferrer">Open draft pull request</a>;
  return <details className="grok-question-card"><summary>Create a GitHub pull request</summary>
    <p>Publish this verified change as a draft pull request. The destination must be enabled in repository settings.</p>
    <label>Base branch <input value={base} maxLength={200} disabled={busy} onChange={e => { setBase(e.target.value); setPreview(null); }} /></label>
    <label>Pull request title <input value={title} maxLength={200} disabled={busy} onChange={e => { setTitle(e.target.value); setPreview(null); }} /></label>
    <button type="button" disabled={busy || !base.trim() || !title.trim()} onClick={() => void act(false)}>Review publication</button>
    {preview && <><p>{preview.repository} · Base commit {preview.baseCommit}</p>
      {preview.files.map(file => <details key={file.path}><summary>{file.path}{file.content===null?' (delete)':file.encoding==='base64'?' (binary)':''}</summary><pre>{file.content===null?'This file will be deleted.':file.encoding==='base64'?`Binary file SHA-256: ${file.sha256}`:file.content}</pre></details>)}
      <button type="button" disabled={busy} onClick={() => void act(true)}>Approve and create draft pull request</button></>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
