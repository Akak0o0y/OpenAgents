import { useEffect, useRef, useState } from 'react';
import { characterClient, type CharacterPostItem, type CharacterPostDetail, type CharacterPostMetrics } from '../lib/character.js';

interface Props { agentId: string; agentName: string; version: number; dirty: boolean; onSaved(): void }
export function CharacterPosts(props: Props) { return <Posts key={`${props.agentId}:${props.version}`} {...props} />; }
function Posts({ agentId, agentName, version, dirty, onSaved }: Props) {
  const [items, setItems] = useState<CharacterPostItem[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<CharacterPostMetrics | null>(null), [detail, setDetail] = useState<CharacterPostDetail | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  async function request<T>(work: (s: AbortSignal) => Promise<T>, accept: (v: T) => void) {
    if (controller.current) return;
    const c = new AbortController(); controller.current = c; setBusy(true); setError('');
    try { const v = await work(c.signal); if (!c.signal.aborted) accept(v); }
    catch (e) { if (!c.signal.aborted) setError((e as { code?: string }).code === 'CharacterConflict' ? 'Changed elsewhere — reload the character before promoting.' : e instanceof Error ? e.message : 'Post history failed.'); }
    finally { if (controller.current === c) { controller.current = null; setBusy(false); } }
  }
  function load() { void request(s => Promise.all([characterClient.posts(agentId, undefined, s), version > 0 ? characterClient.metrics(agentId, version, s) : Promise.resolve(null)]), ([page, m]) => { setItems(page.items); setCursor(page.nextCursor); setMetrics(m); }); }
  useEffect(() => { load(); return () => { controller.current?.abort(); controller.current = null; }; }, []);
  const safeUrl = (value: string) => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined; } catch { return undefined; } };
  return <section aria-label="Character post history">
    <h3>Posts and checks</h3>
    <button disabled={busy} onClick={load}>Refresh posts</button>
    {busy && <p role="status">Loading post history…</p>}{error && <p role="alert">{error}</p>}
    {metrics && <>
      <p>{metrics.n} confirmed posts with final reviews. {metrics.mean ? `Mean voice ${metrics.mean.voice.toFixed(1)}, fit ${metrics.mean.fit.toFixed(1)}, consistency ${metrics.mean.consistency.toFixed(1)}.` : 'No scored posts yet.'}</p>
      <p>Revise rate: {metrics.reviseRate === null ? 'unavailable' : `${Math.round(metrics.reviseRate * 100)}%`}; hold rate: {metrics.holdRate === null ? 'unavailable' : `${Math.round(metrics.holdRate * 100)}%`}.</p>
      <p>Character-call cost per confirmed post: {metrics.costPerConfirmed.knownUsd === null ? 'unavailable' : `$${metrics.costPerConfirmed.knownUsd.toFixed(4)} known`}; {metrics.costPerConfirmed.unknownCalls} calls with unknown pricing or usage.</p>
      {metrics.storage.usedBytes >= metrics.storage.quotaBytes * .8 && <p role="alert">History is nearly full. New preparations will be held when the quota is exceeded.</p>}
    </>}
    <p>Cached tokens: unavailable. Unchecked posts have no semantic scores.</p>
    {!busy && !items.length && <p>No prepared posts yet.</p>}
    {items.map(item => <article key={item.id} className="character-example">
      <p><strong>{item.status}</strong> · {item.semantic ?? 'not reviewed'}{item.statusReason ? ` · ${item.statusReason}` : ''}</p>
      <p>{item.finalCandidate?.text ?? 'No final candidate.'}</p>
      <p>{new Date(item.createdAt).toLocaleString()} · version {item.version} · {item.calls.logical} calls · {item.calls.wire ?? 'unknown'} wire attempts</p>
      <p>${item.cost.knownUsd.toFixed(4)} known{item.cost.unknownCalls > 0 ? ` plus ${item.cost.unknownCalls} calls with unknown cost` : ''}</p>
      {item.semantic === 'passed' && item.finalCandidate?.scores && <p>Voice {item.finalCandidate.scores.voice}; fit {item.finalCandidate.scores.fit}; consistency {item.finalCandidate.scores.consistency}</p>}
      {item.finalCandidate?.reviewer && <p>{item.finalCandidate.reviewer.sameAsAuthor ? `${agentName} is checking his own writing` : `Reviewer: ${item.finalCandidate.reviewer.model ?? 'unknown'}`}</p>}
      {item.postUrl && safeUrl(item.postUrl) && <a href={safeUrl(item.postUrl)} target="_blank" rel="noreferrer">Open post</a>}
      <button disabled={busy} onClick={() => void request(s => characterClient.post(agentId, item.id, s), setDetail)}>View candidates and evidence</button>
      <button disabled={busy || dirty || !item.finalCandidate} title={dirty ? 'Save or discard your edits first.' : undefined}
        onClick={() => void request(s => characterClient.promote(agentId, version, item.id, s), () => onSaved())}>Use as example</button>
    </article>)}
    {cursor && <button disabled={busy} onClick={() => void request(s => characterClient.posts(agentId, cursor, s), page => {
      setItems(old => [...old, ...page.items.filter(p => !old.some(o => o.id === p.id))]); setCursor(page.nextCursor);
    })}>Load more posts</button>}
    {detail && <section aria-label="Post detail"><h4>Candidates and evidence</h4><button onClick={() => setDetail(null)}>Close post detail</button>
      {detail.candidates.map(c => <article key={c.id}><h4>Attempt {c.attempt}</h4><p>{c.text}</p>
        <details><summary>Reviews, findings and evidence</summary><pre>{JSON.stringify({ reviews: c.reviews, evidence: c.evidence }, null, 2)}</pre></details></article>)}
      <p>Publication outcome: {detail.utterance.status}</p><pre>{JSON.stringify(detail.stage1, null, 2)}</pre>
    </section>}
  </section>;
}
