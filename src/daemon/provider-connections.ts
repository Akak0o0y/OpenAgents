import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { AgentRecord } from './db/schema.js';
import type { SecretStore } from './secret-store.js';
import { connectionAdmissionUsage, type ConnectionAdmission } from '../kernel/cost-ledger.js';
import type { RoutingMode } from '../evals/llm-client.js';

/**
 * User-configured OpenAI-compatible inference connections, such as a local FreeLLMAPI gateway.
 * This is an inference connection only; internet research and browser control are separate tools.
 */
export const FREELLMAPI_PRESET = { preset: 'freellmapi' as const, name: 'FreeLLMAPI', baseUrl: 'http://127.0.0.1:3001/v1' };
export const OPENROUTER_PRESET = { preset: 'custom' as const, name: 'OpenRouter (Paid)', baseUrl: 'https://openrouter.ai/api/v1' };
/** Explicit admission for pools whose price OpenAgents cannot know. Operators can change both per connection. */
export const DEFAULT_ADMISSION = { requestsPerDay: 500, tokensPerDay: 5_000_000 };
const CATALOG_MAX_AGE_MS = 5 * 60_000, CATALOG_MAX_MODELS = 2000, TEST_TIMEOUT_MS = 10_000;

export type ConnectionStatus = 'untested' | 'incomplete' | 'disabled' | 'connected' | 'unreachable' | 'invalid_credentials' | 'invalid_catalog' | 'no_usable_models' | 'exhausted';

export interface CatalogModel {
  id: string;
  /** true when the gateway reports it can serve now, false when it reports otherwise, null when it does not say. */
  usable: boolean | null;
  executionStatus: string | null;
  /** Router aliases such as auto or auto:<profile>. Their presence proves nothing about a usable upstream key. */
  virtual: boolean;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  contextWindow: number | null;
}

export interface ProviderConnection {
  id: string;
  name: string;
  preset: 'freellmapi' | 'custom';
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  status: ConnectionStatus;
  statusMessage: string;
  checkedAt: number | null;
  catalog: { fetchedAt: number | null; models: CatalogModel[] };
  limits: { requestsPerDay: number; tokensPerDay: number };
  admissionUsed: { requestsLast24h: number; tokensLast24h: number };
  dashboardUrl: string;
  /** FreeLLMAPI routes concrete model IDs by preference, so it is never presented as exact-model pinned. */
  pinning: 'identity-checked-per-turn';
  usedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedConnection { id: string; baseUrl: string; apiKey: string; label: string }

export class ProviderSetupError extends Error {
  override readonly name = 'ProviderSetupError';
  constructor(message: string, readonly status = 400) { super(message); }
}

export function isVirtualModel(modelId: string): boolean {
  return modelId === 'auto' || modelId.startsWith('auto:');
}

/** Cooldowns are per connection and wire model, so identical IDs on two gateways never share state. */
export function providerKey(agent: Pick<AgentRecord, 'model_id' | 'connection_id'>): string {
  return agent.connection_id ? `connection:${agent.connection_id}/${agent.model_id}` : agent.model_id;
}

export interface ModelRoute {
  key: string;
  connection?: { id: string; routingMode: RoutingMode };
  admission?: ConnectionAdmission;
}

/** Bots without a connection keep today's provider inference unchanged. */
export function modelRoute(store: AgentStore, agent: Pick<AgentRecord, 'model_id' | 'connection_id' | 'routing_mode'>): ModelRoute {
  if (!agent.connection_id) return { key: agent.model_id };
  const row = store.getDatabase().prepare('SELECT requests_per_day, tokens_per_day FROM provider_connections WHERE id = ?').get(agent.connection_id) as { requests_per_day: number; tokens_per_day: number } | undefined;
  if (!row) throw new ProviderSetupError(`This bot uses provider connection "${agent.connection_id}", which no longer exists. Choose another model in bot settings.`);
  const routingMode: RoutingMode = agent.routing_mode === 'auto' ? 'auto' : 'pinned';
  return { key: providerKey(agent), connection: { id: agent.connection_id, routingMode },
    admission: { connectionId: agent.connection_id, routingMode, requestsPerDay: row.requests_per_day, tokensPerDay: row.tokens_per_day } };
}

const saveSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/).optional(),
  name: z.string().trim().min(1).max(80),
  preset: z.enum(['freellmapi', 'custom']).default('custom'),
  baseUrl: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(true),
  /** Write-only. Omit to keep the stored key. */
  apiKey: z.string().min(1).max(4096).optional(),
  limits: z.object({ requestsPerDay: z.number().int().min(1).max(100_000), tokensPerDay: z.number().int().min(1_000).max(1_000_000_000) }).partial().optional(),
}).strict();

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderSetupError('The endpoint base URL is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProviderSetupError('The endpoint must use http or https.');
  if (url.username || url.password) throw new ProviderSetupError('Put the key in the key field, not in the URL.');
  if (url.search || url.hash) throw new ProviderSetupError('The endpoint base URL cannot contain a query or fragment.');
  return url.toString().replace(/\/+$/, '');
}

export function parseCatalog(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ProviderSetupError('The gateway returned a model list without a data array.');
  const seen = new Set<string>(), models: CatalogModel[] = [];
  for (const raw of data.slice(0, CATALOG_MAX_MODELS)) {
    const entry = raw as Record<string, any>;
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const executionStatus = typeof entry.execution_status === 'string' ? entry.execution_status.slice(0, 40) : null;
    const flag = (...values: unknown[]) => { const found = values.find(v => typeof v === 'boolean'); return typeof found === 'boolean' ? found : null; };
    models.push({ id: entry.id, executionStatus, usable: executionStatus === null ? null : executionStatus === 'ready',
      virtual: isVirtualModel(entry.id) || entry.virtual === true,
      supportsTools: flag(entry.supports_tools, entry.capabilities?.tools), supportsVision: flag(entry.supports_vision, entry.capabilities?.vision, Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities.includes('image') : undefined),
      contextWindow: Number.isSafeInteger(entry.context_window) && entry.context_window > 0 ? entry.context_window : null });
  }
  return models;
}

function statusFromCatalog(models: CatalogModel[]): { status: ConnectionStatus; message: string } {
  const concrete = models.filter(m => !m.virtual);
  const ready = concrete.filter(m => m.usable === true).length;
  if (ready) return { status: 'connected', message: `${ready} of ${concrete.length} models can serve now.` };
  if (concrete.some(m => m.usable === null)) return { status: 'connected', message: 'Connected. Model availability is checked when you send a request; this provider does not publish live readiness.' };
  if (concrete.length && concrete.every(m => m.executionStatus === 'exhausted')) return { status: 'exhausted', message: 'Every listed model is rate limited or out of quota right now.' };
  return { status: 'no_usable_models', message: concrete.length ? 'The gateway lists models, but none has a usable provider key.' : 'The gateway lists no concrete models.' };
}

interface Row {
  id: string; name: string; preset: 'freellmapi' | 'custom'; base_url: string; enabled: number; requests_per_day: number; tokens_per_day: number;
  status: ConnectionStatus; status_message: string; checked_at: number | null; catalog_json: string | null; catalog_fetched_at: number | null; created_at: number; updated_at: number;
}

type Outcome = { status: ConnectionStatus; message: string; catalog?: CatalogModel[] };

export class ProviderConnectionService {
  private readonly keys = new Map<string, { key: string; fingerprint: string; revision: number }>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly store: AgentStore, private readonly secrets: SecretStore, private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly now = Date.now) {}

  availability() { return this.secrets.availability(); }

  list(): ProviderConnection[] {
    return (this.store.getDatabase().prepare('SELECT * FROM provider_connections ORDER BY name, id').all() as unknown as Row[]).map(row => this.toPublic(row));
  }

  get(id: string): ProviderConnection | null {
    const row = this.row(id);
    return row ? this.toPublic(row) : null;
  }

  /** Validates and protects everything first; the database changes only in one final transaction. */
  async save(input: unknown): Promise<ProviderConnection> {
    const value = saveSchema.parse(input);
    const baseUrl = normalizeBaseUrl(value.baseUrl);
    const existing = value.id ? this.row(value.id) : undefined;
    if (value.id && !existing) throw new ProviderSetupError('That connection does not exist.', 404);
    let ciphertext: string | undefined, backend = '';
    if (value.apiKey !== undefined) {
      const availability = await this.secrets.availability();
      if (!availability.available) throw new ProviderSetupError(availability.reason ?? 'Protected credential storage is unavailable, so the key was not saved.', 409);
      ciphertext = await this.secrets.protect(value.apiKey);
      backend = availability.backend;
    }
    const slug = value.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connection';
    const id = existing?.id ?? `${slug}-${randomBytes(3).toString('hex')}`;
    const now = this.now();
    const endpointChanged = !existing || existing.base_url !== baseUrl || ciphertext !== undefined;
    this.store.transaction(() => {
      const db = this.store.getDatabase();
      const hasKey = ciphertext !== undefined || !!db.prepare('SELECT 1 FROM provider_secrets WHERE connection_id = ?').get(id);
      const keepChecked = !!existing && !endpointChanged && !!existing.enabled && !['disabled', 'incomplete', 'untested'].includes(existing.status);
      const status: ConnectionStatus = !value.enabled ? 'disabled' : !hasKey ? 'incomplete' : keepChecked ? existing!.status : 'untested';
      const message = status === 'disabled' ? 'Disabled.' : status === 'incomplete' ? 'Add the gateway key to finish setup.' : keepChecked ? existing!.status_message : 'Saved. Test the connection to confirm it works.';
      db.prepare(`INSERT INTO provider_connections(id,name,preset,base_url,enabled,requests_per_day,tokens_per_day,status,status_message,checked_at,catalog_json,catalog_fetched_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, preset=excluded.preset, base_url=excluded.base_url, enabled=excluded.enabled,
        requests_per_day=excluded.requests_per_day, tokens_per_day=excluded.tokens_per_day, status=excluded.status, status_message=excluded.status_message,
        checked_at=excluded.checked_at, catalog_json=excluded.catalog_json, catalog_fetched_at=excluded.catalog_fetched_at, updated_at=excluded.updated_at`)
        .run(id, value.name, value.preset, baseUrl, Number(value.enabled),
          value.limits?.requestsPerDay ?? existing?.requests_per_day ?? DEFAULT_ADMISSION.requestsPerDay,
          value.limits?.tokensPerDay ?? existing?.tokens_per_day ?? DEFAULT_ADMISSION.tokensPerDay, status, message,
          keepChecked ? existing!.checked_at : null, endpointChanged ? null : existing!.catalog_json, endpointChanged ? null : existing!.catalog_fetched_at, existing?.created_at ?? now, now);
      if (ciphertext !== undefined) db.prepare(`INSERT INTO provider_secrets(connection_id,ciphertext,backend,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(connection_id) DO UPDATE SET ciphertext=excluded.ciphertext, backend=excluded.backend, updated_at=excluded.updated_at`).run(id, ciphertext, backend, now);
    });
    this.invalidateKey(id);
    return this.get(id)!;
  }

  removeKey(id: string): ProviderConnection {
    if (!this.row(id)) throw new ProviderSetupError('That connection does not exist.', 404);
    this.store.transaction(() => {
      const db = this.store.getDatabase();
      db.prepare('DELETE FROM provider_secrets WHERE connection_id = ?').run(id);
      db.prepare("UPDATE provider_connections SET status='incomplete', status_message='The gateway key was removed. Add a key to finish setup.', checked_at=NULL, catalog_json=NULL, catalog_fetched_at=NULL, updated_at=? WHERE id = ?").run(this.now(), id);
    });
    this.invalidateKey(id);
    return this.get(id)!;
  }

  remove(id: string): { removed: boolean } {
    const users = this.usedBy(id);
    if (users.length) throw new ProviderSetupError(`Bots still use this connection: ${users.join(', ')}. Choose another model for them first.`, 409);
    const removed = this.store.transaction(() => {
      const db = this.store.getDatabase();
      db.prepare('DELETE FROM provider_secrets WHERE connection_id = ?').run(id);
      return Number(db.prepare('DELETE FROM provider_connections WHERE id = ?').run(id).changes) > 0;
    });
    this.invalidateKey(id);
    return { removed };
  }

  /** Reads only the model list: no generation and no bot changes. */
  async test(id: string): Promise<ProviderConnection> {
    const row = this.row(id);
    if (!row) throw new ProviderSetupError('That connection does not exist.', 404);
    const fingerprint = this.probeFingerprint(id);
    let outcome: Outcome | undefined;
    if (!row.enabled) outcome = { status: 'disabled', message: 'Disabled.' };
    let key: string | undefined;
    if (!outcome) {
      try { key = (await this.resolveForRequest(id)).apiKey; } catch (error) { outcome = { status: 'incomplete', message: error instanceof Error ? error.message : String(error) }; }
    }
    if (this.probeFingerprint(id) === fingerprint) outcome ??= await this.probe(row.base_url, key!);
    // Network I/O yields to settings edits. Never attach the old endpoint/key's result to its replacement.
    if (this.probeFingerprint(id) !== fingerprint) {
      const current = this.get(id);
      if (!current) throw new ProviderSetupError('The connection was removed while it was being tested.', 404);
      return current;
    }
    const now = this.now();
    if (!outcome) throw new ProviderSetupError('Provider settings changed. Retry the connection test.', 409);
    this.store.getDatabase().prepare('UPDATE provider_connections SET status=?, status_message=?, checked_at=?, catalog_json=COALESCE(?, catalog_json), catalog_fetched_at=COALESCE(?, catalog_fetched_at), updated_at=? WHERE id=?')
      .run(outcome.status, outcome.message, now, outcome.catalog ? JSON.stringify(outcome.catalog) : null, outcome.catalog ? now : null, now, id);
    return this.get(id)!;
  }

  refreshModels(id: string) { return this.test(id); }

  /** Cached catalog, refreshed only when older than the bounded cache window. */
  async models(id: string): Promise<ProviderConnection> {
    const row = this.row(id);
    if (!row) throw new ProviderSetupError('That connection does not exist.', 404);
    return row.catalog_fetched_at !== null && this.now() - row.catalog_fetched_at < CATALOG_MAX_AGE_MS ? this.toPublic(row) : this.test(id);
  }

  /** For the inference transport only. Every refusal names the setup step the operator must take. */
  async resolveForRequest(id: string): Promise<ResolvedConnection> {
    const row = this.row(id);
    if (!row) throw new ProviderSetupError('This bot uses a provider connection that no longer exists. Choose another model in bot settings.');
    if (!row.enabled) throw new ProviderSetupError(`Provider connection "${row.name}" is disabled in Settings → Providers.`);
    const revision = this.revisions.get(id) ?? 0;
    const fingerprint = this.credentialFingerprint(id);
    const apiKey = await this.keyFor(id);
    this.assertCurrent(id, revision, fingerprint);
    return { id, baseUrl: row.base_url, apiKey, label: `Provider connection "${row.name}"` };
  }

  /** Query live FreeLLMAPI gateway status, routing strategy, and upstream keys. */
  async getGatewayStatus(id: string): Promise<any> {
    const row = this.row(id);
    if (!row) throw new ProviderSetupError('That connection does not exist.', 404);
    const resolved = await this.resolveForRequest(id);
    const key = resolved.apiKey;
    let origin: string;
    try { origin = new URL(resolved.baseUrl).origin; } catch { throw new ProviderSetupError('Invalid connection base URL', 400); }

    const fetchJson = async (path: string) => {
      try {
        const res = await this.fetcher(`${origin}${path}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    };

    const [upstream, routing, tokenUsage] = await Promise.all([
      fetchJson('/v1/providers'),
      fetchJson('/api/fallback/routing'),
      fetchJson('/api/fallback/token-usage'),
    ]);

    return {
      connectionId: id,
      name: row.name,
      upstream: upstream ?? { providers: [], counts: { healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 } },
      routing: routing ?? null,
      tokenUsage: tokenUsage ?? null,
    };
  }

  /** Update live FreeLLMAPI gateway routing strategy, weights, or explore options. */
  async updateGatewayRouting(id: string, payload: unknown): Promise<any> {
    const row = this.row(id);
    if (!row) throw new ProviderSetupError('That connection does not exist.', 404);
    const resolved = await this.resolveForRequest(id);
    const key = resolved.apiKey;
    let origin: string;
    try { origin = new URL(resolved.baseUrl).origin; } catch { throw new ProviderSetupError('Invalid connection base URL', 400); }

    let response: Response;
    try {
      response = await this.fetcher(`${origin}/api/fallback/routing`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new ProviderSetupError(`Failed to reach gateway to update routing: ${err?.message ?? err}`, 502);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new ProviderSetupError(`Gateway rejected routing update (HTTP ${response.status}): ${errText}`, response.status);
    }

    return await response.json();
  }

  async getGatewayTokenUsage(id: string): Promise<any | null> {
    try {
      const row = this.row(id);
      if (!row || !row.enabled) return null;
      const resolved = await this.resolveForRequest(id);
      const key = resolved.apiKey;
      const origin = new URL(resolved.baseUrl).origin;
      const res = await this.fetcher(`${origin}/api/fallback/token-usage`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async collectGatewayQuotas(): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    for (const conn of this.list()) {
      if (conn.enabled && conn.hasKey) {
        const usage = await this.getGatewayTokenUsage(conn.id);
        if (usage && typeof usage.totalBudget === 'number') {
          map.set(conn.id, {
            available: true,
            totalBudget: usage.totalBudget,
            totalUsed: usage.totalUsed ?? 0,
            models: usage.models ?? [],
          });
        }
      }
    }
    return map;
  }

  private usedBy(id: string): string[] {
    return (this.store.getDatabase().prepare('SELECT id FROM agents WHERE connection_id = ? ORDER BY id').all(id) as Array<{ id: string }>).map(agent => agent.id);
  }

  private async keyFor(id: string): Promise<string> {
    const revision = this.revisions.get(id) ?? 0;
    const fingerprint = this.credentialFingerprint(id);
    const cached = this.keys.get(id);
    if (cached?.revision === revision && cached.fingerprint === fingerprint) return cached.key;
    this.keys.delete(id);
    const secret = this.store.getDatabase().prepare('SELECT ciphertext FROM provider_secrets WHERE connection_id = ?').get(id) as { ciphertext: string } | undefined;
    if (!secret) throw new ProviderSetupError('No gateway key is stored for this connection. Add it in Settings → Providers.');
    let key: string;
    try { key = await this.secrets.unprotect(secret.ciphertext); }
    catch (error) { throw new ProviderSetupError(`The stored gateway key could not be unlocked for this user (${error instanceof Error ? error.message : String(error)}). Replace the key in Settings → Providers.`); }
    this.assertCurrent(id, revision, fingerprint);
    this.keys.set(id, { key, revision, fingerprint });
    return key;
  }

  private invalidateKey(id: string): void {
    this.keys.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  private assertCurrent(id: string, revision: number, fingerprint: string): void {
    if ((this.revisions.get(id) ?? 0) !== revision || this.credentialFingerprint(id) !== fingerprint) {
      throw new ProviderSetupError('Provider settings changed while the key was being unlocked. Retry with the current connection settings.', 409);
    }
  }

  private credentialFingerprint(id: string): string {
    // Catalog refreshes are not credential edits. Also validate persisted identity
    // on cache hits in case another service instance changed this connection.
    return JSON.stringify(this.store.getDatabase().prepare(`SELECT p.base_url, p.enabled, s.ciphertext
      FROM provider_connections p LEFT JOIN provider_secrets s ON s.connection_id=p.id WHERE p.id=?`).get(id) ?? null);
  }

  private async probe(baseUrl: string, key: string): Promise<Outcome> {
    let response: Response;
    try { response = await this.fetcher(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }); }
    catch (error) {
      const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'the request timed out' : 'the connection failed';
      return { status: 'unreachable', message: `Could not reach ${baseUrl}: ${reason}. Is the gateway running?` };
    }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return { status: 'invalid_credentials', message: `The gateway rejected the key (HTTP ${response.status}).` }; }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { status: 'unreachable', message: `The gateway redirected (HTTP ${response.status}). Redirects are not followed with a key; enter the final base URL.` }; }
    if (!response.ok) { await response.body?.cancel(); return { status: 'unreachable', message: `The gateway answered HTTP ${response.status} for its model list.` }; }
    let catalog: CatalogModel[];
    try { catalog = parseCatalog(await response.json()); }
    catch (error) { return { status: 'invalid_catalog', message: error instanceof ProviderSetupError ? error.message : 'The gateway returned a model list that is not valid JSON.' }; }
    return { ...statusFromCatalog(catalog), catalog };
  }

  private row(id: string): Row | undefined {
    return this.store.getDatabase().prepare('SELECT * FROM provider_connections WHERE id = ?').get(id) as unknown as Row | undefined;
  }

  private probeFingerprint(id: string): string {
    return JSON.stringify(this.store.getDatabase().prepare(`SELECT p.base_url, p.enabled, p.updated_at, s.ciphertext
      FROM provider_connections p LEFT JOIN provider_secrets s ON s.connection_id=p.id WHERE p.id=?`).get(id) ?? null);
  }

  private toPublic(row: Row): ProviderConnection {
    const db = this.store.getDatabase();
    const hasKey = !!db.prepare('SELECT 1 FROM provider_secrets WHERE connection_id = ?').get(row.id);
    let dashboardUrl = row.base_url;
    try { dashboardUrl = new URL(row.base_url).origin; } catch { /* stored values are normalised on save */ }
    return { id: row.id, name: row.name, preset: row.preset, baseUrl: row.base_url, enabled: !!row.enabled, hasKey, status: row.status, statusMessage: row.status_message, checkedAt: row.checked_at,
      catalog: { fetchedAt: row.catalog_fetched_at, models: row.catalog_json ? JSON.parse(row.catalog_json) as CatalogModel[] : [] },
      limits: { requestsPerDay: row.requests_per_day, tokensPerDay: row.tokens_per_day }, admissionUsed: connectionAdmissionUsage(db, row.id, this.now()),
      dashboardUrl, pinning: 'identity-checked-per-turn', usedBy: this.usedBy(row.id), createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
