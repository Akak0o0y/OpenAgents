import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui/Overlay.js';
import { characterClient, editableCharacter, sliderPhrase, sliderPhrases, type CharacterDocument, type CharacterState,
  type CharacterSettings, type CharacterInspection, type CharacterPreviewResult, type CharacterVersion, type TryItSituation } from '../lib/character.js';
import './CharacterStudio.css';
import { CharacterPosts } from './CharacterPosts.js';
import { CharacterMemory } from './CharacterMemory.js';
import { CharacterGrowth } from './CharacterGrowth.js';
import { CharacterAudit } from './CharacterAudit.js';
import { postJson } from '../lib/transport.js';
import type { CharacterProposal } from '@kernel/daemon/character-proposals.js';
import { Fingerprint, MessageCircle, SlidersHorizontal, ShieldCheck, FlaskConical, History, FileText, BookOpen, Clock, Sprout, ScanLine, X, Check, ArrowRight } from 'lucide-react';

interface Props { agentId: string; agentName: string; onClose: () => void; onSaved: () => void; proposal?: CharacterProposal; onProposalSaved?: (p:CharacterProposal)=>void }
const tabs = ['Basics', 'Voice', 'Personality', 'Standards', 'Inspect & try', 'Versions', 'Posts', 'Memory', 'Rhythm', 'Growth', 'Audit'] as const;
const sectionInfo = {
  Basics: { icon: Fingerprint, title: 'Give your bot an identity', description: 'Start with who they are, what they care about and who they help.' },
  Voice: { icon: MessageCircle, title: 'Make it sound like them', description: 'Real examples teach a voice better than a list of adjectives.' },
  Personality: { icon: SlidersHorizontal, title: 'A personality of their own', description: 'Choose how they approach ideas, conversations and disagreements.' },
  Standards: { icon: ShieldCheck, title: 'Set clear boundaries', description: 'Define what to avoid and how writing should be checked.' },
  'Inspect & try': { icon: FlaskConical, title: 'Meet the character', description: 'Inspect the instructions for free, or run an unsent sample with your model.' },
  Versions: { icon: History, title: 'Your character, over time', description: 'Inspect earlier versions and restore one when you need to.' },
  Posts: { icon: FileText, title: 'Writing & results', description: 'Review prepared writing and its recorded checks.' },
  Memory: { icon: BookOpen, title: 'What they remember', description: 'Manage the context and knowledge behind the character.' },
  Rhythm: { icon: Clock, title: 'Find their rhythm', description: 'Set posting windows, quiet days and daily limits.' },
  Growth: { icon: Sprout, title: 'Room to grow', description: 'Choose where experience can inform suggested changes.' },
  Audit: { icon: ScanLine, title: 'Review & confidence', description: 'Understand the checks behind your character’s writing.' },
};
const navGroups = [{ label: 'Create', names: ['Basics', 'Voice', 'Personality', 'Standards'] }, { label: 'Explore', names: ['Inspect & try', 'Memory', 'Rhythm', 'Growth'] }, { label: 'History', names: ['Posts', 'Versions', 'Audit'] }] as const;
const modes = [{ value: 'off', title: 'Off', description: 'Use the bot’s usual instructions. Keep your character draft for later.' }, { value: 'voice', title: 'Voice', description: 'Give their writing a distinct style, without a full persona.' }, { value: 'character', title: 'Character', description: 'Add identity, purpose and personality alongside their voice.' }] as const;
const sliderLabels = { curious: ['Practical', 'Exploratory'], organised: ['Spontaneous', 'Structured'], outgoing: ['Reserved', 'Expressive'], agreeable: ['Direct', 'Accommodating'], sensitive: ['Steady', 'Emotionally open'] } as const;
const growthLabels: Record<string, string> = { 'voice.examples': 'Voice examples', 'voice.rules.do': 'Writing guidance', 'voice.rules.dont': 'Writing to avoid', 'standards.never': 'Firm boundaries', 'standards.avoidTopics': 'Topics to avoid', commitments: 'Commitments', backgroundFacts: 'Background facts', relationships: 'Relationships', currentFocus: 'Current focus' };
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
const message = (error: unknown) => error instanceof Error ? error.message : 'Character request failed.';

function ListField({ label, values, onChange, comma = false }: { label: string; values: string[]; onChange: (v: string[]) => void; comma?: boolean }) {
  const parse = (s: string) => comma ? s.split(',').map(v => v.trim()).filter(Boolean) : lines(s);
  const [text, setText] = useState(values.join(comma ? ', ' : '\n'));
  useEffect(() => { if (JSON.stringify(parse(text)) !== JSON.stringify(values)) setText(values.join(comma ? ', ' : '\n')); }, [values]);
  return <label className="character-field">{label}<textarea aria-label={label} value={text} rows={comma ? 1 : 3} onChange={e => { setText(e.target.value); onChange(parse(e.target.value)); }} /></label>;
}

export function CharacterStudio(props: Props) { return <Studio key={props.agentId} {...props} />; }

function Studio({ agentId, agentName, onClose, onSaved, proposal, onProposalSaved }: Props) {
  const [proposalRevision,setProposalRevision]=useState(proposal);
  const [saved, setSaved] = useState<CharacterState | null>(null);
  const [document, setDocument] = useState<CharacterDocument | null>(null);
  const [settings, setSettings] = useState<CharacterSettings | null>(null);
  const [tab, setTab] = useState<typeof tabs[number]>('Basics');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<CharacterState | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<CharacterVersion | null>(null);
  const [inspection, setInspection] = useState<CharacterInspection | null>(null);
  const [preview, setPreview] = useState<CharacterPreviewResult | null>(null);
  const [surface, setSurface] = useState('owner-chat');
  const [situationType, setSituationType] = useState<TryItSituation['type']>('post');
  const [situationText, setSituationText] = useState('A small thing that made your day better');
  const [closing, setClosing] = useState(false);
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dirty = !!saved && (JSON.stringify(document) !== JSON.stringify(saved.document) || JSON.stringify(settings) !== JSON.stringify(saved.settings));
  const hydrate = (state: CharacterState) => {
    setSaved(state); setDocument(structuredClone(state.document)); setSettings(structuredClone(state.settings));
    setConflict(false); setComparison(null); setSelectedVersion(null); setInspection(null); setPreview(null);
  };
  async function request<T>(label: string, action: (signal: AbortSignal) => Promise<T>, receive: (value: T) => void) {
    if (current.current) return;
    const controller = new AbortController(); current.current = controller; setBusy(label); setError('');
    try { const value = await action(controller.signal); if (mounted.current && !controller.signal.aborted) receive(value); }
    catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        setError(message(e));
        if (e && typeof e === 'object' && 'status' in e && e.status === 409 && ['Saving', 'Reverting'].includes(label)) setConflict(true);
      }
    } finally { if (current.current === controller) { current.current = null; if (mounted.current) setBusy(''); } }
  }
  useEffect(() => {
    mounted.current = true;
    void request('Loading', signal => characterClient.get(agentId, signal), state=>hydrate(proposalRevision?{...state,version:proposalRevision.baseVersion,document:proposalRevision.draft.document as CharacterDocument,settings:proposalRevision.draft.settings as CharacterSettings}:state));
    return () => { mounted.current = false; current.current?.abort(); current.current = null; };
  }, [agentId]);
  function edit(fn: (draft: CharacterDocument) => void) {
    if (!document) return;
    const copy = structuredClone(document); fn(copy); setDocument(copy); setInspection(null); setPreview(null);
  }
  function configure(fn: (draft: CharacterSettings) => void) {
    if (!settings) return;
    const copy = structuredClone(settings); fn(copy); setSettings(copy); setInspection(null); setPreview(null);
  }
  const draft = () => ({ document: editableCharacter(document!), settings: settings! });
  function save() {
    if (!saved || !document || !settings || !dirty) return;
    void request('Saving', async signal => {
      if(proposalRevision){
        const p=await postJson<CharacterProposal>('/api/system/character-proposal-edit',{agentId,proposalId:proposalRevision.proposalId,revision:proposalRevision.revision,changeHash:proposalRevision.changeHash,changes:{draft:draft()}},signal);
        setProposalRevision(p);onProposalSaved?.(p);
        return {...saved,document:p.draft.document as CharacterDocument,settings:p.draft.settings as CharacterSettings};
      }
      await characterClient.save(agentId, saved.version, draft(), signal);
      return characterClient.get(agentId, signal);
    }, value => { hydrate(value); onSaved(); });
  }
  function cancel() { current.current?.abort(); current.current = null; setBusy(''); setError('Preview cancelled. Dispatched calls may still be charged.'); }
  function close() { if (dirty) setClosing(true); else { current.current?.abort(); onClose(); } }
  const field = (label: string, value: string, set: (s: string) => void, max?: number, multiline = true) =>
    <label className="character-field"><span className="character-field-label">{label}{max && <small>{value.length}/{max}</small>}</span>{multiline ? <textarea aria-label={label} value={value} maxLength={max} rows={3} onChange={e => set(e.target.value)} />
      : <input aria-label={label} value={value} maxLength={max} onChange={e => set(e.target.value)} />}</label>;
  const select = (label: string, value: string, values: readonly string[], set: (s: string) => void) =>
    <label className="character-field">{label}<select aria-label={label} value={value} onChange={e => set(e.target.value)}>{values.map(v => <option key={v}>{v}</option>)}</select></label>;
  const list = (label: string, values: string[], set: (v: string[]) => void) => <ListField label={`${label} (one per line)`} values={values} onChange={set} />;
  return <Modal open onClose={close} label={`${agentName} character studio`} className="character-studio" initialFocusSelector="[data-character-close]">
    <div className="character-shell" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); } }}>
      <header className="character-header"><div className="character-brand"><span className="character-monogram" aria-hidden="true">{agentName.slice(0, 1).toUpperCase()}</span><div><span className="character-eyebrow">Character studio</span><h2>{agentName}</h2></div></div><button className="character-close" data-character-close aria-label="Close" onClick={close}><X size={19}/></button></header>
      <div className="character-notices" aria-live="polite">
      {error && <p role="alert">{error}</p>}
      {!saved && !busy && <button onClick={() => void request('Loading', s => characterClient.get(agentId, s), hydrate)}>Retry loading</button>}
      {busy && <p role="status">{busy}…</p>}
      {closing && <div role="alert"><p>Discard unsaved character edits?</p><button onClick={() => setClosing(false)}>Keep editing</button><button onClick={() => { current.current?.abort(); onClose(); }}>Discard edits and close</button></div>}
      </div>
      {saved && document && settings && <>
        <div className="character-layout">
        <aside className="character-sidebar"><nav role="tablist" aria-label="Character sections" aria-orientation="vertical" onKeyDown={e => {
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = buttons.indexOf(e.target as HTMLButtonElement);
          if (index < 0 || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus(); buttons[next].click();
        }}>{navGroups.map(group => <div className="character-nav-group" key={group.label}><span className="character-eyebrow">{group.label}</span>{group.names.filter(name=>!proposalRevision||!['Versions','Posts','Memory','Audit'].includes(name)).map(name => { const Icon = sectionInfo[name].icon; return <button key={name} id={`character-tab-${name.replaceAll(' ', '-')}`} role="tab" aria-controls="character-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}><Icon size={17} aria-hidden="true"/><span>{name}</span>{tab === name && <span className="character-nav-dot"/>}</button>; })}</div>)}</nav><p className="character-sidebar-note">A character shapes expression.<br/>Your instructions stay in charge.</p></aside>
        <div className="character-content" id="character-panel" role="tabpanel" aria-label={tab} tabIndex={0} key={tab}>
        <div className="character-page-heading"><span className="character-eyebrow">{tab === 'Basics' ? 'The foundation' : tab}</span><h3>{sectionInfo[tab].title}</h3><p>{sectionInfo[tab].description}</p></div>
        <fieldset disabled={!!busy} className="character-fields">
        {tab==='Memory'&&<CharacterMemory agentId={agentId} version={saved.version} onSaved={()=>void request('Loading',s=>characterClient.get(agentId,s),hydrate)}/>}
        {tab==='Audit'&&<><label>Requested review policy<select value={settings.checks.sampling} onChange={e=>configure(s=>{s.checks.sampling=e.target.value as 'all'|'adaptive';})}><option value="all">Review every post</option><option value="adaptive">Adaptive when independently qualified</option></select></label><p>Requesting adaptive mode never bypasses qualification or high-risk checks.</p><CharacterAudit agentId={agentId}/></>}
        {tab==='Growth'&&<section><h3>Growth</h3>
          <label><input type="checkbox" checked={settings.growth.review==='on'} onChange={e=>configure(s=>{s.growth.review=e.target.checked?'on':'off';})}/>Review growth when enough evidence is available</label>
          <label><input type="checkbox" checked={settings.growth.readEngagement} onChange={e=>configure(s=>{s.growth.readEngagement=e.target.checked;})}/>Read own post engagement</label>
          <h4 className="character-divider-heading">Where suggestions are welcome</h4>
          {Object.entries(growthLabels).map(([section,label])=><label key={section}><input type="checkbox" checked={settings.growth.maySuggest?.includes(section)??false} onChange={e=>configure(s=>{const allowed=s.growth.maySuggest??[];s.growth.maySuggest=e.target.checked?[...allowed,section]:allowed.filter(v=>v!==section);})}/>{label}</label>)}
          {!proposalRevision&&<CharacterGrowth agentId={agentId} dirty={dirty}/>}
        </section>}
        {tab==='Rhythm'&&<section><h3>Posting rhythm</h3><p>Times use {document.identity.timezone}. Pending sends count toward the daily cap. Run now skips the window and jitter.</p>
          <label><input type="checkbox" checked={!!settings.rhythm} onChange={e=>configure(s=>{s.rhythm=e.target.checked?{activeFrom:'09:00',activeTo:'21:00',maxPostsPerDay:3,quietDays:[],jitterMinutes:0}:null;})}/>Use a posting rhythm</label>
          {settings.rhythm&&<>
            {field('Active from',settings.rhythm.activeFrom,v=>configure(s=>{s.rhythm!.activeFrom=v;}),5,false)}
            {field('Active to',settings.rhythm.activeTo,v=>configure(s=>{s.rhythm!.activeTo=v;}),5,false)}
            <label>Daily cap<input type="number" min={1} max={96} value={settings.rhythm.maxPostsPerDay} onChange={e=>configure(s=>{s.rhythm!.maxPostsPerDay=Number(e.target.value);})}/></label>
            <label>Jitter minutes<input type="number" min={0} max={60} value={settings.rhythm.jitterMinutes} onChange={e=>configure(s=>{s.rhythm!.jitterMinutes=Number(e.target.value);})}/></label>
            {(['mon','tue','wed','thu','fri','sat','sun'] as const).map(day=><label key={day}><input type="checkbox" checked={Array.isArray(settings.rhythm!.quietDays)&&settings.rhythm!.quietDays.includes(day)} onChange={e=>configure(s=>{const days=Array.isArray(s.rhythm!.quietDays)?s.rhythm!.quietDays:[];s.rhythm!.quietDays=e.target.checked?[...days,day]:days.filter(v=>v!==day);})}/>{day} quiet</label>)}
          </>}
        </section>}
          {tab === 'Posts' && <CharacterPosts agentId={agentId} agentName={agentName} version={saved.version} dirty={dirty}
            onSaved={() => void request('Loading', s => characterClient.get(agentId, s), value => { hydrate(value); onSaved(); })} />}
          {tab === 'Basics' && <>
            <div className="character-mode-options" role="radiogroup" aria-label="Mode">{modes.map(mode => <label className={`character-mode-card ${settings.mode === mode.value ? 'is-selected' : ''}`} key={mode.value}><input type="radio" name="character-mode" value={mode.value} checked={settings.mode === mode.value} onChange={() => configure(d => { d.mode = mode.value; })}/><span><strong>{mode.title}</strong><span>{mode.description}</span></span></label>)}</div>
            <div className="character-setup-note"><Check size={16} aria-hidden="true"/><span>{settings.mode === 'off' ? 'Draft at your own pace. Your bot’s behavior stays unchanged until you enable a mode and save.' : 'To enable: a one-line identity and 3 voice examples' + (settings.mode === 'character' ? ', plus a purpose.' : '.')}</span><button onClick={() => setTab('Voice')}>{document.voice.examples.filter(e => e.text.trim()).length}/3 examples <ArrowRight size={14}/></button></div>
            <section className="character-form-section"><h4>Identity</h4><p>The essentials that make this character recognizable.</p><div className="character-form-grid">
            {field('Character name', document.identity.name, s => edit(d => { d.identity.name = s; }), 80, false)}
            {field('Handle (optional)', document.identity.handle ?? '', s => edit(d => { if (s) d.identity.handle = s; else delete d.identity.handle; }), 31, false)}
            </div>
            {field('One-line identity', document.identity.oneLine, s => edit(d => { d.identity.oneLine = s; }), 240)}
            <div className="character-form-grid">
            <ListField label="Languages (comma separated)" values={document.identity.languages} comma onChange={v => edit(d => { d.identity.languages = v; })} />
            {field('Timezone', document.identity.timezone, s => edit(d => { d.identity.timezone = s; }), 100, false)}
            </div></section>
            <section className="character-form-section"><h4>Purpose & audience</h4><p>Give them a reason to speak and someone to speak to.</p>
            {field('Purpose', document.purpose.statement, s => edit(d => { d.purpose.statement = s; }), 400)}
            {field('Audience', document.purpose.audience, s => edit(d => { d.purpose.audience = s; }), 240)}
            {list('Topics', document.purpose.topics, s => edit(d => { d.purpose.topics = s; }))}
            {list('Success looks like', document.purpose.success, s => edit(d => { d.purpose.success = s; }))}
            </section>
          </>}
          {tab === 'Voice' && <>
            <p>At least three examples to enable a character. Pin up to two. Each example is at most 600 characters.</p>
            {document.voice.examples.map((example, i) => <section key={example.id} className="character-example">
              <div className="character-example-heading"><span className="character-eyebrow">Voice sample {String(i + 1).padStart(2, '0')}</span><span>{example.pinned ? 'Pinned' : example.surface}</span></div>
              {field(`Example ${i + 1}`, example.text, s => edit(d => { d.voice.examples[i].text = s; }), 600)}
              <label><input type="checkbox" checked={example.pinned} onChange={e => edit(d => { d.voice.examples[i].pinned = e.target.checked; })} />Pin example {i + 1}</label>
              <details className="character-example-details"><summary>Context & tags</summary><div className="character-form-grid">
              {select(`Example ${i + 1} surface`, example.surface, ['post', 'reply', 'chat'], s => edit(d => { d.voice.examples[i].surface = s as typeof example.surface; }))}
              {field(`Example ${i + 1} language`, example.language ?? '', s => edit(d => { if (s) d.voice.examples[i].language = s; else delete d.voice.examples[i].language; }), 40, false)}
              <ListField label={`Example ${i + 1} tags`} values={example.tags} comma onChange={v => edit(d => { d.voice.examples[i].tags = v; })} />
              </div></details>
              <button onClick={() => edit(d => { d.voice.examples.splice(i, 1); })}>Remove example {i + 1}</button>
            </section>)}
            <button disabled={document.voice.examples.length >= 12} onClick={() => edit(d => { d.voice.examples.push({ id: crypto.randomUUID(), text: '', surface: 'post', pinned: false, tags: [], origin: 'owner' }); })}>Add example</button>
            <h4 className="character-divider-heading">Writing preferences</h4>
            {select('Casing', document.voice.rules.casing, ['normal', 'lowercase', 'sentence'], s => edit(d => { d.voice.rules.casing = s as typeof d.voice.rules.casing; }))}
            {select('Emoji', document.voice.rules.emoji, ['never', 'rare', 'sometimes', 'often'], s => edit(d => { d.voice.rules.emoji = s as typeof d.voice.rules.emoji; }))}
            {list('Signature words', document.voice.rules.signatureWords, s => edit(d => { d.voice.rules.signatureWords = s; }))}
            {list('Do', document.voice.rules.do, s => edit(d => { d.voice.rules.do = s; }))}
            {list('Do not', document.voice.rules.dont, s => edit(d => { d.voice.rules.dont = s; }))}
            {list('Avoid phrases', document.voice.avoidPhrases, s => edit(d => { d.voice.avoidPhrases = s; }))}
            <label><input type="checkbox" checked={document.voice.aiPhrasing} onChange={e => edit(d => { d.voice.aiPhrasing = e.target.checked; })} />Check common AI phrasing (advisory)</label>
            {(['min', 'max'] as const).map(k => <label key={k}>Post length {k}<input aria-label={`Post length ${k}`} type="number" min={0} max={280} value={document.voice.postRules.length[k]} onChange={e => edit(d => { d.voice.postRules.length[k] = Number(e.target.value); })} /></label>)}
            <label>Maximum hashtags<input aria-label="Maximum hashtags" type="number" min={0} max={3} value={document.voice.postRules.hashtags} onChange={e => edit(d => { d.voice.postRules.hashtags = Number(e.target.value); })} /></label>
            {select('Links', document.voice.postRules.links, ['never', 'sometimes'], s => edit(d => { d.voice.postRules.links = s as typeof d.voice.postRules.links; }))}
          </>}
          {tab === 'Personality' && <>
            <div className="character-slider-grid">{(Object.keys(sliderPhrases) as (keyof typeof sliderPhrases)[]).map(name => <label className="character-slider-card" key={name}><span className="character-slider-title">{name}<small>{document.personality.sliders[name]} / 5</small></span>
              <input aria-label={name} type="range" min="1" max="5" value={document.personality.sliders[name]} onChange={e => edit(d => { d.personality.sliders[name] = Number(e.target.value); })} />
              <span className="character-slider-ends"><span>{sliderLabels[name][0]}</span><span>{sliderLabels[name][1]}</span></span>
              <span className="character-slider-hint">{sliderPhrase(name, document.personality.sliders[name])}</span></label>)}</div>
            {select('Humour', document.personality.humour, ['none', 'dry', 'playful', 'absurd', 'dark', 'wholesome'], s => edit(d => { d.personality.humour = s as typeof d.personality.humour; }))}
            {list('Quirks', document.personality.quirks, s => edit(d => { d.personality.quirks = s; }))}
            {document.personality.dispositions.map((disposition, i) => <section key={disposition.id}>
              {field(`Disposition ${i + 1}: when`, disposition.when, s => edit(d => { d.personality.dispositions[i].when = s; }), 90)}
              {field(`Disposition ${i + 1}: then`, disposition.then, s => edit(d => { d.personality.dispositions[i].then = s; }), 90)}
              <button onClick={() => edit(d => { d.personality.dispositions.splice(i, 1); })}>Remove disposition {i + 1}</button>
            </section>)}
            <button disabled={document.personality.dispositions.length >= 6} onClick={() => edit(d => { d.personality.dispositions.push({ id: crypto.randomUUID(), when: '', then: '' }); })}>Add disposition</button>
          </>}
          {tab === 'Standards' && <>
            {select('Checker outage', settings.checks.outage, ['rules-only', 'hold'], s => configure(d => { d.checks.outage = s as 'rules-only' | 'hold'; }))}
            <p>{settings.checks.outage === 'hold' ? 'If the reviewer is unavailable, hold posts until they can be checked.' : 'If the reviewer is unavailable, only free checks run. Meaning-based standards, including avoided topics, are not checked for those posts.'}</p>
            {list('Never', document.standards.never, s => edit(d => { d.standards.never = s; }))}
            {list('Avoid topics', document.standards.avoidTopics, s => edit(d => { d.standards.avoidTopics = s; }))}
            {select('Invented details', settings.checks.inventedDetails, ['everyday-only', 'allowed', 'none'], s => configure(d => { d.checks.inventedDetails = s as typeof d.checks.inventedDetails; }))}
            <label className="character-field">Reviewer<select aria-label="Reviewer" value={settings.checks.reviewer ? JSON.stringify(settings.checks.reviewer) : ''} onChange={e => configure(d => { d.checks.reviewer = e.target.value ? JSON.parse(e.target.value) : null; })}>
              <option value="">Automatic: fallback model, otherwise author model</option>
              {settings.checks.reviewer && !saved.reviewerOptions.some(o => o.modelId === settings.checks.reviewer?.modelId && o.connectionId === settings.checks.reviewer?.connectionId) && <option value={JSON.stringify(settings.checks.reviewer)}>Saved reviewer unavailable or not in catalog</option>}
              {saved.reviewerOptions.map(o => <option key={`${o.connectionId}/${o.modelId}`} value={JSON.stringify({ modelId: o.modelId, connectionId: o.connectionId })}>{o.label} · {o.price ? `$${o.price.inputPerMillion}/million input tokens` : 'price unavailable'} · {o.availability}</option>)}
            </select></label>
            <p>Different model names do not guarantee independent review.</p>
          </>}
          {tab === 'Inspect & try' && <>
            {select('Packet surface', surface, ['owner-chat', 'public-compose', 'public-review', 'task-loop', 'code'], setSurface)}
            <button onClick={() => void request('Inspecting', s => characterClient.compile(agentId, draft(), surface, s), setInspection)}>Inspect draft (free)</button>
            {inspection && <section><h3>What {agentName} will be told</h3><p>{inspection.inspection?.label}</p>{inspection.inspection?.warning && <p role="note">{inspection.inspection.warning}</p>}
              {inspection.inspection?.prompts.map(p => <details key={p.mode} open={p.mode === 'native'}><summary>Full owner-chat prompt ({p.mode})</summary><h4>System</h4><pre>{p.system}</pre>{p.messages.map((m, i) => <div key={i}><h4>{m.role} message</h4><pre>{m.content}</pre></div>)}</details>)}
              <p>Card: {inspection.packet.meta.stableChars} characters · Data: {inspection.packet.meta.dataChars} characters</p>
              <details><summary>Compiled card and data</summary><pre>{inspection.packet.stable}</pre><pre>{inspection.packet.data}</pre></details>
              {inspection.packet.meta.omissions.map((o, i) => <p key={i}>Omitted: {o}</p>)}
            </section>}
            {select('Try situation', situationType, ['post', 'reply', 'challenge', 'chat'], s => setSituationType(s as TryItSituation['type']))}
            {field('Situation text', situationText, setSituationText, situationType === 'post' ? 500 : 1000)}
            <p>Explicit paid preview: at most one author call and one review. Nothing is sent or saved. Uses this bot’s model budget.</p>
            <button onClick={() => {
              const situation: TryItSituation = situationType === 'post' ? { type: 'post', about: situationText }
                : situationType === 'chat' ? { type: 'chat', message: situationText } : { type: situationType, targetText: situationText };
              void request('Trying', s => characterClient.preview(agentId, draft(), situation, s), setPreview);
            }}>Try it — uses model budget</button>
            {preview && <section aria-label="Unsent preview"><h3>Unsent · {preview.semanticState}</h3><pre>{preview.candidateText}</pre>
              <p>Free checks: {preview.ruleResult.hardPass ? 'passed' : 'failed'}</p>
              {[...preview.ruleResult.hardFindings, ...preview.ruleResult.advisoryFindings].map((f, i) => <p key={i}>{f.code}: {f.message}</p>)}
              {preview.review && <><p>Voice {preview.review.scores.voice}/5 · Fit {preview.review.scores.fit}/5 · Consistency {preview.review.scores.consistency}/5</p>{preview.review.findings.map((f, i) => <p key={i}>{f.severity}: {f.reason}</p>)}</>}
              {preview.reviewer && <p>Reviewer: {preview.reviewer.modelId}{preview.reviewer.same_as_author ? ' (same model or independence unknown)' : ' (independence not guaranteed)'}</p>}
              <p>Calls: {preview.logicalCalls} · Transport attempts: {preview.wireAttempts ?? 'unavailable'}</p>
              <p>Cost: {preview.usage.costUsd === null ? 'unavailable' : `$${preview.usage.costUsd.toFixed(6)}`} · Cached tokens: unavailable</p>
              <p>Tokens: {preview.usage.inputTokens} input / {preview.usage.outputTokens} output</p>
              {preview.error && <p role="alert">{preview.error}</p>}
            </section>}
          </>}
          {tab === 'Versions' && <>
            <p>Current saved version: {saved.version}. Reverting creates a new version.</p>
            {(saved.versions ?? []).map(v => <p key={v.version}>v{v.version} · {v.origin} · {new Date(v.createdAt).toLocaleString()}
              <button onClick={() => void request('Loading version', s => characterClient.get(agentId, s, v.version), state => setSelectedVersion(state.selected ?? null))}>Inspect version {v.version}</button></p>)}
            {selectedVersion && <><h3>Selected version {selectedVersion.version}</h3><pre>{JSON.stringify({document:selectedVersion.document,settings:selectedVersion.settings}, null, 2)}</pre><h3>Current version {saved.version}</h3><pre>{JSON.stringify({document:saved.document,settings:saved.settings},null,2)}</pre><button onClick={() => void request('Reverting', async s => {
              await characterClient.revert(agentId, saved.version, selectedVersion.version, s); return characterClient.get(agentId, s);
            }, state => { hydrate(state); onSaved(); })}>Revert to version {selectedVersion.version}</button></>}
          </>}
        </fieldset>
        {busy === 'Trying' && <button onClick={cancel}>Cancel preview</button>}
        {conflict && <section><button disabled={!!busy} onClick={() => void request('Comparing', s => characterClient.get(agentId, s), setComparison)}>Compare with saved version</button>
          {comparison && <><h3>Current saved version {comparison.version}</h3><pre>{JSON.stringify({ document: comparison.document, settings: comparison.settings }, null, 2)}</pre><h3>Your unsaved draft</h3><pre>{JSON.stringify(draft(), null, 2)}</pre><button onClick={() => hydrate(comparison)}>Discard draft and load saved version</button></>}
        </section>}
        </div></div>
        <footer className="character-footer"><div><span className={`character-save-dot ${dirty ? 'is-dirty' : ''}`}/><span>{dirty ? 'Unsaved edits' : proposalRevision?`Proposal revision ${proposalRevision.revision}; not active`:`Saved version ${saved.version}`}</span><small>{proposalRevision ? 'Draft only · approval required' : 'Changes apply after saving'}</small></div><button className="character-primary" disabled={!dirty || !!busy} onClick={save}>{busy === 'Saving' ? 'Saving…' : proposalRevision?'Save proposal revision':'Save character'}<Check size={16}/></button></footer>
      </>}
    </div>
  </Modal>;
}
