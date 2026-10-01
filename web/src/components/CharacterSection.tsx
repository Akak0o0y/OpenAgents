import { useEffect, useState } from 'react';
import { characterClient, type CharacterState } from '../lib/character.js';
import { CharacterStudio } from './CharacterStudio.js';
import {composeInChat} from '../lib/compose.js';
import './CharacterStudio.css';

export function CharacterSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [state, setState] = useState<CharacterState | null>(null);
  const [error, setError] = useState(''); const [open, setOpen] = useState(false); const [revision, refresh] = useState(0);
  useEffect(() => {
    const ac = new AbortController(); setState(null); setError('');
    characterClient.get(agentId, ac.signal).then(value => { if (!ac.signal.aborted) setState(value); }, e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load character.'); });
    return () => ac.abort();
  }, [agentId, revision]);
  useEffect(() => { setOpen(false); }, [agentId]);
  return <section className="character-entry" aria-label="Character"><div className="character-entry-heading"><h3>Character</h3>{state && <span className="character-entry-status">{state.settings.mode === 'off' ? 'Not enabled' : `${state.settings.mode} mode`}</span>}</div>
    <p>A recognizable voice. A point of view. A personality that feels like {agentName}.</p>
    {error ? <p role="alert">{error}</p> : state ? <p className="character-entry-meta">Version {state.version}{state.summary?.savedAt ? ` · Saved ${new Date(state.summary.savedAt).toLocaleDateString()}` : ' · Draft your character to get started'}</p> : <p>Loading character…</p>}
    <div className="character-entry-actions"><button className="character-primary" onClick={() => setOpen(true)}>Open character studio</button>
    <button onClick={()=>composeInChat(agentId,'Help me set up your character with quick setup. Draft it with propose_character and show me the approval card before changing anything.')}>Set up in chat</button>
    <button onClick={()=>composeInChat(agentId,'Help me design your character with the guided interview in propose_character. Ask the server-provided questions in groups, at most eight, then show me a draft to approve.')}>Guided interview</button>
    </div>
    {open && <CharacterStudio key={agentId} agentId={agentId} agentName={agentName} onClose={() => { setOpen(false); refresh(n => n + 1); }} onSaved={() => refresh(n => n + 1)} />}
  </section>;
}
