/**
 * Bot settings, in the right-hand panel.
 *
 * Profile, model, appearance and connections have separate sections. Server
 * settings share an explicit save action; profile controls save on change.
 *
 * Saving is explicit for the server-owned fields (name, description, model,
 * budget) because a PATCH per keystroke would be a request storm and, on a
 * failed one, would leave the operator unsure what is stored. The panel-owned
 * fields (label, notifications, avatar) save on change to agent_data, which is
 * cheap, and report failure inline.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRound, Cpu, Palette, Plug, Check } from 'lucide-react';
import './BotWorkspace.css';
import { AvatarDesigner } from './AvatarDesigner.js';
import { BotFace } from './BotFace.js';
import { Popover } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { exportEmotionConfig, importEmotionConfig } from '../lib/aora-bot/index.js';
import { BOT_SHAPES, SHAPE_LABELS } from '../lib/aora-bot/shapes.js';
import { BOT_COLORS, MAX_AVATAR_BYTES, type BotProfile } from '../lib/botProfile.js';
import { generateAvatarFromPrompt, toProfilePatch } from '../lib/avatarFromPrompt.js';
import type { Teammate } from './workspaceTypes.js';
import { FormError } from './ui/FormError.js';
import { Button } from './ui/Button.js';
import { Input } from '@/registry/default/ui/input.js';
import { Textarea } from '@/registry/default/ui/textarea.js';
import { GrokModelSelector, modelSelectionError, type ModelSelection } from './GrokModelSelector.js';
import { BotToolsSection } from './BotToolsSection.js';
import { CharacterSection } from './CharacterSection.js';

interface GrokBotSettingsProps {
  agent: Teammate;
  onUpdateProfile: (patch: Partial<BotProfile>) => void;
  onSaveAgent: (patch: {
    name?: string;
    modelId?: string;
    systemPrompt?: string;
    budgetCapUsd?: number;
    connectionId?: string | null;
    routingMode?: 'pinned' | 'auto' | null;
  }) => Promise<void>;
  profileError: string | null;
  onOpenStudio?: () => void;
  connections?: ReactNode;
}


/** Bots without a connection carry no routing mode; a connection without one is pinned. */
function selectionOf(agent: Teammate): ModelSelection {
  return {
    modelId: agent.model,
    connectionId: agent.connectionId ?? null,
    routingMode: agent.connectionId ? agent.routingMode ?? 'pinned' : null,
  };
}

export function GrokBotSettings({
  agent,
  onUpdateProfile,
  onSaveAgent,
  profileError,
  onOpenStudio,
  connections,
}: GrokBotSettingsProps) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [selection, setSelection] = useState<ModelSelection>(() => selectionOf(agent));
  const [budget, setBudget] = useState(agent.budgetCapUsd);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [section, setSection] = useState<'Profile' | 'Model & budget' | 'Appearance' | 'Connections'>('Profile');
  const [configText, setConfigText] = useState('');
  const [configMessage, setConfigMessage] = useState('');
  const avatarRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setName(agent.name);
    setDescription(agent.description);
    setSelection(selectionOf(agent));
    setBudget(agent.budgetCapUsd);
    setSaveError('');
    setAvatarOpen(false);
  }, [agent.id, agent.name, agent.description, agent.model, agent.connectionId, agent.routingMode, agent.budgetCapUsd]);


  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? 'A bot needs a name.'
    : trimmedName.length > 80
      ? 'Names are limited to 80 characters.'
      : '';
  const modelError = modelSelectionError(selection);
  const budgetError = !(budget > 0) ? 'The budget cap must be greater than zero.' : '';
  const stored = selectionOf(agent);
  const dirty =
    trimmedName !== agent.name ||
    description.trim() !== agent.description ||
    selection.modelId.trim() !== stored.modelId ||
    selection.connectionId !== stored.connectionId ||
    selection.routingMode !== stored.routingMode ||
    budget !== agent.budgetCapUsd;

  async function save() {
    if (nameError || modelError || budgetError || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await onSaveAgent({
        name: trimmedName,
        modelId: selection.modelId.trim(),
        connectionId: selection.connectionId,
        routingMode: selection.connectionId ? selection.routingMode ?? 'pinned' : null,
        systemPrompt: description.trim(),
        budgetCapUsd: budget,
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not save bot settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="oh-settings-studio">
      <nav className="oh-bot-settings-nav" aria-label="Bot settings sections">{([{name:'Profile',icon:UserRound},{name:'Model & budget',icon:Cpu},{name:'Appearance',icon:Palette},{name:'Connections',icon:Plug}] as const).map(item=><button key={item.name} type="button" aria-current={section===item.name?'page':undefined} onClick={()=>setSection(item.name)}><item.icon size={16}/><span>{item.name}</span></button>)}</nav>
      <div className="oh-settings-content">
      {section === 'Profile' && <>
      <div className="oh-panel-intro"><span className="oh-studio-eyebrow">Identity</span><h3>Make this bot yours</h3><p>A name, a purpose and a character of their own.</p></div>
      <section className="oh-profile-hero"><div className="grok-settings-avatar-wrap">
        <button
          ref={avatarRef}
          type="button"
          className="grok-avatar-button"
          onClick={() => setAvatarOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={avatarOpen}
          aria-label="Change avatar"
          title="Change avatar"
        >
          <BotFace
            size={64}
            shape={agent.profile.shape}
            color={agent.profile.color}
            eyeColor={agent.profile.eyeColor}
            eyeScale={agent.profile.eyeScale}
            image={agent.profile.avatarImage}
            emotion={agent.profile.emotion}
            idle={agent.profile.idle}
            sketch={agent.profile.sketch}
            interactive
          />
        </button>
      </div>

      <div className="oh-profile-hero-copy"><strong>{name || 'Your bot'}</strong><span>Give your bot a familiar face.</span>{onOpenStudio && <Button kind="secondary" onClick={onOpenStudio}><Icon name="edit" size={15} />Open avatar studio</Button>}</div></section>

      {avatarOpen && (
        <AvatarPopover
          anchorRef={avatarRef}
          profile={agent.profile}
          onChange={onUpdateProfile}
          onClose={() => setAvatarOpen(false)}
        />
      )}

      <section className="oh-settings-card"><div className="oh-section-heading"><h3>About this bot</h3><p>Define its role and the instructions it follows.</p></div>
      {/* Explicit id/htmlFor rather than a wrapping <label>: a label that wraps
          its hint and its error folds both into the field's accessible name, so
          a screen reader announces the whole paragraph as the name of the
          field. Hints and errors are attached with aria-describedby instead. */}
      <div className="grok-form-group">
        <label className="grok-form-label" htmlFor="bot-name">Name</label>
        <Input
          id="bot-name"
          className="grok-form-input"
          value={name}
          maxLength={80}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? 'bot-name-error' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {nameError && (
          <span className="grok-field-error" id="bot-name-error">
            {nameError}
          </span>
        )}
      </div>

      <div className="grok-form-group">
        <label className="grok-form-label" htmlFor="bot-label">Label (optional)</label>
        <Input
          id="bot-label"
          className="grok-form-input"
          value={agent.profile.label}
          maxLength={60}
          placeholder="Research, marketing, admin"
          onChange={(event) => onUpdateProfile({ label: event.target.value })}
        />
      </div>

      <div className="grok-form-group">
        <label className="grok-form-label" htmlFor="bot-description">Description</label>
        <Textarea
          id="bot-description"
          className="grok-form-textarea"
          value={description}
          rows={5}
          placeholder="What this Bot is for"
          aria-describedby="bot-description-hint"
          onChange={(event) => setDescription(event.target.value)}
        />
        <span className="grok-field-hint" id="bot-description-hint">
          These instructions guide every conversation. Use Character below to shape how your bot speaks.
        </span>
      </div>

      </section><CharacterSection agentId={agent.id} agentName={agent.name} />
      </>}
      {section === 'Connections' && <><div className="oh-panel-intro"><span className="oh-studio-eyebrow">Capabilities</span><h3>Connected & ready</h3><p>Manage the websites, tools and knowledge this bot can use.</p></div>{connections}<details className="oh-tool-inventory oh-settings-card"><summary>Available tools</summary><BotToolsSection agentId={agent.id} agentName={agent.name} /></details><p className="grok-field-hint">Connection and tool controls save separately.</p></>}
      {section === 'Model & budget' && <>
          <div className="oh-panel-intro"><span className="oh-studio-eyebrow">Intelligence</span><h3>The mind behind the bot</h3><p>Choose a model and set its spending limit.</p></div><section className="oh-settings-card">

            <GrokModelSelector value={selection} onChange={setSelection} />

            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="bot-budget">Budget cap (USD)</label>
              <Input
                id="bot-budget"
                className="grok-form-input"
                type="number"
                min="0.01"
                step="0.01"
                value={budget}
                aria-invalid={Boolean(budgetError)}
                aria-describedby={budgetError ? 'bot-budget-error' : undefined}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
              {budgetError && <span className="grok-field-error" id="bot-budget-error">{budgetError}</span>}
            </div>

          </section></>}
      {section === 'Appearance' && <>
          <AvatarDesigner key={agent.id} name={name} profile={agent.profile} onChange={onUpdateProfile} onOpenStudio={onOpenStudio}/>
          <p className="avatar-small-note">Appearance saves as you edit. Expression auditions are preview only.</p>
          <details className="avatar-prompt-builder"><summary>Advanced expression configuration</summary>
            <div className="grok-config-tools">
              <strong>Emotion configuration</strong>
              <span className="grok-field-hint">Import or export the Aora emotion registry.</span>
              <Button kind="secondary" onClick={() => exportConfig(setConfigMessage)}>
                Export JSON
              </Button>
              <Textarea
                className="grok-form-textarea"
                rows={4}
                placeholder="Paste an Aora emotion definition or array"
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
              />
              <Button kind="secondary" disabled={!configText.trim()} onClick={() => {
                  const result = importEmotionConfig(configText);
                  setConfigMessage(
                    result.ok ? `${result.added} emotion definitions imported.` : result.errors.join(' ')
                  );
                }}
              >
                Import JSON
              </Button>
              {configMessage && (
                <p className="grok-config-message" role="status">
                  {configMessage}
                </p>
              )}
            </div>

            <p className="grok-license-note">
              All twelve silhouettes are OpenAgents-original geometry. The
              expression engine and emotion data are Aora's, free for
              non-commercial use and separately licensable.{' '}
              <a href="/vendor/aora/LICENSE" target="_blank" rel="noreferrer">
                Licence
              </a>
            </p>
          </details></>}
      </div>
      <footer className="oh-settings-savebar">{profileError && <FormError>{profileError}</FormError>}{saveError && <FormError>{saveError}</FormError>}<div><span className={dirty?'oh-unsaved':'oh-saved'}>{dirty ? 'Unsaved bot settings' : 'Bot settings saved'}</span><Button kind="primary" disabled={saving || !dirty || Boolean(nameError || modelError || budgetError)} onClick={() => void save()}><Check size={15}/>{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</Button></div></footer>
    </div>
  );
}

function exportConfig(setMessage: (message: string) => void) {
  const url = URL.createObjectURL(new Blob([exportEmotionConfig()], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'openagents-aora-emotions.json';
  anchor.click();
  URL.revokeObjectURL(url);
  setMessage('Emotion configuration exported.');
}

/**
 * The anchored avatar picker: Bot, Generate, Upload.
 *
 * GENERATE IS DISABLED. There is no image-generation endpoint in this daemon,
 * and a button that silently does nothing is worse than one that says why.
 */
function AvatarPopover({
  anchorRef,
  profile,
  onChange,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  profile: BotProfile;
  onChange: (patch: Partial<BotProfile>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'bot' | 'generate' | 'upload'>('bot');
  const [prompt, setPrompt] = useState('');
  const [lastGenerated, setLastGenerated] = useState<string[] | null>(null);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function readFile(file: File | null | undefined) {
    setUploadError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('That file is not an image.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setUploadError(`Images must be under ${Math.round(MAX_AVATAR_BYTES / 1024)}KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setUploadError('The image could not be read.');
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:image/')) {
        setUploadError('The image could not be read.');
        return;
      }
      onChange({ avatarImage: result });
    };
    reader.readAsDataURL(file);
  }

  return (
    <Popover
      anchorRef={anchorRef}
      placement="bottom-end"
      label="Avatar"
      role="dialog"
      width={288}
      className="grok-avatar-popover"
      onClose={onClose}
      autoFocus={false}
    >
      <div className="grok-avatar-tabs" role="tablist" aria-label="Avatar source">
        {(['bot', 'generate', 'upload'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {id === 'bot' ? 'Bot' : id === 'generate' ? 'Generate' : 'Upload'}
          </button>
        ))}
        <button
          type="button"
          className="grok-avatar-reset"
          onClick={() => onChange({ avatarImage: null, sketch: false, eyeScale: 1 })}
        >
          Reset
        </button>
      </div>

      {tab === 'bot' && (
        <div className="grok-avatar-bot-tab">
          <div className="grok-shape-grid" role="group" aria-label="Body shape">
            {BOT_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                className={`grok-shape-swatch ${profile.shape === shape ? 'selected' : ''}`}
                aria-pressed={profile.shape === shape}
                aria-label={SHAPE_LABELS[shape]}
                title={SHAPE_LABELS[shape]}
                onClick={() => onChange({ shape, avatarImage: null })}
              >
                <BotFace size={34} shape={shape} color={profile.color} eyeColor="#1A1A1A" idle={false} />
              </button>
            ))}
          </div>
          <div className="grok-color-grid" role="group" aria-label="Body colour">
            {BOT_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                className={`grok-color-swatch ${profile.color === color.value ? 'selected' : ''}`}
                style={{ background: color.value }}
                aria-pressed={profile.color === color.value}
                aria-label={color.label}
                title={color.label}
                onClick={() => onChange({ color: color.value, avatarImage: null })}
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'generate' && (
        <div className="grok-avatar-generate">
          <Textarea
            rows={4}
            value={prompt}
            placeholder="Describe your avatar..."
            aria-label="Describe your avatar"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <Button kind="primary" disabled={!prompt.trim()} onClick={() => {
              const generated = generateAvatarFromPrompt(prompt);
              if (!generated) return;
              setLastGenerated(generated.matched);
              onChange(toProfilePatch(generated));
            }}
          >
            Generate
          </Button>
          {lastGenerated !== null && (
            <p className="grok-field-hint" role="status">
              {lastGenerated.length > 0
                ? `Matched ${lastGenerated.map((word) => `“${word}”`).join(', ')}. Generate again after editing the description.`
                : 'No shape or colour words matched, so the result came from the description as a whole. Try naming a shape or a colour.'}
            </p>
          )}
          <p className="grok-field-hint">
            Generated on this machine by matching your description against the
            shape and colour vocabulary — not by an image model, because
            OpenAgents has none. The same description always gives the same bot.
          </p>
        </div>
      )}

      {tab === 'upload' && (
        <div className="grok-avatar-upload">
          <div
            className="grok-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              readFile(event.dataTransfer.files?.[0]);
            }}
            onPaste={(event) => readFile(event.clipboardData.files?.[0])}
          >
            <p>Drag, drop, or paste an image</p>
            <p className="grok-dropzone-or">or</p>
            <Button kind="secondary" onClick={() => fileRef.current?.click()}>
              Browse files
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => readFile(event.target.files?.[0])}
            />
          </div>
          {uploadError && (
            <FormError>
              {uploadError}
            </FormError>
          )}
          {profile.avatarImage && (
            <Button kind="secondary" onClick={() => onChange({ avatarImage: null })}>
              Remove uploaded image
            </Button>
          )}
          <p className="grok-field-hint">
            Stored with the bot on the daemon, under {Math.round(MAX_AVATAR_BYTES / 1024)}KB.
          </p>
        </div>
      )}
    </Popover>
  );
}
