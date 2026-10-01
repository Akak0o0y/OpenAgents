/**
 * Creating a bot.
 *
 * Two panes: the avatar gallery on the left, the bot's identity on the right.
 * The gallery is the reason this screen is not just a form - choosing a
 * character is a browsing task, and the expression you pick is the one the bot
 * wears in the sidebar afterwards.
 *
 * The id is derived from the name and shown, because it is permanent: the
 * daemon uses it in URLs, event payloads and MCP allowlists, and nothing in
 * this UI can rename it later.
 */

import { useMemo, useState } from 'react';
import { BotFace } from './BotFace.js';
import { GrokAvatarGallery, type GalleryValue } from './GrokAvatarGallery.js';
import { type AoraShape } from '../lib/aora-bot/shapes.js';
import { FormError } from './ui/FormError.js';
import { Button } from './ui/Button.js';
import { Input } from '@/registry/default/ui/input.js';
import { Textarea } from '@/registry/default/ui/textarea.js';
import { GrokModelSelector, modelSelectionError, type ModelSelection } from './GrokModelSelector.js';
import { Icon } from './ui/icons.js';

export interface NewBotInput {
  id: string;
  name: string;
  modelId: string;
  connectionId?: string | null;
  routingMode?: 'pinned' | 'auto' | null;
  description: string;
  budgetCapUsd: number;
  shape: AoraShape;
  color: string;
  eyeColor: string;
  emotion: string;
  sketch: boolean;
  characterSetup?:'off'|'voice'|'character';
}

interface GrokNewBotScreenProps {
  onGetStarted: (bot: NewBotInput) => Promise<void>;
  onBackToExisting: () => void;
  hasExistingAgents: boolean;
  /** Inherit the full route; a model ID alone must not silently change providers. */
  defaultSelection?: ModelSelection;
  /** Configuration only; never includes conversations, browser state or secrets. */
  initialBot?: Omit<NewBotInput, 'id'>;
  /** Ids already taken, so a clash is caught before the daemon refuses it. */
  existingIds?: string[];
}

/**
 * The daemon requires 2-64 lowercase letters, digits or hyphens. This mirrors
 * that rule rather than guessing, so a name that cannot become an id is
 * reported here instead of as a 400 from the server.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function GrokNewBotScreen({
  onGetStarted,
  onBackToExisting,
  hasExistingAgents,
  defaultSelection = { modelId: 'openrouter/auto', connectionId: null, routingMode: null },
  initialBot,
  existingIds = [],
}: GrokNewBotScreenProps) {
  const [name, setName] = useState(initialBot?.name ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState(initialBot?.description ?? '');
  const [selection, setSelection] = useState<ModelSelection>(initialBot ? { modelId: initialBot.modelId, connectionId: initialBot.connectionId ?? null, routingMode: initialBot.routingMode ?? null } : defaultSelection);
  const [budgetCapUsd, setBudgetCapUsd] = useState(initialBot?.budgetCapUsd ?? 10);
  const [saving, setSaving] = useState(false);
  const [characterSetup,setCharacterSetup]=useState<'off'|'voice'|'character'>('off');
  const [error, setError] = useState('');
  const [appearance, setAppearance] = useState<GalleryValue>({
    shape: initialBot?.shape ?? 'pebble',
    color: initialBot?.color ?? '#2C86F0',
    eyeColor: initialBot?.eyeColor ?? '#FFFFFF',
    emotion: initialBot?.emotion ?? '02',
    sketch: initialBot?.sketch ?? false,
  });

  const id = useMemo(() => slugify(name), [name]);

  const nameError = !name.trim()
    ? 'Give the bot a name.'
    : id.length < 2
      ? 'That name has no letters or digits to build an id from.'
      : existingIds.includes(id)
        ? `A bot with the id "${id}" already exists.`
        : '';
  const modelError = modelSelectionError(selection);
  const budgetError = !(budgetCapUsd > 0) ? 'The budget cap must be greater than zero.' : '';
  const canCreate = !nameError && !modelError && !budgetError && !saving;

  async function submit() {
    if (!canCreate) return;
    setSaving(true);
    setError('');
    try {
      await onGetStarted({
        id,
        name: name.trim(),
        modelId: selection.modelId.trim(),
        connectionId: selection.connectionId,
        routingMode: selection.routingMode,
        description: description.trim(),
        budgetCapUsd,
        shape: appearance.shape,
        color: appearance.color,
        eyeColor: appearance.eyeColor,
        emotion: appearance.emotion,
        sketch: appearance.sketch,
        ...(characterSetup!=='off'?{characterSetup}:{}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the bot.');
      setSaving(false);
    }
  }

  return (
    <div className="grok-onboarding">
      <main className="grok-onboarding-main">
        <header className="oh-creation-header"><button type="button" className="oh-back-link" onClick={onBackToExisting}><Icon name="back" size={16} />Workspace</button><span className="oh-eyebrow">OPENAGENTS / CREATE A BOT</span></header>
        <div className="oh-creation-intro"><span className="oh-eyebrow">A NEW COLLABORATOR</span><h1>Make it yours.</h1><p>Give it a character, a purpose, and the intelligence to get things done.</p><div className="oh-creation-steps"><span><b>01</b> Character</span><i /><span><b>02</b> Identity</span><i /><span><b>03</b> Intelligence</span></div></div>
        <div className="grok-onboarding-layout">
          <GrokAvatarGallery
            heading="Design your character"
            value={appearance}
            onChange={(patch) => setAppearance((current) => ({ ...current, ...patch }))}
          />

          <aside className="grok-onboarding-form" aria-label="Bot details">
            <div className="grok-onboarding-preview">
              <BotFace
                size={72}
                shape={appearance.shape}
                color={appearance.color}
                eyeColor={appearance.eyeColor}
                emotion={appearance.emotion}
                sketch={appearance.sketch}
                idle
              />
              <div>
                <strong>{name.trim() || 'Unnamed bot'}</strong>
                <span className="grok-field-hint">{id ? `id: ${id}` : 'id: from the name'}</span>
              </div>
            </div>

            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="new-bot-name">
                Name
              </label>
              <Input
                id="new-bot-name"
                className="grok-form-input"
                value={name}
                maxLength={80}
                placeholder="Atlas"
                autoFocus
                aria-invalid={nameTouched && Boolean(nameError)}
                aria-describedby={nameTouched && nameError ? 'new-bot-name-error' : 'new-bot-name-hint'}
                onBlur={() => setNameTouched(true)}
                onChange={(event) => setName(event.target.value)}
              />
              {nameTouched && nameError ? (
                <span className="grok-field-error" id="new-bot-name-error">
                  {nameError}
                </span>
              ) : (
                <span className="grok-field-hint" id="new-bot-name-hint">
                  The id is derived from the name and cannot be changed later.
                </span>
              )}
            </div>

            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="new-bot-description">
                Description
              </label>
              <Textarea
                id="new-bot-description"
                className="grok-form-textarea"
                rows={4}
                value={description}
                placeholder="What this bot is for"
                aria-describedby="new-bot-description-hint"
                onChange={(event) => setDescription(event.target.value)}
              />
              <span className="grok-field-hint" id="new-bot-description-hint">
                Becomes the bot's system prompt, sent with every message.
              </span>
            </div>

            <GrokModelSelector compact value={selection} onChange={setSelection} />
            <label className="grok-form-group">Character setup<select value={characterSetup} onChange={e=>setCharacterSetup(e.target.value as typeof characterSetup)}><option value="off">Off — use the Description</option><option value="voice">Voice — writing style only</option><option value="character">Character — identity and continuity</option></select><span className="grok-field-hint">Voice and Character prepare an unsent setup request in chat. Review and approve the resulting draft before it becomes active.</span></label>
            <div className="grok-onboarding-grid">

              <div className="grok-form-group">
                <label className="grok-form-label" htmlFor="new-bot-budget">
                  Budget cap (USD)
                </label>
                <Input
                  id="new-bot-budget"
                  className="grok-form-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={budgetCapUsd}
                  aria-invalid={Boolean(budgetError)}
                  onChange={(event) => setBudgetCapUsd(Number(event.target.value))}
                />
                {budgetError && <span className="grok-field-error">{budgetError}</span>}
              </div>
            </div>

            {error && (
              <FormError>
                {error}
              </FormError>
            )}

            <div className="grok-onboarding-actions">
              {hasExistingAgents && (
                <Button kind="secondary" onClick={onBackToExisting}>
                  Cancel
                </Button>
              )}
              <Button kind="primary" disabled={!canCreate} onClick={() => void submit()}
              >
                {saving ? 'Creating…' : 'Create bot'}
              </Button>
            </div>

            <p className="grok-field-hint">Your bot and its avatar are saved together in your workspace.</p>
          </aside>
        </div>
      </main>
    </div>
  );
}
