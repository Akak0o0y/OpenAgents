import { useState } from 'react';
import { AvatarDesigner } from './AvatarDesigner.js';
import { Modal } from './ui/Overlay.js';
import { Button, IconButton } from './ui/Button.js';
import { Icon } from './ui/icons.js';
import { generateAvatarFromPrompt, toProfilePatch } from '../lib/avatarFromPrompt.js';
import type { BotProfile } from '../lib/botProfile.js';

export function AvatarStudio({ name, profile, onSave, onClose }: {
  name: string;
  profile: BotProfile;
  onSave: (profile: BotProfile) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(profile);
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <Modal label="Avatar studio" className="oh-avatar-studio oh-avatar-atelier-dialog" onClose={() => { if (!saving) onClose(); }}>
    <header className="oh-dialog-head"><div><span className="oh-eyebrow">THE AVATAR ATELIER / {name}</span><h2>A familiar face. Entirely yours.</h2></div><IconButton disabled={saving} aria-label="Close avatar studio" onClick={onClose}><Icon name="close" /></IconButton></header>
    <div className="avatar-dialog-scroll"><fieldset disabled={saving} className="avatar-dialog-fieldset">
      <AvatarDesigner wide name={name} profile={draft} onChange={patch=>setDraft(current=>({...current,...patch}))}/>
      <details className="avatar-prompt-builder"><summary>Have a look in mind? Start with words.</summary>
        <label className="grok-form-label" htmlFor="oh-avatar-prompt">Start with a description</label>
        <textarea id="oh-avatar-prompt" rows={3} placeholder="A calm blue researcher, soft and curious…" value={prompt} onChange={event => setPrompt(event.target.value)} />
        <Button kind="secondary" disabled={!prompt.trim() || saving} onClick={() => { const generated = generateAvatarFromPrompt(prompt); if (generated) setDraft(current => ({ ...current, ...toProfilePatch(generated) })); }}><Icon name="edit" size={15} /> Create a variation</Button>
        <small className="grok-field-hint">Matches your words to shapes and colors locally.</small>
      </details>
      {profile.avatarImage && <Button kind="secondary" onClick={() => setDraft(current=>({...current,avatarImage:profile.avatarImage}))}>Restore uploaded avatar</Button>}
      <p className="avatar-attribution">All twelve silhouettes are OpenAgents-original geometry. The expression engine and emotion data are Aora's, free for non-commercial use and separately licensable. <a href="/vendor/aora/LICENSE" target="_blank" rel="noreferrer">Licence</a></p>
    </fieldset></div>
    {error && <p role="alert" className="grok-field-error">{error}</p>}
    <footer className="avatar-dialog-footer"><p>One identity across your workspace.<br/>Changes stay in this studio until you save.</p><div><Button kind="secondary" disabled={saving} onClick={onClose}>Cancel</Button><Button kind="primary" disabled={saving} onClick={async () => { setSaving(true); setError(''); try { await onSave(draft); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save avatar.'); } finally { setSaving(false); } }}>{saving ? 'Saving…' : 'Save identity'}<Icon name="done" size={15}/></Button></div></footer>
  </Modal>;
}
