/**
 * Settings, Providers.
 *
 * A provider connection is an OpenAI-compatible inference endpoint, such as a local FreeLLMAPI gateway. OpenAgents can
 * run a FreeLLMAPI checkout itself (LocalGatewayPanel); it never installs one. Keys are write-only: they go to the daemon, which
 * protects them for this OS user, and no response returns them. Nothing here is kept in browser storage, and saving
 * never runs a model or switches a bot.
 *
 * Each connection is one card: who it is and its status, the daemon's own message, what it can serve and how much
 * of its admission limit OpenAgents has used, then its actions - with the one destructive action set apart.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { formatCount } from '../lib/numbers.js';
import { api, type ProviderConnectionRow, type ProvidersBody, type GatewayStatus, type GatewayRoutingWeights } from '../lib/transport.js';
import { Input } from '@/registry/default/ui/input.js';
import { FormError } from './ui/FormError.js';
import { Icon } from './ui/icons.js';
import { formatCompact } from '../lib/numbers.js';
import { Meter, SettingsNote, SettingsSwitch } from './SettingsKit.js';
import { LocalGatewayPanel } from './LocalGatewayPanel.js';

export const PROVIDER_STATUS_LABELS: Record<ProviderConnectionRow['status'], string> = {
  untested: 'Not tested',
  incomplete: 'Setup incomplete',
  disabled: 'Disabled',
  connected: 'Connected',
  unreachable: 'Unreachable',
  invalid_credentials: 'Invalid key',
  invalid_catalog: 'Invalid model list',
  no_usable_models: 'No usable models',
  exhausted: 'Quota exhausted',
};

interface Draft {
  id?: string;
  name: string;
  preset: 'freellmapi' | 'custom';
  baseUrl: string;
  enabled: boolean;
  apiKey: string;
  requestsPerDay: number;
  tokensPerDay: number;
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

function draftError(draft: Draft): string {
  if (!draft.name.trim()) return 'A connection needs a name.';
  if (!/^https?:\/\/\S+$/i.test(draft.baseUrl.trim())) return 'The endpoint must be an http or https URL.';
  if (!(draft.requestsPerDay >= 1) || !(draft.tokensPerDay >= 1000)) return 'Admission limits must be at least 1 request and 1,000 tokens.';
  return '';
}

const STRATEGIES = [
  { id: 'balanced', label: 'Balanced', hint: '50% reliability, 25% speed, 25% intelligence' },
  { id: 'smartest', label: 'Smartest', hint: 'Highest intelligence and reasoning' },
  { id: 'fastest', label: 'Fastest', hint: 'Lowest response latency' },
  { id: 'reliable', label: 'Most reliable', hint: 'Highest uptime, fewest errors' },
  { id: 'custom', label: 'Custom', hint: 'Set your own weights' },
] as const;

const WEIGHT_KEYS = ['reliability', 'speed', 'intelligence'] as const;

function GatewayRoutingPanel({
  connection,
  run,
  busy,
}: {
  connection: ProviderConnectionRow;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  busy: string | null;
}) {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [strategy, setStrategy] = useState<string>('balanced');
  const [weights, setWeights] = useState<GatewayRoutingWeights>({ reliability: 0.5, speed: 0.25, intelligence: 0.25 });
  const [exploreEnabled, setExploreEnabled] = useState(false);
  const [peakHoursAdjust, setPeakHoursAdjust] = useState(false);
  const [cooldownCeilingMs, setCooldownCeilingMs] = useState<number | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const data = await api.getGatewayStatus(connection.id);
      setGateway(data);
      if (data.routing) {
        setStrategy(data.routing.strategy || 'balanced');
        if (data.routing.weights) setWeights(data.routing.weights);
        setExploreEnabled(Boolean(data.routing.exploreEnabled));
        setPeakHoursAdjust(Boolean(data.routing.peakHoursAdjust));
        setCooldownCeilingMs(data.routing.cooldownCeilingMs ?? null);
      }
    } catch {
      // Gateway may be temporarily unreachable
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connection.status === 'connected' || connection.status === 'untested') {
      void fetchStatus();
    }
  }, [connection.id, connection.status]);

  if (!gateway || !gateway.routing) return null;

  const handleStrategyChange = (next: string) => {
    setStrategy(next);
    if (gateway.routing?.presets && gateway.routing.presets[next]) {
      setWeights(gateway.routing.presets[next]);
    }
  };

  const applyRouting = async () => {
    await run(`routing:${connection.id}`, async () => {
      const updated = await api.updateGatewayRouting(connection.id, {
        strategy,
        weights: strategy === 'custom' ? weights : undefined,
        exploreEnabled,
        peakHoursAdjust,
        cooldownCeilingMs,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      const routingObj = updated && 'routing' in updated ? (updated as any).routing : updated;
      if (routingObj?.strategy) {
        setGateway((prev) => (prev ? { ...prev, routing: routingObj } : prev));
      }
    });
  };

  const healthy = gateway.upstream?.counts?.healthy ?? 0;
  const upstream =
    gateway.upstream?.providers?.map((p) => `${p.name} (${p.status}, ${p.keys} key${p.keys === 1 ? '' : 's'})`).join(', ') ||
    'None detected';

  return (
    <div className="oh-prov-routing">
      <div className="oh-prov-routing-head">
        <strong>Gateway routing</strong>
        <span className="oh-prov-chip" title={upstream}>
          <Icon name={healthy > 0 ? 'ok' : 'warn'} size={12} motion={false} />
          {healthy} healthy upstream
        </span>
      </div>

      <div className="oh-route-options" role="radiogroup" aria-label="Routing profile">
        {STRATEGIES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={strategy === option.id}
            className="oh-route-option"
            disabled={Boolean(busy)}
            onClick={() => handleStrategyChange(option.id)}
          >
            <strong>{option.label}</strong>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>

      {strategy === 'custom' && (
        <div className="oh-route-weights">
          {WEIGHT_KEYS.map((key) => (
            <label key={key}>
              {key.charAt(0).toUpperCase() + key.slice(1)} · {Math.round(weights[key] * 100)}%
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={weights[key]}
                onChange={(event) => setWeights({ ...weights, [key]: parseFloat(event.target.value) })}
              />
            </label>
          ))}
        </div>
      )}

      <div className="oh-route-toggles">
        <span className="oh-route-toggle">
          <SettingsSwitch checked={exploreEnabled} label="Explore unmeasured models" disabled={Boolean(busy)} onChange={setExploreEnabled} />
          Explore unmeasured models
        </span>
        <span className="oh-route-toggle">
          <SettingsSwitch checked={peakHoursAdjust} label="Peak-hours weight adjustment" disabled={Boolean(busy)} onChange={setPeakHoursAdjust} />
          Peak-hours weight adjustment
        </span>
      </div>

      <div className="oh-route-apply">
        <button type="button" className="oh-set-btn primary" disabled={Boolean(busy) || loading} onClick={() => void applyRouting()}>
          {busy === `routing:${connection.id}` ? 'Saving strategy…' : 'Apply routing strategy'}
        </button>
        {saveSuccess && (
          <span className="oh-route-saved" role="status">
            <Icon name="done" size={13} motion={false} />
            Strategy updated
          </span>
        )}
      </div>
    </div>
  );
}

export function ProvidersSection() {
  const [body, setBody] = useState<ProvidersBody | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [autoFetching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((next) => {
        if (!cancelled) setBody(next);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(message(cause, 'Provider settings are unavailable.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The gateway OpenAgents runs may have come up on a different port; its
  // connection's address follows it in the daemon, so the list is read again.
  const reload = () => {
    void api.providers().then(setBody).catch(() => undefined);
  };

  function replace(connection: ProviderConnectionRow) {
    setBody((current) =>
      current && {
        ...current,
        connections: current.connections.some((entry) => entry.id === connection.id)
          ? current.connections.map((entry) => (entry.id === connection.id ? connection : entry))
          : [...current.connections, connection],
      }
    );
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setActionError('');
    try {
      await action();
    } catch (cause) {
      setActionError(message(cause, 'The action failed.'));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <FormError>{loadError}</FormError>;
  if (!body) return <SettingsNote icon="busy">Reading provider connections…</SettingsNote>;

  const startDraftOpenRouter = () =>
    setDraft({
      preset: 'custom',
      name: body.openrouterPreset?.name ?? 'OpenRouter (Paid)',
      baseUrl: body.openrouterPreset?.baseUrl ?? 'https://openrouter.ai/api/v1',
      enabled: true,
      apiKey: '',
      requestsPerDay: 500,
      tokensPerDay: 5_000_000,
    });

  const startDraft = (preset: 'freellmapi' | 'custom') =>
    setDraft({
      preset,
      name: preset === 'freellmapi' ? body.preset.name : '',
      baseUrl: preset === 'freellmapi' ? body.preset.baseUrl : '',
      enabled: true,
      apiKey: '',
      requestsPerDay: 500,
      tokensPerDay: 5_000_000,
    });
  const existing = draft?.id ? body.connections.find((entry) => entry.id === draft.id) : undefined;
  const validation = draft ? draftError(draft) : '';

  async function save() {
    if (!draft || validation) return;
    const current = draft;
    await run('save', async () => {
      const { connection } = await api.saveProvider({
        ...(current.id ? { id: current.id } : {}),
        name: current.name.trim(),
        preset: current.preset,
        baseUrl: current.baseUrl.trim(),
        enabled: current.enabled,
        ...(current.apiKey ? { apiKey: current.apiKey } : {}),
        limits: { requestsPerDay: current.requestsPerDay, tokensPerDay: current.tokensPerDay },
      });
      replace(connection);
      // Dropping the draft also drops the typed key from memory.
      setDraft(null);
    });
  }

  return (
    <>
      {!body.secretStorage.available && (
        <FormError>{body.secretStorage.reason ?? 'Protected key storage is unavailable, so gateway keys cannot be saved.'}</FormError>
      )}
      {actionError && <FormError>{actionError}</FormError>}

      <LocalGatewayPanel onRunning={reload} />

      <section className="oh-set-group" aria-label="Connections">
        <header className="oh-set-group-head">
          <div>
            <h3>Connections</h3>
            <p>Saving never runs a model or switches a bot. Choose a connection for each bot in its settings.</p>
          </div>
        </header>

        {body.connections.length === 0 && !draft && <SettingsNote icon="link">No provider connections yet.</SettingsNote>}

        <div className="oh-prov-list">
          {body.connections.map((connection, index) => {
            const concrete = connection.catalog.models.filter((model) => !model.virtual);
            const ready = concrete.filter((model) => model.usable === true).length;
            const aliases = connection.catalog.models.length - concrete.length;
            const used = connection.admissionUsed;
            return (
              <section
                key={connection.id}
                className="oh-prov-card"
                aria-label={`Provider connection ${connection.name}`}
                style={{ animationDelay: `${index * 60}ms` } as CSSProperties}
              >
                <header className="oh-prov-head">
                  <span className="oh-prov-mark" aria-hidden="true">
                    {connection.name.trim().slice(0, 1).toUpperCase() || '?'}
                  </span>
                  <div className="oh-prov-title">
                    <strong>{connection.name}</strong>
                    <code>{connection.baseUrl}</code>
                  </div>
                  <span className="grok-provider-status" data-status={connection.status}>
                    {PROVIDER_STATUS_LABELS[connection.status]}
                  </span>
                </header>

                <p className="oh-prov-message" role="status">
                  {connection.statusMessage}
                </p>
                {autoFetching === connection.id && (
                  <p className="oh-prov-hint" role="status">
                    Fetching model catalog…
                  </p>
                )}

                <div className="oh-prov-stats">
                  <div className="oh-prov-stat">
                    {/* A gateway that reports no readiness at all (OpenRouter) is not "0 ready":
                        it lists models and leaves serving to the request. */}
                    {concrete.length > 0 && concrete.every((model) => model.usable === null) ? (
                      <>
                        <span>Models listed</span>
                        <strong>{formatCount(concrete.length)}</strong>
                        <small>Readiness is checked when a request is sent</small>
                      </>
                    ) : (
                      <>
                        <span>Models ready</span>
                        <strong>{concrete.length > 0 ? `${ready} / ${concrete.length}` : '—'}</strong>
                        <small>
                          {aliases} routing alias{aliases === 1 ? '' : 'es'}
                        </small>
                      </>
                    )}
                  </div>
                  <div className="oh-prov-stat">
                    <span>Requests · 24h</span>
                    <strong>
                      {formatCount(used.requestsLast24h)} <small>/ {formatCount(connection.limits.requestsPerDay)}</small>
                    </strong>
                    <Meter value={used.requestsLast24h} max={connection.limits.requestsPerDay} label={`${connection.name} requests in 24 hours`} />
                  </div>
                  <div className="oh-prov-stat">
                    <span>Tokens · 24h</span>
                    <strong>
                      {formatCompact(Math.round(used.tokensLast24h))} <small>/ {formatCompact(connection.limits.tokensPerDay)}</small>
                    </strong>
                    <Meter value={used.tokensLast24h} max={connection.limits.tokensPerDay} label={`${connection.name} tokens in 24 hours`} />
                  </div>
                </div>

                <div className="oh-prov-meta">
                  <span className="oh-prov-chip">
                    <Icon name={connection.hasKey ? 'ok' : 'warn'} size={12} motion={false} />
                    <span className="oh-prov-chip-label">Key</span>
                    <span>{connection.hasKey ? 'Stored and hidden' : 'Not set'}</span>
                  </span>
                  <span className="oh-prov-chip">
                    <Icon name="bot" size={12} motion={false} />
                    {connection.usedBy.length > 0 ? `Used by ${connection.usedBy.join(', ')}` : 'Not used by any bot'}
                  </span>
                </div>
                <p className="oh-prov-hint">
                  Limits bound what OpenAgents sends through this connection. Its price is unknown to OpenAgents, and the
                  gateway's own quota view needs its dashboard login.
                </p>

                {connection.preset === 'freellmapi' && <GatewayRoutingPanel connection={connection} run={run} busy={busy} />}

                <div className="oh-prov-actions">
                  <button
                    type="button"
                    className="oh-set-btn"
                    disabled={Boolean(busy) || autoFetching === connection.id}
                    onClick={() => void run(`test:${connection.id}`, async () => replace((await api.testProvider(connection.id)).connection))}
                  >
                    <Icon name="power" size={14} />
                    {busy === `test:${connection.id}` || autoFetching === connection.id ? 'Testing…' : 'Test connection'}
                  </button>
                  <button
                    type="button"
                    className="oh-set-btn"
                    disabled={Boolean(busy) || autoFetching === connection.id}
                    onClick={() => void run(`refresh:${connection.id}`, async () => replace((await api.refreshProviderModels(connection.id)).connection))}
                  >
                    <Icon name="refresh" size={14} />
                    {busy === `refresh:${connection.id}` ? 'Refreshing…' : 'Refresh models'}
                  </button>
                  <button
                    type="button"
                    className="oh-set-btn"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      setDraft({
                        id: connection.id,
                        name: connection.name,
                        preset: connection.preset,
                        baseUrl: connection.baseUrl,
                        enabled: connection.enabled,
                        apiKey: '',
                        requestsPerDay: connection.limits.requestsPerDay,
                        tokensPerDay: connection.limits.tokensPerDay,
                      })
                    }
                  >
                    <Icon name="edit" size={14} />
                    Edit
                  </button>
                  {connection.hasKey && (
                    <button
                      type="button"
                      className="oh-set-btn ghost"
                      disabled={Boolean(busy)}
                      onClick={() => void run(`key:${connection.id}`, async () => replace((await api.removeProviderKey(connection.id)).connection))}
                    >
                      Remove key
                    </button>
                  )}
                  {/* Icon-only, named by its label and tooltip: with the full
                      text the row overflowed and pushed Remove onto a line of
                      its own. */}
                  <a
                    className="oh-set-btn ghost oh-set-icon-btn"
                    href={connection.dashboardUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="Open gateway dashboard"
                    title="Open gateway dashboard"
                  >
                    <Icon name="open" size={14} />
                  </a>
                  <span className="oh-spacer" />
                  <button
                    type="button"
                    className="oh-set-btn danger"
                    disabled={Boolean(busy) || connection.usedBy.length > 0}
                    title={connection.usedBy.length > 0 ? 'Choose another model for the bots using it first.' : undefined}
                    onClick={() =>
                      void run(`remove:${connection.id}`, async () => {
                        await api.removeProvider(connection.id);
                        setBody((current) => current && { ...current, connections: current.connections.filter((entry) => entry.id !== connection.id) });
                      })
                    }
                  >
                    <Icon name="remove" size={14} />
                    Remove
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </section>

      {draft ? (
        <div className="oh-prov-card">
          <form
            className="oh-prov-form"
            aria-label={draft.id ? 'Edit provider connection' : 'New provider connection'}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="oh-prov-form-title">
              <span className="oh-prov-mark" aria-hidden="true">
                {draft.name.trim().slice(0, 1).toUpperCase() || '+'}
              </span>
              {draft.id ? `Edit ${existing?.name ?? 'connection'}` : 'New connection'}
            </div>
            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="provider-name">Connection name</label>
              <Input id="provider-name" className="grok-form-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="provider-url">Endpoint base URL</label>
              <Input id="provider-url" className="grok-form-input" value={draft.baseUrl} spellCheck={false} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
            </div>
            <div className="grok-form-group is-wide">
              <label className="grok-form-label" htmlFor="provider-key">{existing?.hasKey ? 'Replace gateway key' : 'Gateway key'}</label>
              <Input
                id="provider-key"
                className="grok-form-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  existing?.hasKey
                    ? 'Leave empty to keep the stored key'
                    : draft.baseUrl.includes('openrouter.ai')
                      ? 'sk-or-v1-... (Paid OpenRouter API key)'
                      : draft.preset === 'freellmapi'
                        ? 'freellmapi-... (Unified gateway key)'
                        : undefined
                }
                value={draft.apiKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
              <span className="grok-field-hint">Sent once to the daemon, which protects it for this OS user. It is never shown again.</span>
            </div>
            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="provider-requests">Requests per 24 hours</label>
              <Input id="provider-requests" className="grok-form-input" type="number" min="1" value={draft.requestsPerDay}
                onChange={(event) => setDraft({ ...draft, requestsPerDay: Number(event.target.value) })} />
            </div>
            <div className="grok-form-group">
              <label className="grok-form-label" htmlFor="provider-tokens">Tokens per 24 hours</label>
              <Input id="provider-tokens" className="grok-form-input" type="number" min="1000" value={draft.tokensPerDay}
                onChange={(event) => setDraft({ ...draft, tokensPerDay: Number(event.target.value) })} />
            </div>
            <label className="oh-prov-enabled" htmlFor="provider-enabled">
              <span>
                Enabled
                <small>OpenAgents cannot know this pool's price, so the limits above bound what bots may send through it.</small>
              </span>
              <input id="provider-enabled" type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            </label>
            {validation && <span className="grok-field-error">{validation}</span>}
            <div className="oh-prov-form-actions">
              <button type="button" className="oh-set-btn ghost" disabled={busy === 'save'} onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="submit" className="oh-set-btn primary" disabled={Boolean(busy) || Boolean(validation)}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <section className="oh-set-group" aria-label="Add a connection">
          <header className="oh-set-group-head">
            <div>
              <h3>Add a connection</h3>
              <p>OpenAgents does not install or start a gateway; it connects to one you already run.</p>
            </div>
          </header>
          <div className="oh-prov-presets">
            <button type="button" className="oh-prov-preset is-primary" aria-label="Add FreeLLMAPI" onClick={() => startDraft('freellmapi')}>
              <span className="oh-prov-mark" aria-hidden="true">F</span>
              <strong>FreeLLMAPI</strong>
              <small>A local gateway that pools free model providers behind one key.</small>
              <span className="oh-prov-preset-add" aria-hidden="true">
                <Icon name="add" size={13} motion={false} /> Add
              </span>
            </button>
            <button type="button" className="oh-prov-preset" aria-label="Add OpenRouter (Paid)" onClick={() => startDraftOpenRouter()}>
              <span className="oh-prov-mark" aria-hidden="true">O</span>
              <strong>OpenRouter</strong>
              <small>Hosted, paid access to hundreds of models with your own API key.</small>
              <span className="oh-prov-preset-add" aria-hidden="true">
                <Icon name="add" size={13} motion={false} /> Add
              </span>
            </button>
            <button type="button" className="oh-prov-preset" aria-label="Add other gateway" onClick={() => startDraft('custom')}>
              <span className="oh-prov-mark" aria-hidden="true">
                <Icon name="link" size={16} motion={false} />
              </span>
              <strong>Other gateway</strong>
              <small>Any OpenAI-compatible endpoint you run or subscribe to.</small>
              <span className="oh-prov-preset-add" aria-hidden="true">
                <Icon name="add" size={13} motion={false} /> Add
              </span>
            </button>
          </div>
        </section>
      )}

      <SettingsNote icon="warn">
        FreeLLMAPI's development UI also defaults to port 5173. If you run both development UIs, start FreeLLMAPI's on
        another port; its API can stay on 3001, and OpenAgents keeps 4001 and 5173.
      </SettingsNote>
    </>
  );
}
