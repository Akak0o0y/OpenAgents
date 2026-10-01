/**
 * Multi-Provider LLM Client for Autonomous Trace Collection
 * Supports OpenRouter (dynamic catalog), Anthropic, OpenAI, and Gemini with zero external dependencies (native fetch).
 * Includes exponential backoff retries for 429/503, distinct attemptCount tracking,
 * RateLimitExceededError propagation, and MockLLMClient for offline trace harness testing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { aliasOpenAgentsEnv } from '../kernel/env-alias.js';
import { parseSse } from './llm/sse.js';
import { translateChatCompletions } from './llm/chat-completions.js';
import { translateAnthropicMessages } from './llm/anthropic-messages.js';
import { BlockAssembler, type StreamChunk, type ToolCallBlock } from './llm/stream.js';
import {
  RateLimitExceededError,
  registerManyModelPricing,
} from '../kernel/cost-ledger.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatImage { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  images?: ChatImage[];
}

export interface LLMRequest {
  signal?: AbortSignal;
  /** Metadata only: never prompts, credentials, answer text or private reasoning. */
  onProviderEvent?: (event: ProviderEvent) => void;
  /** Stream callbacks for progressive text and reasoning deltas. */
  onStream?: (chunk: StreamChunk) => void;
  /** Streaming behavior: 'auto' (default if onStream provided) or 'off'. */
  stream?: 'auto' | 'off';
  modelId: string;
  systemPrompt: string;
  /**
   * The latest user turn. Always populated, so single-shot callers and
   * MockLLMClient's task-id matching keep working unchanged.
   */
  userPrompt: string;
  /**
   * Full conversation history. When present, the whole array is transmitted
   * instead of just `userPrompt`.
   *
   * This field exists because it was missing: AgentLoop accumulated a messages
   * array and then sent only its last element, so the "conversational" loop was
   * silently stateless - the model never saw its own prior attempts. Any
   * multi-turn caller MUST pass this.
   *
   * Entries with role 'system' are dropped; `systemPrompt` is authoritative.
   */
  messages?: ChatMessage[];
  /** Tool definitions for native tool calling when supported. */
  tools?: ToolDefinition[];
  /** Whether the model may emit multiple tool calls in parallel. */
  parallel_tool_calls?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** An operator-configured gateway connection. The key is resolved inside the transport and never travels on the request. */
  connection?: { id: string; routingMode: RoutingMode };
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  attemptCount: number; // Retries on 429/503 kept separate from agent turnNumber
  finishReason?: string;
  usageKnown?: boolean;
  /** Present for gateway connections: requested versus served identity for this call. */
  served?: ServedIdentity;
}

export type RoutingMode = 'pinned' | 'auto';

/** Resolves a connection for one request. Implementations must never put the key into errors. */
export interface ConnectionResolver {
  resolveForRequest(id: string): Promise<{ id: string; baseUrl: string; apiKey: string; label: string }>;
}

/** Routing metadata a gateway reported for one call, bounded and redacted, or null where it reported nothing. */
/**
 * Whether a provider-reported model is the requested one.
 *
 * Providers report the concrete model, which may carry a platform prefix or a
 * dated or tagged variant of the requested ID (openai/gpt-4o ->
 * openai/gpt-4o-2024-08-06). An alias (`~vendor/model-latest`, `.../auto`)
 * names a moving target, so whatever it resolved to is the requested model.
 */
export function servedModelMatches(served: string, requested: string): boolean {
  const normalise = (id: string) => id.trim().toLowerCase().replace(/^~/, '');
  const want = normalise(requested);
  if (requested.trim().startsWith('~') || /(^|\/)auto$|-latest$/.test(want)) return true;
  const got = normalise(served);
  const bare = (id: string) => id.slice(id.indexOf('/') + 1);
  return [got, bare(got)].some((candidate) =>
    [want, bare(want)].some((target) => candidate === target || candidate.startsWith(`${target}-`) || candidate.startsWith(`${target}:`)));
}

export interface ServedIdentity {
  connectionId: string;
  routingMode: RoutingMode;
  requestedModel: string;
  /** `<platform>/<model>` from X-Routed-Via. */
  routedVia: string | null;
  /** Whether the served model ID equals the requested one; null when the gateway did not say. */
  matchesRequested: boolean | null;
  fallbackAttempts: number | null;
  fallbackTrail: string | null;
  requestId: string | null;
  /** Gateways may estimate usage when the upstream reports none, so it is never labelled provider-reported. */
  usageSource: 'gateway-reported';
}

export interface ProviderEvent {
  phase: 'attempt' | 'headers' | 'retry' | 'complete' | 'failed';
  modelId: string;
  attempt: number;
  elapsedMs: number;
  status?: number;
  code?: string;
  delayMs?: number;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  streamed?: boolean;
}

/**
 * The reply a completion carries.
 *
 * Some models, asked for text, still answer through the API's structured
 * `tool_calls` field and leave the content empty - DeepSeek through OpenRouter
 * did in the owner's routine run, which then failed with "no final answer".
 * That call IS the reply, so it is returned as the JSON action it names.
 */
export function completionText(message: { content?: unknown; tool_calls?: unknown } | undefined): string {
  const content = typeof message?.content === 'string' ? message.content : '';
  if (content.trim() || !Array.isArray(message?.tool_calls)) return content;
  const call = (message.tool_calls as unknown[]).find((entry): entry is { function: { name: string; arguments?: unknown } } =>
    Boolean(entry && typeof entry === 'object' && typeof (entry as { function?: { name?: unknown } }).function?.name === 'string'));
  if (!call) return content;
  let args: unknown = call.function.arguments ?? {};
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { return content; }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? JSON.stringify({ ...(args as Record<string, unknown>), tool: call.function.name }) : content;
}

/** Attempts against a gateway whose own upstream is failing. Bounded: a routine that
 * retries forever never reports anything to its owner. */
const GATEWAY_TRANSIENT_ATTEMPTS = 3;
const GATEWAY_TRANSIENT_BACKOFF_MS = 1500;

export class ProviderCallError extends Error {
  readonly name = 'ProviderCallError';
  constructor(
    readonly code: 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'EMPTY_RESPONSE' | 'OUTPUT_LIMIT' | 'CONNECTION_UNAVAILABLE' | 'IDENTITY_UNVERIFIED',
    message: string,
    readonly details: { status?: number; usage?: { inputTokens: number; outputTokens: number }; finishReason?: string;
      /** Gateway identity of the refused or failed call. */
      served?: ServedIdentity;
      /** True only when the request never left OpenAgents. */
      notSent?: boolean } = {},
  ) { super(message); }
}

function knownUsage(inputTokens: unknown, outputTokens: unknown): boolean {
  return Number.isSafeInteger(inputTokens) && Number(inputTokens) >= 0 && Number.isSafeInteger(outputTokens) && Number(outputTokens) >= 0;
}

export interface ILLMClient {
  generateCode(req: LLMRequest): Promise<LLMResponse>;
}

export interface OpenRouterModelItem {
  id: string;
  name: string;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  context_length?: number;
  supported_parameters?: string[];
}

const openRouterSupportedParams = new Map<string, string[]>();
const openRouterContextLengths = new Map<string, number>();

export function getOpenRouterSupportedParameters(modelId: string): string[] | undefined {
  return openRouterSupportedParams.get(modelId);
}

export function getOpenRouterContextLength(modelId: string): number | undefined {
  return openRouterContextLengths.get(modelId);
}

/**
 * Dynamically fetches and registers OpenRouter models and pricing.
 * Caches catalog to disk with configurable TTL (default 24h) to survive network blips.
 */
export interface OpenRouterCatalogCache {
  provenance: {
    fetchedAt: string;
    sourceUrl: string;
    httpStatus: number;
    headers: {
      date: string;
      etag?: string;
      cfRay?: string;
      server?: string;
      age?: string;
    };
  };
  data: OpenRouterModelItem[];
}

/**
 * Strict shape check for OpenRouter catalog payload.
 * Real entries MUST have a non-empty string id, and pricing object with
 * string prompt and completion rates.
 */
export function validateOpenRouterCatalogShape(data: unknown): OpenRouterModelItem[] {
  if (!data || typeof data !== 'object') {
    throw new Error('OpenRouter catalog response must be a valid JSON object.');
  }
  const payload = data as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new Error('OpenRouter catalog response must contain a "data" array.');
  }
  if (payload.data.length === 0) {
    throw new Error('OpenRouter catalog returned 0 models.');
  }

  for (const item of payload.data) {
    if (!item || typeof item !== 'object') {
      throw new Error('Malformed OpenRouter catalog entry: expected an object.');
    }
    const model = item as Record<string, any>;
    if (typeof model.id !== 'string' || model.id.trim() === '') {
      throw new Error('Malformed OpenRouter catalog entry: missing or non-string "id".');
    }
    if (!model.pricing || typeof model.pricing !== 'object') {
      throw new Error(`Malformed OpenRouter catalog entry "${model.id}": missing "pricing" object.`);
    }
    // OpenRouter schemas provide pricing values as strings (e.g. "0.0000001")
    if (typeof model.pricing.prompt !== 'string') {
      throw new Error(
        `Malformed OpenRouter catalog entry "${model.id}": pricing.prompt must be a string, got ${typeof model.pricing.prompt}.`
      );
    }
    if (typeof model.pricing.completion !== 'string') {
      throw new Error(
        `Malformed OpenRouter catalog entry "${model.id}": pricing.completion must be a string, got ${typeof model.pricing.completion}.`
      );
    }
    if (Array.isArray(model.supported_parameters)) {
      model.supported_parameters = model.supported_parameters.filter((p: unknown) => typeof p === 'string');
    }
  }

  return payload.data as OpenRouterModelItem[];
}

/**
 * Dynamically fetches and registers OpenRouter models and pricing.
 * Fails loudly on network error, non-200 HTTP response, or malformed schema.
 * Rejects any catalog lacking genuine OpenRouter string pricing or HTTP provenance.
 */
export async function syncOpenRouterCatalog(
  options: { cacheTtlMs?: number; apiKey?: string } = {}
): Promise<{ loadedFrom: 'network' | 'cache'; count: number; provenance?: OpenRouterCatalogCache['provenance'] }> {
  const cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const cacheDir = path.resolve(process.cwd(), 'evals', 'cache');
  const cachePath = path.join(cacheDir, 'openrouter-models.json');

  // 1. Check valid disk cache with verified HTTP provenance
  if (fs.existsSync(cachePath)) {
    try {
      const stats = fs.statSync(cachePath);
      const isFresh = Date.now() - stats.mtimeMs < cacheTtlMs;
      if (isFresh) {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !parsed.provenance ||
          parsed.provenance.httpStatus !== 200 ||
          parsed.provenance.sourceUrl !== 'https://openrouter.ai/api/v1/models' ||
          !parsed.provenance.headers?.date
        ) {
          throw new Error('Cache lacks verified HTTP provenance headers. Forcing live fetch.');
        }

        const validModels = validateOpenRouterCatalogShape(parsed);
        registerOpenRouterModels(validModels);
        return {
          loadedFrom: 'cache',
          count: validModels.length,
          provenance: parsed.provenance,
        };
      }
    } catch {
      // Unreadable, unverified, or corrupted cache: remove it and fetch fresh
      try {
        fs.unlinkSync(cachePath);
      } catch {}
    }
  }

  // 2. Fetch live catalog from OpenRouter API
  const headers: Record<string, string> = {
    'User-Agent': 'Antigravity-Harness/1.0',
  };
  const key = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/models', { headers, signal: AbortSignal.timeout(15_000) });
  } catch (netErr: unknown) {
    const msg = netErr instanceof Error ? netErr.message : String(netErr);
    throw new Error(`Failed to fetch OpenRouter catalog (network error): ${msg}`);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch OpenRouter catalog: HTTP ${res.status} ${res.statusText}`);
  }

  let rawData: unknown;
  try {
    rawData = await res.json();
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Failed to parse OpenRouter catalog response as JSON: ${msg}`);
  }

  // 3. Strict schema validation: refuse synthetic or malformed catalog
  const models = validateOpenRouterCatalogShape(rawData);

  // Write verified catalog with full HTTP provenance to disk
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const cachePayload: OpenRouterCatalogCache = {
    provenance: {
      fetchedAt: new Date().toISOString(),
      sourceUrl: 'https://openrouter.ai/api/v1/models',
      httpStatus: res.status,
      headers: {
        date: res.headers.get('date') || '',
        etag: res.headers.get('etag') || '',
        cfRay: res.headers.get('cf-ray') || '',
        server: res.headers.get('server') || '',
        age: res.headers.get('age') || '',
      },
    },
    data: models,
  };

  fs.writeFileSync(cachePath, JSON.stringify(cachePayload, null, 2), 'utf-8');

  registerOpenRouterModels(models);
  return { loadedFrom: 'network', count: models.length, provenance: cachePayload.provenance };
}

function registerOpenRouterModels(models: OpenRouterModelItem[]) {
  const pricingBatch: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {};
  for (const m of models) {
    if (!m.id) continue;
    if (Array.isArray(m.supported_parameters)) {
      openRouterSupportedParams.set(m.id, m.supported_parameters);
    }
    if (typeof m.context_length === 'number' && m.context_length > 0) {
      openRouterContextLengths.set(m.id, m.context_length);
    }
    const promptVal = parseFloat(String(m.pricing?.prompt ?? '0')) || 0;
    const completionVal = parseFloat(String(m.pricing?.completion ?? '0')) || 0;
    pricingBatch[m.id] = {
      inputPerMillion: promptVal * 1_000_000,
      outputPerMillion: completionVal * 1_000_000,
    };
  }
  registerManyModelPricing(pricingBatch);
}

/**
 * Register pricing for OpenCode-hosted providers from the models.dev catalog.
 *
 * OpenCode Zen / Go are not on OpenRouter, so syncOpenRouterCatalog never sees
 * them and getModelPricing throws for `opencode/...` ids. models.dev is the same
 * catalog the opencode CLI itself consumes, so this is the model's own source of
 * truth rather than a hand-maintained table.
 *
 * Costs there are stated in dollars per MILLION tokens (verified: anthropic
 * claude-sonnet-4-6 reads input 3 / output 15), which is already the unit the
 * ledger wants - no conversion.
 *
 * Fails loudly on network error, non-200, or malformed shape. A free model has a
 * genuine 0 cost; a MISSING cost is a bug and is rejected rather than defaulted.
 */
export async function syncModelsDevCatalog(
  options: { providers?: string[]; cacheTtlMs?: number } = {}
): Promise<{ loadedFrom: 'network' | 'cache'; count: number; providers: string[] }> {
  const providers = options.providers ?? ['opencode', 'opencode-go'];
  const cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const cacheDir = path.resolve(process.cwd(), 'evals', 'cache');
  const cachePath = path.join(cacheDir, 'models-dev.json');

  let payload: any = null;
  let loadedFrom: 'network' | 'cache' = 'network';

  if (fs.existsSync(cachePath)) {
    try {
      const stats = fs.statSync(cachePath);
      if (Date.now() - stats.mtimeMs < cacheTtlMs) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (parsed?.provenance?.httpStatus === 200 && parsed?.data) {
          payload = parsed.data;
          loadedFrom = 'cache';
        }
      }
    } catch {
      try { fs.unlinkSync(cachePath); } catch {}
    }
  }

  if (!payload) {
    let res: Response;
    try {
      res = await fetch('https://models.dev/api.json', {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'OpenAgents-Harness/1.0' },
      });
    } catch (netErr: unknown) {
      const msg = netErr instanceof Error ? netErr.message : String(netErr);
      throw new Error(`Failed to fetch models.dev catalog (network error): ${msg}`);
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch models.dev catalog: HTTP ${res.status} ${res.statusText}`);
    }
    payload = await res.json();

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify(
        {
          provenance: {
            fetchedAt: new Date().toISOString(),
            sourceUrl: 'https://models.dev/api.json',
            httpStatus: res.status,
            headers: { date: res.headers.get('date') || '' },
          },
          data: payload,
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('models.dev catalog must be a JSON object.');
  }

  const pricingBatch: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {};
  const found: string[] = [];

  for (const providerId of providers) {
    const provider = payload[providerId];
    if (!provider || typeof provider !== 'object' || !provider.models) {
      throw new Error(`models.dev catalog has no provider "${providerId}".`);
    }
    const models = provider.models as Record<string, any>;
    const ids = Object.keys(models);
    if (ids.length === 0) {
      throw new Error(`models.dev provider "${providerId}" returned 0 models.`);
    }
    for (const modelId of ids) {
      const cost = models[modelId]?.cost;
      if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
        // A free model reports 0. Absent cost means the shape changed - do not guess.
        throw new Error(
          `models.dev entry "${providerId}/${modelId}" has no numeric cost.input/cost.output.`
        );
      }
      pricingBatch[`${providerId}/${modelId}`] = {
        inputPerMillion: cost.input,
        outputPerMillion: cost.output,
      };
      const limitContext = models[modelId]?.limit?.context;
      if (typeof limitContext === 'number' && limitContext > 0) {
        openRouterContextLengths.set(`${providerId}/${modelId}`, limitContext);
        openRouterContextLengths.set(modelId, limitContext);
      }
    }
    found.push(providerId);
  }

  registerManyModelPricing(pricingBatch);
  return { loadedFrom, count: Object.keys(pricingBatch).length, providers: found };
}

/**
 * Hydrate process.env from .env files.
 *
 * Extracted from LiveLLMClient so it can be called explicitly. The OpenCode
 * executor also needs OPENROUTER_API_KEY, and having that depend on whether a
 * LiveLLMClient happened to be constructed first is an ordering landmine.
 *
 * Never clobbers an already-set variable: a real environment always wins over a
 * checked-in file.
 */
export function loadEnvFiles(): void {
  const explicitPath = process.env.OPENHOURS_ENV_FILE?.trim();
  if (explicitPath && !path.isAbsolute(explicitPath)) {
    throw new Error('OPENAGENTS_ENV_FILE must be an absolute path.');
  }

  const candidatePaths = [
    explicitPath,
    path.resolve(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
  ].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);

  if (explicitPath && !fs.existsSync(explicitPath)) {
    throw new Error(`OPENAGENTS_ENV_FILE does not exist: ${explicitPath}`);
  }

  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
  // A file may use the new OPENAGENTS_* names too; the start-up aliasing ran before it was read.
  aliasOpenAgentsEnv();
}

/**
 * Resolve the conversation to transmit.
 *
 * `messages` wins when supplied; otherwise this degrades to the single-shot
 * `userPrompt`, which is what stateless callers (trace-runner, goal-producer)
 * genuinely want. System entries are dropped because `systemPrompt` is sent
 * separately and duplicating it wastes context and invites conflicting
 * instructions - layer-1 bloat.
 */
export function buildConversation(req: LLMRequest): ChatMessage[] {
  const history = (req.messages ?? []).filter((m) => m.role !== 'system');
  if (history.length > 0) return history;
  return [{ role: 'user', content: req.userPrompt }];
}

export function extractToolCalls(message: any): ToolCall[] | undefined {
  if (!message || !Array.isArray(message.tool_calls)) return undefined;
  const calls: ToolCall[] = [];
  for (const tc of message.tool_calls) {
    if (tc && typeof tc === 'object' && tc.function && typeof tc.function.name === 'string') {
      const args = typeof tc.function.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments ?? {});
      calls.push({
        id: typeof tc.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function.name,
        arguments: args,
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

export function extractAnthropicToolCalls(content: any): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'tool_use' && typeof block.name === 'string') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

export function formatOpenAITools(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function formatAnthropicTools(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function flattenConversationForJson(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      let actionText = '';
      try {
        const first = m.toolCalls[0];
        const parsed = JSON.parse(first.arguments);
        actionText = JSON.stringify({ ...parsed, tool: first.name });
      } catch {
        actionText = m.toolCalls.map((tc) => `${tc.name}(${tc.arguments})`).join('\n');
      }
      const combined = m.content ? `${m.content}\n${actionText}`.trim() : actionText;
      return {
        role: 'assistant',
        content: combined,
      };
    }
    return m;
  });
}

export function buildOpenAIMessages(req: LLMRequest): any[] {
  const conv = buildConversation(req);
  return conv.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.content,
      };
    }
    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }
      return { role: 'assistant', content: m.content };
    }
    return { role: 'user', content: m.images?.length ? [{type:'text',text:m.content}, ...m.images.map(image=>({type:'image_url',image_url:{url:`data:${image.mime};base64,${image.data}`}}))] : m.content };
  });
}

export function buildAnthropicMessages(req: LLMRequest): Array<{ role: 'user' | 'assistant'; content: any }> {
  const conv = buildConversation(req);
  const out: Array<{ role: 'user' | 'assistant'; content: any }> = [];

  for (const m of conv) {
    if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = {};
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          });
        }
      }
      out.push({
        role: 'assistant',
        content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
      });
    } else if (m.role === 'tool') {
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        if (typeof prev.content === 'string') {
          prev.content = [{ type: 'text', text: prev.content }, toolResultBlock];
        } else if (Array.isArray(prev.content)) {
          prev.content.push(toolResultBlock);
        }
      } else {
        out.push({ role: 'user', content: [toolResultBlock] });
      }
    } else {
      // m.role === 'user'
      const userBlocks = [{ type: 'text', text: m.content }, ...(m.images ?? []).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }))];
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        if (typeof prev.content === 'string') {
          prev.content = [{ type: 'text', text: prev.content }, ...userBlocks];
        } else if (Array.isArray(prev.content)) {
          prev.content.push(...userBlocks);
        }
      } else {
        out.push({ role: 'user', content: m.images?.length ? userBlocks : m.content });
      }
    }
  }

  return out;
}

const OPENROUTER_SLUG_MAP: Record<string, string> = {
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'deepseek-chat': 'deepseek/deepseek-chat',
};

export interface LLMClientOptions {
  /** Absolute response cap, including active streaming. */
  requestTimeoutMs?: number;
  /** Maximum silence between meaningful streaming deltas. */
  idleTimeoutMs?: number;
  retryBaseDelayMs?: number;
  connections?: ConnectionResolver;
  endpoints?: {
    anthropic?: string;
    openai?: string;
    openrouter?: string;
  };
}

/**
 * A native tool call is rewritten into the JSON action text the runtime expects. Arguments that do
 * not parse are a malformed provider response, not an argument-free call: silently substituting {}
 * would dispatch a different action from the one the model chose, and the model would be told its
 * action was invalid rather than that its arguments never arrived.
 */
export function nativeToolCallAsAction(call: { name: string; arguments: string }, modelId: string): string | undefined {
  let args: unknown = {};
  if (call.arguments.trim()) {
    try { args = JSON.parse(call.arguments); }
    catch {
      throw new ProviderCallError('INVALID_RESPONSE', `Model ${modelId} returned a ${call.name} tool call whose arguments are not valid JSON. No action was executed.`);
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args)
    ? JSON.stringify({ ...(args as Record<string, unknown>), tool: call.name })
    : undefined;
}

export class LiveLLMClient implements ILLMClient {
  private openrouterKey?: string;
  private opencodeKey?: string;
  private anthropicKey?: string;
  private openaiKey?: string;
  private geminiKey?: string;

  constructor(private readonly options: LLMClientOptions = {}) {
    if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 600_000)) throw new Error('Provider request timeout must be between 1 and 600000 ms.');
    if (options.idleTimeoutMs !== undefined && (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1 || options.idleTimeoutMs > 600_000)) throw new Error('Provider idle timeout must be between 1 and 600000 ms.');
    if (options.retryBaseDelayMs !== undefined && (!Number.isInteger(options.retryBaseDelayMs) || options.retryBaseDelayMs < 0 || options.retryBaseDelayMs > 30_000)) throw new Error('Provider retry delay must be between 0 and 30000 ms.');
    this.loadEnv();
  }

  private loadEnv() {
    loadEnvFiles();

    this.openrouterKey = process.env.OPENROUTER_API_KEY;
    this.opencodeKey = process.env.OPENCODE_API_KEY;
    this.anthropicKey = process.env.ANTHROPIC_API_KEY;
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.geminiKey = process.env.GEMINI_API_KEY;
  }

  /** Checked before isOpenRouterModel, which matches ANY id containing '/'. */
  private isOpenCodeModel(modelId: string): boolean {
    return modelId.startsWith('opencode/') || modelId.startsWith('opencode-go/');
  }

  private isOpenRouterModel(modelId: string): boolean {
    return (
      modelId.includes('/') ||
      modelId.includes(':free') ||
      modelId.startsWith('openrouter/') ||
      Boolean(OPENROUTER_SLUG_MAP[modelId])
    );
  }

  hasProvider(modelId: string): boolean {
    if (this.isOpenCodeModel(modelId)) return Boolean(this.opencodeKey);
    if (!modelId.includes('/') && modelId.startsWith('claude') && (this.anthropicKey || this.options.endpoints?.anthropic)) return true;
    if (!modelId.includes('/') && modelId.startsWith('gpt') && (this.openaiKey || this.options.endpoints?.openai)) return true;
    if (!modelId.includes('/') && modelId.startsWith('gemini') && this.geminiKey) return true;
    if (this.isOpenRouterModel(modelId)) return Boolean(this.openrouterKey || this.options.endpoints?.openrouter);
    if (modelId.startsWith('claude')) return Boolean(this.anthropicKey || this.options.endpoints?.anthropic || this.openrouterKey || this.options.endpoints?.openrouter);
    if (modelId.startsWith('gpt')) return Boolean(this.openaiKey || this.options.endpoints?.openai || this.openrouterKey || this.options.endpoints?.openrouter);
    if (modelId.startsWith('gemini')) return Boolean(this.geminiKey || this.openrouterKey || this.options.endpoints?.openrouter);
    if (this.openrouterKey || this.options.endpoints?.openrouter) return true; // OpenRouter as fallback router
    return false;
  }

  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    const callerSignal = req.signal;
    const deadline = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs ?? 600_000;
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 120_000;
    let timeoutKind = 'total';
    const expire = (kind: string) => { if (!deadline.signal.aborted) { timeoutKind = kind; deadline.abort(); } };
    const timer = setTimeout(() => expire('total'), timeoutMs);
    let idleTimer = setTimeout(() => expire('idle'), idleTimeoutMs);
    const streamObserver = req.onStream;
    const started = performance.now();
    const observer = req.onProviderEvent;
    let attempt = 0;
    const streamed = Boolean(req.onStream && req.stream !== 'off');
    const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), deadline.signal]);
    req = { ...req, signal, ...(streamObserver ? { onStream: (chunk: StreamChunk) => {
      // Heartbeats, empty deltas and metadata do not prove generation progress.
      const progress = ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
        || (chunk.type === 'tool-call-delta' && Boolean(chunk.argumentsDelta || chunk.name || chunk.id));
      if (progress && !signal.aborted) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => expire('idle'), idleTimeoutMs);
      }
      streamObserver(chunk);
    } } : {}), onProviderEvent: event => {
      attempt = event.attempt;
      observer?.({ ...event, modelId: req.modelId, elapsedMs: Math.round(performance.now() - started) });
    } };
    try {
      signal.throwIfAborted();
      const response = await this.dispatch(req);
      if (response.usageKnown === false) { response.inputTokens = 0; response.outputTokens = 0; }
      const usage = response.usageKnown ? { inputTokens: response.inputTokens, outputTokens: response.outputTokens } : undefined;
      const details = { usage, finishReason: response.finishReason };
      if (['length', 'max_tokens', 'MAX_TOKENS'].includes(response.finishReason ?? '')) {
        throw new ProviderCallError('OUTPUT_LIMIT', `Model ${req.modelId} reached its output token limit before completing the answer. No action was executed from this response.`, details);
      }
      if (typeof response.content !== 'string') throw new ProviderCallError('INVALID_RESPONSE', `Model ${req.modelId} returned invalid answer content.`, details);
      if (!response.content.trim() && (!response.toolCalls || response.toolCalls.length === 0)) throw new ProviderCallError('EMPTY_RESPONSE', `Model ${req.modelId} returned no final answer. Private reasoning is not an executable answer.`, details);
      req.onProviderEvent?.({phase:'complete', modelId:req.modelId, attempt:response.attemptCount, elapsedMs:0, finishReason:response.finishReason, streamed, ...usage});
      return response;
    } catch (error) {
      // AbortSignal.any preserves the first abort reason, including during backoff.
      const failure = signal.aborted
        ? new ProviderCallError(signal.reason === deadline.signal.reason ? 'TIMEOUT' : 'CANCELLED', signal.reason === deadline.signal.reason
          ? `Model ${req.modelId} ${timeoutKind === 'idle' ? `stopped making progress for ${idleTimeoutMs / 1000} seconds` : `exceeded the ${timeoutMs / 1000}-second total provider response deadline`} after ${attempt} attempt(s). It was not retried after timeout; provider usage may be unreported.`
          : `Model ${req.modelId} request stopped by its caller. Provider usage may be unreported.`)
        : error;
      req.onProviderEvent?.({phase:'failed',modelId:req.modelId,attempt,elapsedMs:0,streamed,code: failure instanceof ProviderCallError ? failure.code : failure instanceof RateLimitExceededError ? 'RATE_LIMIT' : 'PROVIDER_ERROR',
        ...(failure instanceof ProviderCallError ? {status:failure.details.status,finishReason:failure.details.finishReason,...failure.details.usage} : {})});
      throw failure;
    } finally { clearTimeout(timer); clearTimeout(idleTimer); }
  }

  private async fetchCompletion(req: LLMRequest, url: string, init: RequestInit, attempt = 1): Promise<Response> {
    req.signal?.throwIfAborted();
    req.onProviderEvent?.({phase:'attempt',modelId:req.modelId,attempt,elapsedMs:0});
    let response: Response;
    try { response = await fetch(url, { ...init, signal:req.signal }); }
    catch {
      req.signal?.throwIfAborted();
      throw new ProviderCallError('NETWORK', `Connection to the provider for ${req.modelId} failed. The request was not retried because generation may already have started; usage may be unreported.`);
    }
    req.onProviderEvent?.({phase:'headers',modelId:req.modelId,attempt,elapsedMs:0,status:response.status});
    return response;
  }

  private async readCompletion(res: Response): Promise<any> {
    const reader = res.body?.getReader();
    if (!reader) throw new ProviderCallError('INVALID_RESPONSE', 'Provider response body is missing.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ProviderCallError('INVALID_RESPONSE', 'Provider response exceeded the 2 MiB limit.'); }
        chunks.push(value);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProviderCallError('INVALID_RESPONSE', 'Provider returned malformed JSON. The response was not retried.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderCallError('INVALID_RESPONSE', 'Provider returned an invalid response object.');
      return data;
    } finally { reader.releaseLock(); }
  }

  /** Three attempts total against a gateway whose own upstream is failing, spaced so the
   * pool can change. Bounded because a routine that retries forever never reports. */
  // (module constants live below the class in this file, so they are declared inline here)

  /**
   * Operator-configured OpenAI-compatible gateway, such as FreeLLMAPI. Exactly one HTTP attempt: the gateway already
   * fails over internally (FreeLLMAPI makes up to 21 upstream attempts per call), so no OpenAgents 429/503 retry layer
   * is added. Redirects are refused so the key is never sent to another origin.
   */
  private async callGateway(req: LLMRequest, connection: NonNullable<LLMRequest['connection']>): Promise<LLMResponse> {
    const resolver = this.options.connections;
    if (!resolver) throw new ProviderCallError('CONNECTION_UNAVAILABLE', `This bot uses provider connection "${connection.id}", but this runtime has no provider connection settings. No request was sent.`, { notSent: true });
    let target: Awaited<ReturnType<ConnectionResolver['resolveForRequest']>>;
    try { target = await resolver.resolveForRequest(connection.id); }
    catch (error) { throw new ProviderCallError('CONNECTION_UNAVAILABLE', `${error instanceof Error ? error.message : String(error)} No request was sent.`, { notSent: true }); }
    const shouldStream = Boolean(req.onStream && req.stream !== 'off');
    const init: RequestInit = {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
        // OpenAgents owns captured source text and context compaction, so the gateway must not rewrite prompts.
        // Session and idempotency headers are never sent: they would enable context handoff or stored replays.
        'X-FreeLLM-Compress': 'off',
      },
      body: JSON.stringify({
        model: req.modelId,
        messages: [{ role: 'system', content: req.systemPrompt }, ...buildOpenAIMessages(req)],
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.2,
        stream: shouldStream,
        ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
        ...(req.tools?.length ? { tools: formatOpenAITools(req.tools), ...(req.parallel_tool_calls !== undefined ? { parallel_tool_calls: req.parallel_tool_calls } : {}) } : {}),
      }),
    };
    // A 502, 503 or 504 is the gateway reporting that its own upstream failed. The reply
    // never began, so nothing was generated, nothing was charged, and retrying repeats
    // nothing. Routines were dying permanently on one such blip. Quota (429) is still not
    // retried: the gateway has already exhausted its fallbacks and waiting will not help.
    const TRANSIENT = new Set([502, 503, 504]);
    let res!: Response;
    for (let attempt = 1; ; attempt++) {
      res = await this.fetchCompletion(req, `${target.baseUrl}/chat/completions`, init, attempt);
      if (res.ok || !TRANSIENT.has(res.status) || attempt >= GATEWAY_TRANSIENT_ATTEMPTS) break;
      // Release the failed response before asking again, and give the upstream pool a
      // moment to change; an immediate retry tends to land on the same broken provider.
      await res.body?.cancel().catch(() => undefined);
      req.signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, attempt * (this.options.retryBaseDelayMs ?? GATEWAY_TRANSIENT_BACKOFF_MS)));
      req.signal?.throwIfAborted();
    }
    const served = this.servedIdentity(res.headers, connection, req.modelId);
    if (!res.ok) {
      const body = await this.boundedText(res, 8192);
      const code = this.gatewayErrorCode(body);
      if (res.status === 429) {
        throw new RateLimitExceededError(`${target.label} is rate limited or out of quota for ${req.modelId}${code}. The gateway had already tried its own fallbacks, so OpenAgents did not retry.`,
          { status: 429, attempts: 1, limitSource: 'gateway', rawBody: body });
      }
      const hint = res.status === 401 || res.status === 403 ? 'The gateway rejected its key; replace it in Settings → Providers.'
        : res.status === 404 ? 'The gateway does not offer this model; refresh models and choose another.'
        : res.status === 503 ? 'The gateway has no usable provider for this model right now.'
        : res.status >= 300 && res.status < 400 ? 'Redirects are not followed with a gateway key; correct the base URL.'
        : 'Check the gateway logs.';
      throw new ProviderCallError('HTTP_ERROR', `${target.label} returned HTTP ${res.status} for ${req.modelId}${code}. ${hint} It was not retried.`, { status: res.status, served });
    }

    const isStreamResponse = res.headers.get('content-type')?.includes('text/event-stream');
    if (shouldStream && isStreamResponse) {
      const sse = parseSse(res.body!, req.signal);
      const chunks = translateChatCompletions(sse);
      const assembler = new BlockAssembler();
      for await (const chunk of chunks) {
        assembler.push(chunk);
        req.onStream?.(chunk);
      }
      if (assembler.finish.kind === 'error') {
        throw new ProviderCallError('HTTP_ERROR', `${target.label} returned a stream error for ${req.modelId}: ${assembler.finish.failure?.message ?? 'unknown'}`, { status: res.status, served });
      }
      if (served.routedVia === null && assembler.model) {
        served.routedVia = this.header(assembler.model.trim(), 300);
        served.matchesRequested = served.routedVia === null ? null : servedModelMatches(served.routedVia, req.modelId);
      }
      let content = assembler.text();
      const rawToolBlocks = assembler.blocks().filter((b): b is ToolCallBlock => b.type === 'tool-call');
      const toolCalls: ToolCall[] = rawToolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      if (!content.trim() && toolCalls.length > 0 && !req.tools?.length) {

        content = nativeToolCallAsAction(toolCalls[0], req.modelId) ?? content;
      }
      const usageKnown = knownUsage(assembler.usage?.inputTokens, assembler.usage?.outputTokens);
      const usage = usageKnown ? { inputTokens: assembler.usage!.inputTokens, outputTokens: assembler.usage!.outputTokens } : undefined;
      // Missing accounting is reported as unknown, not a reason to disable
      // progress streaming on all subsequent requests to this connection.
      const finishReason = assembler.finish.kind === 'max-tokens' ? 'length' : assembler.finish.kind === 'tool-calls' ? 'tool_calls' : assembler.finish.kind;
      if (connection.routingMode === 'pinned' && served.matchesRequested === false) {
        throw new ProviderCallError('IDENTITY_UNVERIFIED',
          `${target.label} answered with ${served.routedVia} instead of the chosen model ${req.modelId}, so that reply was not used. Switch this bot to Auto routing to accept the provider's substitute, or choose another model.`,
          { status: res.status, usage, finishReason, served });
      }
      return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
        attemptCount: 1, usageKnown, finishReason, served };
    }

    const data = await this.readCompletion(res);
    if (data.error) {
      const status = Number.isInteger(data.error.code) ? data.error.code : undefined;
      throw new ProviderCallError('HTTP_ERROR', `${target.label} returned a provider error${status ? ` (${status})` : ''} inside HTTP 200 for ${req.modelId}. It was not retried because generation may have started.`, { status, served });
    }
    const choice = data.choices?.[0];
    const usageKnown = knownUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    const usage = usageKnown ? { inputTokens: Number(data.usage.prompt_tokens), outputTokens: Number(data.usage.completion_tokens) } : undefined;
    // OpenRouter and most OpenAI-compatible providers name the served model in
    // the response body, not in a header. Reading only headers made every such
    // provider look silent about identity.
    if (served.routedVia === null && typeof data.model === 'string' && data.model.trim()) {
      served.routedVia = this.header(data.model.trim(), 300);
      served.matchesRequested = served.routedVia === null ? null : servedModelMatches(served.routedVia, req.modelId);
    }
    // Pinning refuses a DIFFERENT model. A provider that names no model at all is
    // recorded as unverified (matchesRequested stays null) rather than treated as
    // a substitution: discarding every such reply left chat unusable while
    // nothing indicated that the model had changed.
    if (connection.routingMode === 'pinned' && served.matchesRequested === false) {
      throw new ProviderCallError('IDENTITY_UNVERIFIED',
        `${target.label} answered with ${served.routedVia} instead of the chosen model ${req.modelId}, so that reply was not used. Switch this bot to Auto routing to accept the provider's substitute, or choose another model.`,
        { status: res.status, usage, finishReason: choice?.finish_reason, served });
    }
    const toolCalls = extractToolCalls(choice?.message);
    const content = typeof choice?.message?.content === 'string'
      ? choice.message.content
      : (!req.tools?.length ? completionText(choice?.message) : '');
    return { content, toolCalls, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      attemptCount: 1, usageKnown, finishReason: choice?.finish_reason, served };
  }

  private servedIdentity(headers: Headers, connection: NonNullable<LLMRequest['connection']>, requestedModel: string): ServedIdentity {
    const routedVia = this.header(headers.get('x-routed-via'), 300);
    const attempts = Number(headers.get('x-fallback-attempts'));
    return {
      connectionId: connection.id, routingMode: connection.routingMode, requestedModel, routedVia,
      // X-Routed-Via is `<platform>/<model>`, and the model part may itself contain slashes.
      matchesRequested: routedVia === null ? null : routedVia === requestedModel || routedVia.slice(routedVia.indexOf('/') + 1) === requestedModel,
      fallbackAttempts: headers.has('x-fallback-attempts') && Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : null,
      fallbackTrail: this.header(headers.get('x-fallback-trail'), 1000),
      requestId: this.header(headers.get('x-request-id'), 120),
      usageSource: 'gateway-reported',
    };
  }

  /** Bounded single-line header text with key-like tokens removed before anything is stored. */
  private header(value: string | null, max: number): string | null {
    if (value === null) return null;
    return value.replace(/\p{Cc}/gu, ' ')
      .replace(/\b(?:sk|gsk|csk|xai|key)[-_][A-Za-z0-9_-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,}/g, '[redacted]').slice(0, max);
  }

  private async boundedText(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); bytes += value.byteLength;
        if (bytes >= maxBytes) { await reader.cancel(); break; }
      }
    } catch { /* a truncated error body still describes an error */ }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
  }

  /** Only the gateway's short error type or code; its free-text message may echo upstream detail. */
  private gatewayErrorCode(body: string): string {
    try {
      const error = JSON.parse(body)?.error;
      const code = [error?.type, error?.code].find(v => typeof v === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(v));
      return code ? ` (${code})` : '';
    } catch { return ''; }
  }

  private async dispatch(req: LLMRequest): Promise<LLMResponse> {
    // A connection names its gateway explicitly; nothing is inferred from the model ID, which may contain slashes.
    if (req.connection) return this.callGateway(req, req.connection);
    if (this.isOpenCodeModel(req.modelId)) {
      return this.callOpenCode(req);
    }
    if (!req.modelId.includes('/') && req.modelId.startsWith('claude') && this.anthropicKey) return this.callAnthropic(req);
    if (!req.modelId.includes('/') && req.modelId.startsWith('gpt') && this.openaiKey) return this.callOpenAI(req);
    if (!req.modelId.includes('/') && req.modelId.startsWith('gemini') && this.geminiKey) return this.callGemini(req);
    if (this.isOpenRouterModel(req.modelId) || (!this.anthropicKey && !this.openaiKey && !this.geminiKey && this.openrouterKey)) {
      return this.callOpenRouter(req);
    } else if (req.modelId.startsWith('claude')) {
      return this.callAnthropic(req);
    } else if (req.modelId.startsWith('gpt')) {
      return this.callOpenAI(req);
    } else if (req.modelId.startsWith('gemini')) {
      return this.callGemini(req);
    }
    throw new Error(`Unsupported model provider for ${req.modelId}`);
  }

  /**
   * OpenRouter OpenAI-compatible API caller with exponential backoff for 429/503.
   * Tracks attemptCount without incrementing agent turn count.
   * Logs and discriminates account quota exhaustion vs upstream endpoint capacity.
   */
  /**
   * OpenRouter and OpenCode Zen/Go all speak the OpenAI chat-completions shape
   * (models.dev lists Zen as "@ai-sdk/openai-compatible"), so one caller serves
   * them. Only the base URL, credential, and wire model id differ - the 429
   * discrimination, backoff, and RateLimitExceededError semantics are identical
   * and must not be duplicated per provider.
   */
  private async callOpenAICompatible(
    req: LLMRequest,
    cfg: { baseUrl: string; apiKey: string; wireModel: string; label: string }
  ): Promise<LLMResponse> {
    const maxAttempts = 4;
    let attempt = 0;

    const shouldStream = Boolean(req.onStream && req.stream !== 'off');
    while (attempt < maxAttempts) {
      attempt++;
        const res = await this.fetchCompletion(req, `${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
            'HTTP-Referer': 'https://github.com/Akak0o0y/OpenAgents',
            'X-Title': 'Autonomous-OpenAgents-Harness',
          },
          body: JSON.stringify({
            model: cfg.wireModel,
            messages: [
              { role: 'system', content: req.systemPrompt },
              ...buildOpenAIMessages(req),
            ],
            max_tokens: req.maxTokens ?? 4096,
            temperature: req.temperature ?? 0.2,
            stream: shouldStream,
            ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
            ...(req.tools?.length ? { tools: formatOpenAITools(req.tools), ...(req.parallel_tool_calls !== undefined ? { parallel_tool_calls: req.parallel_tool_calls } : {}) } : {}),
          }),
        }, attempt);
        if (res.status === 429) {
          const errText = await res.text();
          let parsedError: any = null;
          try {
            parsedError = JSON.parse(errText);
          } catch {}

          const errMsg = parsedError?.error?.message ?? errText;
          const limitSource = parsedError?.error?.metadata?.limit_source ?? 'unknown';
          const remedyHint = parsedError?.error?.metadata?.remedy_hint;
          const providerName = parsedError?.error?.metadata?.provider_name ?? res.headers.get('x-provider-name');
          const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
          const rateLimitLimit = res.headers.get('x-ratelimit-limit');
          const rateLimitReset = res.headers.get('x-ratelimit-reset');

          const isDailyQuotaExhausted =
            limitSource === 'openrouter_free_tier_daily' ||
            errMsg.includes('free-models-per-day') ||
            (rateLimitRemaining === '0' && limitSource.includes('daily'));

          if (isDailyQuotaExhausted) {
            console.error(`\n    🚨 [${cfg.label} 429 DAILY QUOTA EXHAUSTED] ${errMsg}`);
            if (remedyHint) console.error(`       Remedy: ${remedyHint}`);
            if (rateLimitReset) console.error(`       Resets at: ${new Date(parseInt(rateLimitReset, 10)).toUTCString()}`);
            throw new RateLimitExceededError(
              `Daily free model quota exhausted (${rateLimitLimit ?? 50} requests/day): ${errMsg}`,
              {
                status: 429,
                attempts: attempt,
                limitSource,
                resetAt: rateLimitReset ?? undefined,
                rawBody: errText,
              }
            );
          }

          if (attempt >= maxAttempts) {
            throw new RateLimitExceededError(
              `${cfg.label} rate limit (429) exhausted after ${attempt} attempts for ${cfg.wireModel} (source: ${limitSource}, provider: ${providerName ?? 'edge'}): ${errMsg}`,
              {
                status: 429,
                attempts: attempt,
                limitSource,
                resetAt: rateLimitReset ?? undefined,
                rawBody: errText,
              }
            );
          }
          const backoffMs = Math.min(30000, (this.options.retryBaseDelayMs ?? 2000) * Math.pow(2, attempt - 1));
          req.onProviderEvent?.({phase:'retry',modelId:req.modelId,attempt,elapsedMs:0,status:429,delayMs:backoffMs});
          console.warn(`\n    ⚠️  [${cfg.label} 429] Rate limited on attempt ${attempt} (Source: ${limitSource}, Provider: ${providerName ?? 'edge'}, Msg: ${errMsg}). Backing off ${Math.round(backoffMs)}ms...`);
          await delay(backoffMs, undefined, { signal: req.signal });
          continue;
        }

        if (res.status === 503) {
          await res.body?.cancel();
          if (attempt >= maxAttempts) {
            throw new ProviderCallError('HTTP_ERROR', `${cfg.label} gateway error (${res.status}) after ${attempt} attempts`, {status:res.status});
          }
          const backoffMs = Math.min(20000, (this.options.retryBaseDelayMs ?? 1500) * Math.pow(2, attempt - 1));
          req.onProviderEvent?.({phase:'retry',modelId:req.modelId,attempt,elapsedMs:0,status:res.status,delayMs:backoffMs});
          console.warn(`\n    ⚠️  [${cfg.label} ${res.status}] Service unavailable. Retrying in ${Math.round(backoffMs)}ms...`);
          await delay(backoffMs, undefined, { signal: req.signal });
          continue;
        }

        if (!res.ok) {
          await res.body?.cancel();
          throw new ProviderCallError('HTTP_ERROR', `${cfg.label} API Error (${res.status}) for ${req.modelId}. Check provider credentials, model access and request settings.`, {status:res.status});
        }

        const isStreamResponse = res.headers.get('content-type')?.includes('text/event-stream');
        if (shouldStream && isStreamResponse) {
          const sse = parseSse(res.body!, req.signal);
          const chunks = translateChatCompletions(sse);
          const assembler = new BlockAssembler();
          for await (const chunk of chunks) {
            assembler.push(chunk);
            req.onStream?.(chunk);
          }
          if (assembler.finish.kind === 'error') {
            throw new ProviderCallError('HTTP_ERROR', `${cfg.label} returned a stream error for ${req.modelId}: ${assembler.finish.failure?.message ?? 'unknown'}`, { status: res.status });
          }
          let content = assembler.text();
          const rawToolBlocks = assembler.blocks().filter((b): b is ToolCallBlock => b.type === 'tool-call');
          const toolCalls: ToolCall[] = rawToolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
          if (!content.trim() && toolCalls.length > 0 && !req.tools?.length) {

            content = nativeToolCallAsAction(toolCalls[0], req.modelId) ?? content;
          }
          const usageKnown = knownUsage(assembler.usage?.inputTokens, assembler.usage?.outputTokens);
          const finishReason = assembler.finish.kind === 'max-tokens' ? 'length' : assembler.finish.kind === 'tool-calls' ? 'tool_calls' : assembler.finish.kind;
          return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            inputTokens: usageKnown ? assembler.usage!.inputTokens : 0,
            outputTokens: usageKnown ? assembler.usage!.outputTokens : 0,
            attemptCount: attempt,
            usageKnown,
            finishReason,
          };
        }

        const data = await this.readCompletion(res);
        if (data.error) {
          const status = Number.isInteger(data.error.code) ? data.error.code : undefined;
          throw new ProviderCallError('HTTP_ERROR', `${cfg.label} returned a provider error${status ? ` (${status})` : ''} inside HTTP 200 for ${req.modelId}. It was not retried because generation may have started.`, {status});
        }
        const choice = data.choices?.[0];
        const toolCalls = extractToolCalls(choice?.message);
        const content = typeof choice?.message?.content === 'string'
          ? choice.message.content
          : (!req.tools?.length ? completionText(choice?.message) : '');
        return {
          content,
          toolCalls,
          inputTokens: knownUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens) ? data.usage.prompt_tokens : 0,
          outputTokens: knownUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens) ? data.usage.completion_tokens : 0,
          attemptCount: attempt,
          usageKnown: knownUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
          finishReason: choice?.finish_reason,
        };
    }

    throw new Error(`${cfg.label} call failed after ${maxAttempts} attempts`);
  }

  private async callOpenRouter(req: LLMRequest): Promise<LLMResponse> {
    const baseUrl = this.options.endpoints?.openrouter ?? 'https://openrouter.ai/api/v1';
    if (!this.openrouterKey && !this.options.endpoints?.openrouter) {
      throw new Error('Missing OPENROUTER_API_KEY in environment or .env file');
    }
    return this.callOpenAICompatible(req, {
      baseUrl,
      apiKey: this.openrouterKey ?? 'test-key',
      wireModel: OPENROUTER_SLUG_MAP[req.modelId] ?? req.modelId,
      label: 'OPENROUTER',
    });
  }

  /**
   * OpenCode Zen / Go. Endpoints verified live (HTTP 200, real usage block).
   * The `opencode/` prefix is opencode's own addressing; the wire id is bare.
   */
  private async callOpenCode(req: LLMRequest): Promise<LLMResponse> {
    if (!this.opencodeKey) {
      throw new Error('Missing OPENCODE_API_KEY in environment or .env file');
    }
    const isGo = req.modelId.startsWith('opencode-go/');
    return this.callOpenAICompatible(req, {
      baseUrl: isGo ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1',
      apiKey: this.opencodeKey,
      wireModel: req.modelId.replace(/^opencode(-go)?\//, ''),
      label: isGo ? 'OPENCODE-GO' : 'OPENCODE-ZEN',
    });
  }

  private async callAnthropic(req: LLMRequest): Promise<LLMResponse> {
    const baseUrl = this.options.endpoints?.anthropic ?? 'https://api.anthropic.com/v1/messages';
    if (!this.anthropicKey && !this.options.endpoints?.anthropic) {
      throw new Error('Missing ANTHROPIC_API_KEY in environment or .env file');
    }

    const shouldStream = Boolean(req.onStream && req.stream !== 'off');
    const res = await this.fetchCompletion(req, baseUrl, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicKey ?? 'test-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.modelId,
        max_tokens: req.maxTokens ?? 4096,
        system: req.systemPrompt,
        messages: buildAnthropicMessages(req),
        temperature: req.temperature ?? 0.2,
        stream: shouldStream,
        ...(req.tools?.length ? { tools: formatAnthropicTools(req.tools) } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) throw new RateLimitExceededError('Anthropic quota exceeded', { status: 429, rawBody: errText });
      throw new Error(`Anthropic API Error (${res.status}): ${errText}`);
    }

    const isStreamResponse = res.headers.get('content-type')?.includes('text/event-stream');
    if (shouldStream && isStreamResponse) {
      const sse = parseSse(res.body!, req.signal);
      const chunks = translateAnthropicMessages(sse);
      const assembler = new BlockAssembler();
      for await (const chunk of chunks) {
        assembler.push(chunk);
        req.onStream?.(chunk);
      }
      if (assembler.finish.kind === 'error') {
        throw new ProviderCallError('HTTP_ERROR', `Anthropic returned a stream error: ${assembler.finish.failure?.message ?? 'unknown'}`);
      }
      const content = assembler.text();
      const rawToolBlocks = assembler.blocks().filter((b): b is ToolCallBlock => b.type === 'tool-call');
      const toolCalls: ToolCall[] = rawToolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      const usageKnown = knownUsage(assembler.usage?.inputTokens, assembler.usage?.outputTokens);
      const finishReason = assembler.finish.kind === 'max-tokens' ? 'length' : assembler.finish.kind === 'tool-calls' ? 'tool_calls' : assembler.finish.kind;
      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        inputTokens: usageKnown ? assembler.usage!.inputTokens : 0,
        outputTokens: usageKnown ? assembler.usage!.outputTokens : 0,
        attemptCount: 1,
        usageKnown,
        finishReason,
      };
    }

    const data = await this.readCompletion(res);
    const toolCalls = extractAnthropicToolCalls(data.content);
    const content = (data.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    return {
      content,
      toolCalls,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      attemptCount: 1,
      usageKnown: knownUsage(data.usage?.input_tokens, data.usage?.output_tokens),
      finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason,
    };
  }

  private async callOpenAI(req: LLMRequest): Promise<LLMResponse> {
    const baseUrl = this.options.endpoints?.openai ?? 'https://api.openai.com/v1/chat/completions';
    if (!this.openaiKey && !this.options.endpoints?.openai) {
      throw new Error('Missing OPENAI_API_KEY in environment or .env file');
    }

    const shouldStream = Boolean(req.onStream && req.stream !== 'off');
    const res = await this.fetchCompletion(req, baseUrl, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openaiKey ?? 'test-key'}`,
      },
      body: JSON.stringify({
        model: req.modelId,
        messages: [
          { role: 'system', content: req.systemPrompt },
          ...buildOpenAIMessages(req),
        ],
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.2,
        stream: shouldStream,
        ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
        ...(req.tools?.length ? { tools: formatOpenAITools(req.tools), ...(req.parallel_tool_calls !== undefined ? { parallel_tool_calls: req.parallel_tool_calls } : {}) } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) throw new RateLimitExceededError('OpenAI quota exceeded', { status: 429, rawBody: errText });
      throw new Error(`OpenAI API Error (${res.status}): ${errText}`);
    }

    const isStreamResponse = res.headers.get('content-type')?.includes('text/event-stream');
    if (shouldStream && isStreamResponse) {
      const sse = parseSse(res.body!, req.signal);
      const chunks = translateChatCompletions(sse);
      const assembler = new BlockAssembler();
      for await (const chunk of chunks) {
        assembler.push(chunk);
        req.onStream?.(chunk);
      }
      if (assembler.finish.kind === 'error') {
        throw new ProviderCallError('HTTP_ERROR', `OpenAI returned a stream error: ${assembler.finish.failure?.message ?? 'unknown'}`);
      }
      let content = assembler.text();
      const rawToolBlocks = assembler.blocks().filter((b): b is ToolCallBlock => b.type === 'tool-call');
      const toolCalls: ToolCall[] = rawToolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      if (!content.trim() && toolCalls.length > 0 && !req.tools?.length) {

        content = nativeToolCallAsAction(toolCalls[0], req.modelId) ?? content;
      }
      const usageKnown = knownUsage(assembler.usage?.inputTokens, assembler.usage?.outputTokens);
      const finishReason = assembler.finish.kind === 'max-tokens' ? 'length' : assembler.finish.kind === 'tool-calls' ? 'tool_calls' : assembler.finish.kind;
      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        inputTokens: usageKnown ? assembler.usage!.inputTokens : 0,
        outputTokens: usageKnown ? assembler.usage!.outputTokens : 0,
        attemptCount: 1,
        usageKnown,
        finishReason,
      };
    }

    const data = await this.readCompletion(res);
    const choice = data.choices?.[0];
    const toolCalls = extractToolCalls(choice?.message);
    const content = typeof choice?.message?.content === 'string'
      ? choice.message.content
      : (!req.tools?.length ? completionText(choice?.message) : '');
    return {
      content,
      toolCalls,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      attemptCount: 1,
      usageKnown: knownUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
      finishReason: choice?.finish_reason,
    };
  }

  private async callGemini(req: LLMRequest): Promise<LLMResponse> {
    if (!this.geminiKey) {
      throw new Error('Missing GEMINI_API_KEY in environment or .env file');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`;

    const res = await this.fetchCompletion(req, url, {
      method: 'POST',
      signal: req.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: flattenConversationForJson(buildConversation(req)).map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }, ...(message.images ?? []).map(image => ({inlineData:{mimeType:image.mime,data:image.data}}))] })),
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.2,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) throw new RateLimitExceededError('Gemini quota exceeded', { status: 429, rawBody: errText });
      throw new Error(`Gemini API Error (${res.status}): ${errText}`);
    }

    const data = await this.readCompletion(res);
    const content = (data.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
    return {
      content,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      attemptCount: 1,
      usageKnown: knownUsage(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount),
      finishReason: data.candidates?.[0]?.finishReason,
    };
  }
}

/**
 * Mock LLM client used for offline calibration, dry-runs, and deterministic trace simulations.
 */
export class MockLLMClient implements ILLMClient {
  private scriptSequence: Record<string, string[]>;
  private callCounters: Record<string, number> = {};

  constructor(scriptSequence?: Record<string, string[]>) {
    this.scriptSequence = scriptSequence ?? {};
  }

  setSequence(taskId: string, versions: string[]) {
    this.scriptSequence[taskId] = versions;
    this.callCounters[taskId] = 0;
  }

  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    const taskIdMatch = req.userPrompt.match(/Task ID: ([a-zA-Z0-9_-]+)/);
    const taskId = taskIdMatch ? taskIdMatch[1] : 'default';

    const versions = this.scriptSequence[taskId] ?? [];
    const index = this.callCounters[taskId] ?? 0;
    this.callCounters[taskId] = index + 1;

    const code = index < versions.length ? versions[index] : (versions[versions.length - 1] ?? '// mock fallback');

    return {
      content: `\`\`\`javascript\n${code}\n\`\`\``,
      inputTokens: 1200 + index * 100,
      outputTokens: 350,
      attemptCount: 1,
    };
  }
}
