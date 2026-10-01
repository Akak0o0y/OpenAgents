/**
 * Off parity harness for the character layer (spec §6.1 and §17.1, Phase 1 Task 1).
 *
 * It drives every place that reads `agents.system_prompt` today through its real
 * entry point and records what would reach the provider:
 *
 * - WorkRuntime (work-runtime.ts): owner chat through ChatService, the
 *   initialMessages and tool-bearing-history first-message branches, a scheduled
 *   routine, a produced mission step, direct code work, a delegated child and a
 *   background task;
 * - the legacy chat path (chat.ts), with and without bot memory;
 * - AgentLoop (agent-loop.ts);
 * - OpenCodeExecutor (opencode-executor.ts): its run and its public prompt builder.
 *
 * Each seam runs with a missing, an empty and a supplied Description. Every case
 * uses its own in-memory database, a scripted model, fixed ids and timestamps, and
 * sandbox and process boundaries that cannot start Docker or OpenCode. Nothing
 * here opens a network connection or a real profile.
 *
 * The one value normalized is the runtime snapshot's `observedAt` (the only clock
 * read inside prompt assembly, work-runtime.ts:455), which spec §17.1 masks. No
 * other field is normalized: tools, guidance, character data and any other
 * timestamp or id-looking string compare byte for byte.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentStore } from '../../src/daemon/agent-store.js';
import { CostLedger } from '../../src/kernel/cost-ledger.js';
import type { DockerSandbox } from '../../src/kernel/docker-sandbox.js';
import type { ExecutionResult } from '../../src/kernel/types.js';
import { STANDING_BENCHMARKS } from '../../src/kernel/standing-tenant.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../../src/daemon/work-runtime.js';
import { ChatService, type ChatServiceOptions } from '../../src/daemon/chat.js';
import { AgentLoop } from '../../src/daemon/agent-loop.js';
import { OpenCodeExecutor, type OpenCodeTaskParams } from '../../src/daemon/opencode-executor.js';
import { ArtifactStore } from '../../src/daemon/artifacts.js';
import { MemoryService } from '../../src/daemon/memory.js';
import { MissionService } from '../../src/daemon/missions.js';
import { BackgroundTasks } from '../../src/daemon/background-tasks.js';
import { WorkQuestions } from '../../src/daemon/work-questions.js';
import { ApprovalGate, SteerBus } from '../../src/daemon/control-plane.js';
import { LiveChannel } from '../../src/daemon/live-stream.js';
import { RunCapacity } from '../../src/daemon/run-capacity.js';
import { WebResearch } from '../../src/daemon/web-research.js';
import { ProviderRouter } from '../../src/daemon/provider-router.js';
import { resetToolDowngrades } from '../../src/daemon/tool-mode.js';
import { saveWorkResult } from '../../src/daemon/work-results.js';
import { routineTaskDefinition } from '../../src/daemon/routine-task.js';
import { CONVERSATION_CONTRACT, DIRECT_WORK_CONTRACTS, ROUTINE_ASK_CONTRACT, ROUTINE_ASK_TASK, workTaskDefinition } from '../../src/daemon/work-contract.js';
import type { TaskDefinition } from '../../src/daemon/scheduler.js';
import type { BrowserTools } from '../../src/daemon/browser-tools.js';
import type { McpRegistry } from '../../src/daemon/mcp-registry.js';
import type { PublishPolicy } from '../../src/daemon/publish-policy.js';
import type { Attachments } from '../../src/daemon/attachments.js';
import type { ChatMessage, LLMRequest, LLMResponse } from '../../src/evals/llm-client.js';

// ---------------------------------------------------------------------------
// Locations and fixed inputs
// ---------------------------------------------------------------------------

/** The repository root. This module compiles to dist/tests/helpers/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Every character fixture lives here; the no-carriage-return guard walks all of it. */
export const CHARACTER_FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'character');
export const BASELINE_DIR = path.join(CHARACTER_FIXTURE_ROOT, 'baseline');
export const MANIFEST_FILE = 'manifest.json';
export const BASELINE_SCHEMA = 'openhours.character-off-baseline/1';
export const CASE_SCHEMA = 'openhours.character-off-case/1';

export const MODEL = 'claude-haiku-4-5';
export const AGENT_ID = 'alpha';
/** Every stored timestamp the harness controls: 2026-01-01T09:00:00.000Z. */
export const FIXED_TIME = Date.UTC(2026, 0, 1, 9, 0, 0);
const THREAD_ID = 'thread-baseline';

export type DescriptionVariant = 'missing' | 'empty' | 'supplied';
/** Missing is a NULL column, empty is '', supplied has a line break, quotes and a non-ASCII character. */
export const DESCRIPTIONS: Record<DescriptionVariant, string | null> = {
  missing: null,
  empty: '',
  supplied: 'Saved description fixture: you are Milo, a careful release assistant.\nKeep answers short and cite "checked" sources — never guess.',
};
const DESCRIPTION_ORDER: DescriptionVariant[] = ['missing', 'empty', 'supplied'];

export type BaselineSeam = 'work-runtime' | 'legacy-chat' | 'agent-loop' | 'opencode';

/** One recorded request, projected so that absent fields are explicit nulls. */
export type ProjectedRequest = Record<string, unknown>;

export interface BaselineCase {
  schema: typeof CASE_SCHEMA;
  id: string;
  seam: BaselineSeam;
  scenario: string;
  description: DescriptionVariant;
  /** Model calls for WorkRuntime, legacy chat and AgentLoop; agent-container sessions for OpenCode. */
  logicalCalls: number;
  /** Every provider request (or OpenCode session) in order, recorded when it was made. */
  requests: ProjectedRequest[];
  /** Payloads of every PROMPT_ASSEMBLED event of the case, in order. Empty means none was emitted. */
  promptAssembled: unknown[];
  /** Every event type recorded while the scenario ran (including its own seeded prior runs), in order. */
  eventTypes: string[];
  /** OpenCode only: the public buildPrompt() output. Null for every other seam. */
  opencode: { builderPrompt: string } | null;
}

export interface BaselineManifest {
  schema: typeof BASELINE_SCHEMA;
  /** Full HEAD commit the baseline was first captured from, with src/ and web/src/ clean. */
  baselineCommit: string;
  sourceHashAlgorithm: string;
  /** LF-normalized SHA-256 of every tracked file under src/ at the baseline commit. */
  sources: Record<string, string>;
  normalization: Array<{ id: string; seam: BaselineSeam; field: string; description: string }>;
  caseCount: number;
  cases: Array<{ id: string; file: string }>;
}

export interface CaptureContext {
  store: AgentStore;
  ledger: CostLedger;
  caseId: string;
  seam: BaselineSeam;
}

export interface CaptureHooks {
  /** Runs once per case, after the fixture bot exists and before the scenario or any seam starts; its events are not captured. */
  prepare?(context: CaptureContext): void;
  /** Extra constructor options spread into WorkRuntime, ChatService, AgentLoop and OpenCodeExecutor. */
  seamOptions?(context: CaptureContext): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Line endings and source hashes (Amendment A1)
// ---------------------------------------------------------------------------

/** SHA-256 of UTF-8 text after CRLF and lone CR become LF, so a CRLF checkout hashes like the repository. */
export function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

export const SOURCE_HASH_ALGORITHM = 'sha256 of UTF-8 text after CRLF and lone CR are normalized to LF';

/** Tracked files under src/, sorted, as repository-relative forward-slash paths. */
export function trackedSourceFiles(root = REPO_ROOT): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).sort();
}

export function sourceHashes(files: string[], root = REPO_ROOT): Record<string, string> {
  return Object.fromEntries(files.map(file => [file, lfSha256(fs.readFileSync(path.join(root, file), 'utf8'))]));
}

/** Files whose current LF-normalized hash differs from the manifest, including files that no longer exist. */
export function sourceHashMismatches(recorded: Record<string, string>, root = REPO_ROOT): string[] {
  return Object.entries(recorded).filter(([file, hash]) => {
    const full = path.join(root, file);
    return !fs.existsSync(full) || lfSha256(fs.readFileSync(full, 'utf8')) !== hash;
  }).map(([file]) => file);
}

// ---------------------------------------------------------------------------
// Volatility allowlist and normalization
// ---------------------------------------------------------------------------

const OBSERVED_AT = /"observedAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g;
const OBSERVED_AT_MASK = '"observedAt":"<masked:observedAt>"';

/** The complete list of normalized fields. Anything not listed here compares exactly. */
export const VOLATILE_FIELDS: BaselineManifest['normalization'] = [{
  id: 'work-runtime-observed-at',
  seam: 'work-runtime',
  field: 'requests[*].systemPrompt: the runtime snapshot\'s "observedAt" ISO-8601 value',
  description: 'new Date().toISOString() inside buildSystemPrompt (work-runtime.ts:455), masked by spec §17.1. Only the exact "observedAt":"YYYY-MM-DDTHH:MM:SS.sssZ" form is replaced.',
}];

export function normalizeCase(record: BaselineCase): BaselineCase {
  if (record.seam !== 'work-runtime') return record;
  return {
    ...record,
    requests: record.requests.map(request => typeof request.systemPrompt === 'string'
      ? { ...request, systemPrompt: request.systemPrompt.replace(OBSERVED_AT, OBSERVED_AT_MASK) }
      : request),
  };
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

export interface ParityDifference {
  caseId: string;
  aspect: string;
  path: string;
  detail: string;
}

function aspectOf(at: string): string {
  if (/^requests\[\d+\]\.systemPrompt/.test(at)) return 'system text (including embedded guidance)';
  if (/^requests\[\d+\]\.tools/.test(at)) return 'tool definitions';
  if (/^requests\[\d+\]\.messages\[0\]/.test(at)) return 'first message';
  if (/^requests\[\d+\]\.messages/.test(at)) return 'messages';
  if (/^requests\[\d+\]\.command/.test(at)) return 'OpenCode session command';
  if (/^requests/.test(at)) return 'request fields';
  if (/^logicalCalls/.test(at)) return 'logical call count';
  if (/^promptAssembled/.test(at)) return 'PROMPT_ASSEMBLED payload';
  if (/^eventTypes/.test(at)) return 'event types';
  if (/^opencode/.test(at)) return 'OpenCode prompt builder';
  return 'case metadata';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function stringDifference(expected: string, actual: string): string {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++;
  const from = Math.max(0, index - 40);
  return `first difference at character ${index} (lengths ${expected.length} and ${actual.length}): expected ${preview(expected.slice(from, index + 60))}, got ${preview(actual.slice(from, index + 60))}`;
}

function diffValues(expected: unknown, actual: unknown, at: string, out: Array<{ path: string; detail: string }>): void {
  if (Object.is(expected, actual)) return;
  if (typeof expected === 'string' && typeof actual === 'string') {
    out.push({ path: at, detail: stringDifference(expected, actual) });
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push({ path: at, detail: `length ${expected.length} became ${actual.length}` });
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diffValues(expected[i], actual[i], `${at}[${i}]`, out);
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const child = at ? `${at}.${key}` : key;
      if (!Object.hasOwn(expected, key)) out.push({ path: child, detail: `unexpected field ${preview(actual[key])}` });
      else if (!Object.hasOwn(actual, key)) out.push({ path: child, detail: 'missing field' });
      else diffValues(expected[key], actual[key], child, out);
    }
    return;
  }
  out.push({ path: at, detail: `expected ${preview(expected)}, got ${preview(actual)}` });
}

/** Differences after normalizing both sides with VOLATILE_FIELDS only. Empty means parity. */
export function compareBaseline(expected: BaselineCase[], actual: BaselineCase[]): ParityDifference[] {
  const out: ParityDifference[] = [];
  const actualById = new Map(actual.map(record => [record.id, record]));
  const expectedIds = new Set(expected.map(record => record.id));
  for (const record of expected) {
    const other = actualById.get(record.id);
    if (!other) { out.push({ caseId: record.id, aspect: 'case set', path: '', detail: 'baseline case was not captured' }); continue; }
    const found: Array<{ path: string; detail: string }> = [];
    diffValues(normalizeCase(record), normalizeCase(other), '', found);
    for (const item of found) out.push({ caseId: record.id, aspect: aspectOf(item.path), ...item });
  }
  for (const record of actual) {
    if (!expectedIds.has(record.id)) out.push({ caseId: record.id, aspect: 'case set', path: '', detail: 'captured case has no baseline' });
  }
  return out;
}

export function formatDifferences(differences: ParityDifference[], limit = 12): string {
  const lines = differences.slice(0, limit).map(d => `- ${d.caseId} [${d.aspect}] ${d.path || '(case)'}: ${d.detail}`);
  if (differences.length > limit) lines.push(`- ... and ${differences.length - limit} more`);
  return lines.join('\n');
}

export function assertParity(expected: BaselineCase[], actual: BaselineCase[]): void {
  const differences = compareBaseline(expected, actual);
  assert.equal(differences.length, 0, `Off parity broken in ${new Set(differences.map(d => d.caseId)).size} case(s):\n${formatDifferences(differences)}`);
}

// ---------------------------------------------------------------------------
// Fixture files
// ---------------------------------------------------------------------------

export class BaselineMissingError extends Error {
  constructor(dir: string) {
    super(`The Off parity baseline is missing at ${dir}. Capture it from unchanged source with: node dist/tests/helpers/capture-character-baseline.js --write tests/fixtures/character/baseline`);
    this.name = 'BaselineMissingError';
  }
}

export function caseFileName(id: string): string {
  return `${id}.json`;
}

export function readBaseline(dir = BASELINE_DIR): { manifest: BaselineManifest; cases: BaselineCase[] } {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) throw new BaselineMissingError(dir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BaselineManifest;
  assert.equal(manifest.schema, BASELINE_SCHEMA, 'baseline manifest schema');
  assert.equal(manifest.cases.length, manifest.caseCount, 'manifest case count matches its case list');
  const cases = manifest.cases.map(entry => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8')) as BaselineCase;
    assert.equal(record.schema, CASE_SCHEMA, `${entry.file} schema`);
    assert.equal(record.id, entry.id, `${entry.file} id`);
    return record;
  });
  return { manifest, cases };
}

/** Pretty JSON with LF line endings; every multiline value is an escaped JSON string. */
export function serializeFixture(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every string (keys included) decoded from every JSON file under root, with where it came from. */
export function decodedFixtureStrings(root = CHARACTER_FIXTURE_ROOT): { files: string[]; strings: Array<{ file: string; at: string; value: string }> } {
  const files: string[] = [];
  const strings: Array<{ file: string; at: string; value: string }> = [];
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else files.push(full);
    }
  };
  const walkValue = (file: string, value: unknown, at: string) => {
    if (typeof value === 'string') strings.push({ file, at, value });
    else if (Array.isArray(value)) value.forEach((item, i) => walkValue(file, item, `${at}[${i}]`));
    else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) {
      strings.push({ file, at: `${at}[key ${JSON.stringify(key)}]`, value: key });
      walkValue(file, item, `${at}.${key}`);
    }
  };
  if (fs.existsSync(root)) walkDir(root);
  for (const file of files) {
    assert.ok(file.endsWith('.json'), `character fixtures are JSON only (Amendment A1): ${path.relative(REPO_ROOT, file)}`);
    walkValue(path.relative(REPO_ROOT, file), JSON.parse(fs.readFileSync(file, 'utf8')), '$');
  }
  return { files: files.map(file => path.relative(REPO_ROOT, file)), strings };
}

// ---------------------------------------------------------------------------
// Recording boundaries
// ---------------------------------------------------------------------------

const LLM_REQUEST_FIELDS = ['connection', 'maxTokens', 'messages', 'modelId', 'onProviderEvent', 'onStream', 'parallel_tool_calls',
  'signal', 'stream', 'systemPrompt', 'temperature', 'tools', 'userPrompt'] as const;

function projectValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'function') return '[function]';
  if (value instanceof AbortSignal) return '[AbortSignal]';
  return JSON.parse(JSON.stringify(value));
}

/**
 * The request exactly as it was at call time. Known fields that were not supplied are explicit nulls;
 * a field the request did not have before (for example a new character property) appears as itself.
 */
export function projectRequest(request: LLMRequest): ProjectedRequest {
  const source = request as unknown as Record<string, unknown>;
  const out: ProjectedRequest = { kind: 'llm' };
  for (const key of [...new Set([...LLM_REQUEST_FIELDS, ...Object.keys(source)])].sort()) out[key] = projectValue(source[key]);
  return out;
}

/** A provider that answers from a script and records every request. An unscripted call fails that run. */
class ScriptedLlm {
  readonly requests: ProjectedRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async generateCode(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(projectRequest(request));
    const content = this.replies.shift();
    if (content === undefined) throw new Error('Unscripted model call in the Off parity harness.');
    return { content, inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  }
}

const forbidden = (what: string) => async (): Promise<never> => {
  throw new Error(`The Off parity harness never ${what}.`);
};

/** A sandbox that cannot create a container: for runs that must never ask for one. */
function forbiddenSandbox(): WorkRuntimeOptions['sandbox'] {
  const refuse = forbidden('starts a container for this run');
  return { createWorkspaceVolume: refuse, stageWorkspaceFiles: refuse, readWorkspaceFile: refuse, executeTask: refuse, destroyWorkspaceVolume: refuse };
}

/**
 * An in-memory stand-in for DockerSandbox. Volumes are fixed names, staging is a no-op, the test command
 * "passes", and the OpenCode agent container records its command instead of running anything.
 */
function fixtureSandbox(onAgentContainer?: (command: string, options: Record<string, unknown>) => void) {
  let volumes = 0;
  const passed = async (): Promise<ExecutionResult> => ({ exitCode: 0, stdout: 'fixture checks passed', stderr: '', durationMs: 1, timedOut: false });
  return {
    createWorkspaceVolume: async () => `fixture-volume-${++volumes}`,
    stageWorkspaceFiles: async () => {},
    readWorkspaceFile: forbidden('reads a workspace file'),
    executeTask: passed,
    destroyWorkspaceVolume: async () => {},
    runAgentContainer: async (_volume: string, command: string, options: Record<string, unknown>): Promise<ExecutionResult> => {
      onAgentContainer?.(command, options);
      return { exitCode: 0, stdout: `${JSON.stringify({ type: 'step_finish', sessionID: 'ses_fixture', part: { tokens: { input: 10, output: 5 } } })}\n`, stderr: '', durationMs: 1, timedOut: false };
    },
  };
}

function browserStub(): BrowserTools {
  const status = {
    enabled: true, computerEnabled: true, ready: true, installing: false, error: null,
    desktopSetup: { state: 'ready' }, desktop: { state: 'stopped', message: 'Bot desktops start on demand.' },
    isolation: 'sandbox', sandbox: null, active: 0, limit: 2, sessions: [], persistenceErrors: {},
    connections: [{ site: 'x.com', verified: false, updatedAt: FIXED_TIME }],
    autonomy: 'accounts',
    accounts: [{ id: 'account-fixture', site: 'x.com', label: 'Fixture account', updatedAt: FIXED_TIME }],
  };
  return {
    status: () => status,
    waitForOperator: async () => {},
    setRunPolicy: () => {},
    clearRunPolicy: () => {},
    endRun: async () => {},
    closeOutPublishes: async () => [],
    publishes: () => [],
    call: forbidden('drives the browser'),
    computerCall: forbidden('drives the desktop'),
    desktopCall: forbidden('drives the desktop'),
    getLatestScreenshot: forbidden('reads a screenshot'),
  } as unknown as BrowserTools;
}

function mcpStub(): McpRegistry {
  return {
    toolsForAgent: () => [{ server: 'fixture-mcp', name: 'lookup_release', description: 'Look up a release record by its id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    call: forbidden('calls an MCP tool'),
    endRun: () => {},
  } as unknown as McpRegistry;
}

const PROPOSAL_KINDS = ['routine-create', 'vault-connect', 'account-request', 'human-assist'];

// ---------------------------------------------------------------------------
// Per-case environment
// ---------------------------------------------------------------------------

type Profile = 'full' | 'minimal';

interface CaseEnv {
  store: AgentStore;
  ledger: CostLedger;
  artifacts: ArtifactStore;
  llm: ScriptedLlm;
  context: CaptureContext;
  extra: Record<string, unknown>;
  memory: MemoryService;
  missions: MissionService;
  background: BackgroundTasks;
  approvals: ApprovalGate;
}

function seedFixtureState(store: AgentStore, description: string | null): void {
  store.createAgent({ id: AGENT_ID, name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE', system_prompt: description });
  const db = store.getDatabase();
  db.prepare('UPDATE agents SET created_at=?, updated_at=? WHERE id=?').run(FIXED_TIME, FIXED_TIME, AGENT_ID);
  store.createThread({ id: THREAD_ID, agentId: AGENT_ID, title: 'Release check' });
  store.appendMessage({ thread_id: THREAD_ID, role: 'user', content: 'Earlier question fixture: what changed in the release?', created_at: FIXED_TIME });
  store.appendMessage({ thread_id: THREAD_ID, role: 'assistant', content: 'Earlier answer fixture: nothing was checked yet.', created_at: FIXED_TIME });
}

/** A bot-memory note with a fixed timestamp, written directly so recall output is reproducible. */
function seedMemoryNote(store: AgentStore): void {
  store.getDatabase().prepare('INSERT INTO bot_memory(agent_id,key,text,origin,task_run_id,updated_at) VALUES (?,?,?,?,?,?)')
    .run(AGENT_ID, 'release-note', 'Initial testing is finished.', 'operator', null, FIXED_TIME);
}

/** A finished or running run with fixed timestamps, so it can appear in the runtime snapshot's recentRuns. */
function seedRun(store: AgentStore, id: string, taskName: string, status: 'COMPLETED' | 'RUNNING', routineId?: string): void {
  store.createTaskRun({ id, agentId: AGENT_ID, taskName, modelId: MODEL, routineId });
  store.startTaskRun(id, MODEL);
  if (status === 'COMPLETED') store.finishTaskRun(id, 'COMPLETED');
  store.getDatabase().prepare('UPDATE task_runs SET started_at=?, completed_at=? WHERE id=?')
    .run(FIXED_TIME - 3_600_000, status === 'COMPLETED' ? FIXED_TIME - 3_500_000 : null, id);
}

function workRuntime(env: CaseEnv, profile: Profile, sandbox: WorkRuntimeOptions['sandbox']): WorkRuntime {
  const base: WorkRuntimeOptions = { store: env.store, ledger: env.ledger, llm: env.llm, sandbox, artifacts: env.artifacts };
  if (profile === 'minimal') return new WorkRuntime({ ...base, ...env.extra });
  const publishPolicy = { mustPublish: () => null, noteAttempt: () => {} } as unknown as PublishPolicy;
  return new WorkRuntime({
    ...base,
    memory: env.memory,
    providerRouter: new ProviderRouter(),
    contracts: DIRECT_WORK_CONTRACTS,
    missions: env.missions,
    questions: new WorkQuestions(env.store),
    attachments: { resolve: () => ({ text: '', images: [] }) } as unknown as Attachments,
    visionModels: [MODEL],
    web: new WebResearch({ enabled: true }),
    browser: browserStub(),
    repositories: { snapshot: forbidden('fetches a repository') },
    mcp: mcpStub(),
    approvals: env.approvals,
    live: new LiveChannel(() => {}),
    steer: new SteerBus(),
    capacity: new RunCapacity(4),
    background: env.background,
    publishPolicy,
    delegationAllowlist: {},
    ...env.extra,
  });
}

function chatService(env: CaseEnv, options: Omit<ChatServiceOptions, 'agentStore' | 'ledger' | 'llmClient'>): ChatService {
  return new ChatService({ agentStore: env.store, ledger: env.ledger, llmClient: env.llm, ...options, ...env.extra });
}

function startRun(env: CaseEnv, id: string, taskName: string, detail?: Record<string, unknown>, routineId?: string): string {
  env.store.createTaskRun({ id, agentId: AGENT_ID, taskName, modelId: MODEL, routineId });
  env.store.startTaskRun(id, MODEL, detail);
  return id;
}

/** The commit the scheduler passes (scheduler.ts:271-277), without posting to the conversation. */
function schedulerCommit(env: CaseEnv, runId: string, contractId: string, routineId: string | null) {
  return (result: Parameters<typeof saveWorkResult>[2]) => {
    saveWorkResult(env.store, runId, result);
    env.store.finishTaskRun(runId, result.outcome, result.outcome === 'COMPLETED' ? undefined : result.report,
      { executor: 'work', contractId, routineId, report: result.report, artifacts: result.artifacts.map(a => a.id) });
  };
}

const ANSWER = JSON.stringify({ tool: 'answer', text: 'Fixture answer.', citations: [] });
const BLOCK = JSON.stringify({ tool: 'block', reason: 'Fixture stop after the first request.' });
const MISSION_BLOCK = JSON.stringify({ tool: 'block', reason: 'Fixture stop after the first request.',
  blocker: { kind: 'missing_input', detail: 'The fixture supplies no release note.', resumeWhen: 'The operator supplies the release note.' } });
const CODE_REPLY = '```javascript:src/index.js\nexport function parseArgs() { return {}; }\n```';

const CHAT_REQUEST = 'Can you check the release note and tell me what changed?';
const BENCHMARK = STANDING_BENCHMARKS.find(task => task.id === 'cli-arg-parser')!;

interface ScenarioResult { opencode?: { builderPrompt: string }; requests?: ProjectedRequest[]; logicalCalls?: number }

interface Scenario {
  seam: BaselineSeam;
  scenario: string;
  replies: string[];
  toolMode?: 'json';
  run(env: CaseEnv): Promise<ScenarioResult | void>;
}

const signal = () => new AbortController().signal;

/** The matrix. Each scenario runs once per Description variant. */
export const SCENARIOS: readonly Scenario[] = [
  {
    seam: 'work-runtime', scenario: 'owner-chat.chat-service.full.native', replies: [ANSWER],
    async run(env) {
      const chat = chatService(env, { agenticChat: true, workRuntime: workRuntime(env, 'full', forbiddenSandbox()), memory: env.memory, approvalGate: env.approvals, steerBus: new SteerBus(), providerRouter: new ProviderRouter(), capacity: new RunCapacity(4) });
      try { await chat.send(THREAD_ID, CHAT_REQUEST, 'baseline-request'); } finally { await chat.stop(); }
    },
  },
  {
    seam: 'work-runtime', scenario: 'owner-chat.chat-service.minimal.native', replies: [ANSWER],
    async run(env) {
      const chat = chatService(env, { agenticChat: true, workRuntime: workRuntime(env, 'minimal', forbiddenSandbox()) });
      try { await chat.send(THREAD_ID, CHAT_REQUEST, 'baseline-request'); } finally { await chat.stop(); }
    },
  },
  {
    seam: 'work-runtime', scenario: 'owner-chat.chat-service.full.json', replies: [ANSWER], toolMode: 'json',
    async run(env) {
      const chat = chatService(env, { agenticChat: true, workRuntime: workRuntime(env, 'full', forbiddenSandbox()), memory: env.memory, approvalGate: env.approvals, steerBus: new SteerBus(), providerRouter: new ProviderRouter(), capacity: new RunCapacity(4) });
      try { await chat.send(THREAD_ID, CHAT_REQUEST, 'baseline-request'); } finally { await chat.stop(); }
    },
  },
  {
    // work-runtime.ts:524-525: supplied initial messages replace the generated first message.
    seam: 'work-runtime', scenario: 'owner-chat.initial-messages.full.native', replies: [ANSWER],
    async run(env) {
      const runId = startRun(env, 'run-baseline-chat', `chat:${THREAD_ID}`, { executor: 'work', threadId: THREAD_ID });
      const initialMessages: ChatMessage[] = [
        { role: 'user', content: 'Resumed task context fixture: check the release note.' },
        { role: 'assistant', content: 'Checked the first half of the release note.' },
        { role: 'user', content: 'Continue with the release note check.' },
      ];
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: runId, contract: CONVERSATION_CONTRACT, conversation: true, threadId: THREAD_ID,
        request: 'Continue with the release note check.', history: [{ role: 'user', content: 'Earlier question fixture: what changed in the release?' }], initialMessages, signal: signal() });
    },
  },
  {
    // work-runtime.ts:526-527: history that holds a tool message is used as the conversation itself.
    seam: 'work-runtime', scenario: 'owner-chat.tool-history.full.native', replies: [ANSWER],
    async run(env) {
      const runId = startRun(env, 'run-baseline-chat', `chat:${THREAD_ID}`, { executor: 'work', threadId: THREAD_ID });
      const history: ChatMessage[] = [
        { role: 'user', content: 'Look up the release note.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_fixture_1', name: 'recall', arguments: '{"query":"release"}' }] },
        { role: 'tool', content: '{"status":"ok","summary":"One note recalled."}', toolCallId: 'call_fixture_1' },
        { role: 'assistant', content: 'I found one note.' },
      ];
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: runId, contract: CONVERSATION_CONTRACT, conversation: true, threadId: THREAD_ID,
        request: 'What did the note say?', history, signal: signal() });
    },
  },
  {
    // A conversation routine as index.ts:813-817 registers it and scheduler.ts:268-277 dispatches it.
    seam: 'work-runtime', scenario: 'routine.scheduled.full.native', replies: [ANSWER],
    async run(env) {
      const routine = env.store.createRoutine({ id: 'rtn-baseline', agentId: AGENT_ID, name: 'Morning release check', cronExpression: '0 9 * * *',
        promptTemplate: 'Check the release note and report what changed.', taskName: ROUTINE_ASK_TASK, nextRunAt: FIXED_TIME + 86_400_000 });
      env.store.getDatabase().prepare('UPDATE routines SET created_at=?, updated_at=? WHERE id=?').run(FIXED_TIME, FIXED_TIME, routine.id);
      seedRun(env.store, 'run-baseline-routine-prior', ROUTINE_ASK_TASK, 'COMPLETED', routine.id);
      env.store.appendMessage({ thread_id: THREAD_ID, role: 'assistant', content: 'Earlier routine report fixture: no changes.', task_run_id: 'run-baseline-routine-prior', created_at: FIXED_TIME });
      const registered = workTaskDefinition(ROUTINE_ASK_CONTRACT, ROUTINE_ASK_CONTRACT.description);
      registered.work!.conversation = true;
      const definition = routineTaskDefinition(env.store.getRoutine(routine.id)!, registered);
      const work = definition.work!;
      const runId = startRun(env, 'run-baseline-routine', ROUTINE_ASK_TASK, { executor: 'work', contractId: work.contract.id, routineId: routine.id }, routine.id);
      // index.ts:781-786: the last three assistant reports of this routine.
      const history = (env.store.getDatabase().prepare(`SELECT m.content FROM chat_messages m JOIN task_runs r ON r.id = m.task_run_id
        WHERE r.routine_id = ? AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 3`).all(routine.id) as Array<{ content: string }>)
        .reverse().map(row => ({ role: 'assistant' as const, content: row.content.slice(0, 4000) }));
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: runId, contract: work.contract, request: work.request, sourceOrigin: work.sourceOrigin,
        mission: work.mission, objective: work.objective, signal: signal(), conversation: true, scheduled: { routineId: routine.id }, history,
        commit: schedulerCommit(env, runId, work.contract.id, routine.id) });
    },
  },
  {
    // A mission step produced by MissionService and dispatched as scheduler.ts:268 does.
    seam: 'work-runtime', scenario: 'mission.produced.full.native', replies: [MISSION_BLOCK],
    async run(env) {
      const mission = env.missions.create({ agentId: AGENT_ID, objective: 'Summarize the release note with checked quotes.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60_000 });
      await env.missions.start();
      assert.equal(await env.missions.produceNextTasks(env.store), 1, 'the mission produced one run');
      const runId = env.missions.list().find(m => m.id === mission.id)!.last_run_id!;
      const work = (env.store.getRunDefinition(runId) as TaskDefinition).work!;
      env.store.startTaskRun(runId, MODEL, { executor: 'work', contractId: work.contract.id, routineId: null });
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: runId, contract: work.contract, request: work.request, sourceOrigin: work.sourceOrigin,
        mission: work.mission, objective: work.objective, signal: signal(), commit: schedulerCommit(env, runId, work.contract.id, null) });
      await env.missions.stop();
    },
  },
  {
    // Direct code work from chat (chat.ts:189, 266-306): contract kind code, stubbed workspace.
    seam: 'work-runtime', scenario: 'code.direct-work.full.native', replies: [BLOCK],
    async run(env) {
      const chat = chatService(env, { agenticChat: true, workRuntime: workRuntime(env, 'full', fixtureSandbox()), memory: env.memory, approvalGate: env.approvals, steerBus: new SteerBus(), providerRouter: new ProviderRouter(), capacity: new RunCapacity(4) });
      try { await chat.send(THREAD_ID, 'Implement the argument parser.', 'baseline-code', 'cli-arg-parser'); } finally { await chat.stop(); }
    },
  },
  {
    // A self-delegated child exactly as the delegate action starts it (work-runtime.ts:1696-1754).
    seam: 'work-runtime', scenario: 'delegated.self.full.native', replies: [ANSWER],
    async run(env) {
      seedRun(env.store, 'run-baseline-parent', `chat:${THREAD_ID}`, 'RUNNING');
      const childId = startRun(env, 'run-baseline-child', 'subtask:Release check');
      env.store.setAgentData({ agentId: AGENT_ID, taskRunId: childId, category: 'delegation', key: childId,
        data: { parentRunId: 'run-baseline-parent', depth: 2, taskName: 'Release check', targetAgentId: AGENT_ID } });
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: childId, contract: { ...CONVERSATION_CONTRACT, maxTurns: 12 },
        request: 'Check the release note and report what changed.', conversation: true, delegationDepth: 2, sponsorAgentId: AGENT_ID, signal: signal(),
        commit: result => env.store.finishTaskRun(childId, result.outcome, result.report) });
    },
  },
  {
    // A background task queued by BackgroundTasks.start and dispatched as scheduler.ts:268-271 does.
    seam: 'work-runtime', scenario: 'background.started.full.native', replies: [ANSWER],
    async run(env) {
      seedRun(env.store, 'run-baseline-parent', `chat:${THREAD_ID}`, 'COMPLETED');
      const { runId } = env.background.start({ ownerId: AGENT_ID, parentRunId: 'run-baseline-parent', threadId: THREAD_ID, name: 'Release check',
        request: 'Check the release note and report what changed.' });
      const work = (env.store.getRunDefinition(runId) as TaskDefinition).work!;
      env.store.startTaskRun(runId, MODEL, { executor: 'work', contractId: work.contract.id, routineId: null });
      await workRuntime(env, 'full', forbiddenSandbox()).execute({ taskRunId: runId, contract: work.contract, request: work.request, sourceOrigin: work.sourceOrigin,
        mission: work.mission, objective: work.objective, signal: signal(), threadId: work.questionResume?.threadId, resumeFiles: work.questionResume?.files,
        background: work.background, sponsorAgentId: work.sponsorAgentId, delegationDepth: work.delegationDepth, conversation: true, history: undefined,
        commit: schedulerCommit(env, runId, work.contract.id, null) });
    },
  },
  {
    // chat.ts:309-378 with bot memory: the memory suffix stays in the system text.
    seam: 'legacy-chat', scenario: 'legacy-chat.memory', replies: ['Fixture answer.'],
    async run(env) {
      const chat = chatService(env, { memory: env.memory });
      try { await chat.send(THREAD_ID, CHAT_REQUEST, 'baseline-request'); } finally { await chat.stop(); }
    },
  },
  {
    seam: 'legacy-chat', scenario: 'legacy-chat.no-memory', replies: ['Fixture answer.'],
    async run(env) {
      const chat = chatService(env, {});
      try { await chat.send(THREAD_ID, CHAT_REQUEST, 'baseline-request'); } finally { await chat.stop(); }
    },
  },
  {
    // The builtin coding loop as scheduler.ts:299-310 dispatches a registered benchmark task.
    seam: 'agent-loop', scenario: 'agent-loop.builtin', replies: [CODE_REPLY],
    async run(env) {
      const taskRun = env.store.createTaskRun({ id: 'run-baseline-agent-loop', agentId: AGENT_ID, taskName: BENCHMARK.id, modelId: MODEL });
      const loop = new AgentLoop({ agentStore: env.store, ledger: env.ledger, providerRouter: new ProviderRouter(), llmClient: env.llm,
        sandbox: fixtureSandbox() as unknown as DockerSandbox, ...env.extra });
      const result = await loop.executeTask({ agent: env.store.getAgent(AGENT_ID)!, taskRun, initialFiles: BENCHMARK.initialFiles, testCommand: BENCHMARK.testCommand,
        abortSignal: signal(), maxTurns: BENCHMARK.maxTurns, timeoutMs: BENCHMARK.timeoutSeconds * 1000, requiresApproval: false });
      assert.equal(result.outcome, 'COMPLETED', `AgentLoop fixture run: ${result.errorMessage ?? ''}`);
    },
  },
  {
    // OpenCodeExecutor.executeTask with the agent container recorded, never started, plus its public buildPrompt().
    seam: 'opencode', scenario: 'opencode.executor', replies: [],
    async run(env) {
      const sessions: ProjectedRequest[] = [];
      const sandbox = fixtureSandbox((command, options) => sessions.push({
        kind: 'opencode-session', command,
        image: projectValue(options.image), network: projectValue(options.network), timeoutMs: projectValue(options.timeoutMs),
        secretNames: Object.keys((options.secrets ?? {}) as Record<string, string>).sort(), signal: projectValue(options.signal),
      }));
      const executor = new OpenCodeExecutor({ agentStore: env.store, ledger: env.ledger, sandbox: sandbox as unknown as DockerSandbox,
        apiKey: 'fixture-credential-not-a-key', ...env.extra });
      const taskRun = env.store.createTaskRun({ id: 'run-baseline-opencode', agentId: AGENT_ID, taskName: BENCHMARK.id, modelId: MODEL });
      const params: OpenCodeTaskParams = { agent: env.store.getAgent(AGENT_ID)!, taskRun, initialFiles: BENCHMARK.initialFiles, testCommand: BENCHMARK.testCommand,
        abortSignal: signal(), timeoutMs: BENCHMARK.timeoutSeconds * 1000 };
      const builderPrompt = executor.buildPrompt(params);
      const result = await executor.executeTask(params);
      assert.equal(result.outcome, 'COMPLETED', `OpenCode fixture run: ${result.errorMessage ?? ''}`);
      return { opencode: { builderPrompt }, requests: sessions, logicalCalls: sessions.length };
    },
  },
];

export const BASELINE_CASE_COUNT = SCENARIOS.length * DESCRIPTION_ORDER.length;

export function caseId(scenario: Pick<Scenario, 'seam' | 'scenario'>, description: DescriptionVariant): string {
  return `${scenario.seam}.${scenario.scenario}.${description}`;
}

function openCase(scenario: Scenario, description: DescriptionVariant, hooks: CaptureHooks): CaseEnv {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  const memory = new MemoryService(store);
  seedFixtureState(store, DESCRIPTIONS[description]);
  seedMemoryNote(store);
  const context: CaptureContext = { store, ledger, caseId: caseId(scenario, description), seam: scenario.seam };
  hooks.prepare?.(context);
  const approvals = new ApprovalGate(store);
  for (const kind of PROPOSAL_KINDS) approvals.onDecision(kind, () => {});
  return {
    store, ledger, memory, approvals, context,
    artifacts: new ArtifactStore(store),
    llm: new ScriptedLlm([...scenario.replies]),
    extra: hooks.seamOptions?.(context) ?? {},
    missions: new MissionService(store, DIRECT_WORK_CONTRACTS, 2, () => FIXED_TIME),
    background: new BackgroundTasks(store),
  };
}

function lastEventId(store: AgentStore): number {
  return Number((store.getDatabase().prepare('SELECT COALESCE(MAX(id), 0) AS n FROM execution_events').get() as { n: number }).n);
}

async function captureCase(scenario: Scenario, description: DescriptionVariant, hooks: CaptureHooks): Promise<BaselineCase> {
  resetToolDowngrades();
  if (scenario.toolMode) process.env.OPENHOURS_TOOL_MODE = scenario.toolMode;
  else delete process.env.OPENHOURS_TOOL_MODE;
  const env = openCase(scenario, description, hooks);
  try {
    const since = lastEventId(env.store);
    const outcome = (await scenario.run(env)) ?? {};
    const events = env.store.getDatabase().prepare('SELECT event_type, payload_json FROM execution_events WHERE id > ? ORDER BY id').all(since) as Array<{ event_type: string; payload_json: string }>;
    const requests = outcome.requests ?? env.llm.requests;
    return normalizeCase({
      schema: CASE_SCHEMA,
      id: env.context.caseId,
      seam: scenario.seam,
      scenario: scenario.scenario,
      description,
      logicalCalls: outcome.logicalCalls ?? env.llm.requests.length,
      requests,
      promptAssembled: events.filter(e => e.event_type === 'PROMPT_ASSEMBLED').map(e => JSON.parse(e.payload_json)),
      eventTypes: events.map(e => e.event_type),
      opencode: outcome.opencode ?? null,
    });
  } finally {
    env.ledger.close();
    env.store.close();
  }
}

/**
 * Capture every case of the matrix from the current implementation, normalized with VOLATILE_FIELDS.
 * The caller's OPENHOURS_TOOL_MODE is restored afterwards.
 */
export async function captureOffBaseline(hooks: CaptureHooks = {}): Promise<BaselineCase[]> {
  const toolMode = process.env.OPENHOURS_TOOL_MODE;
  const out: BaselineCase[] = [];
  try {
    for (const scenario of SCENARIOS) {
      for (const description of DESCRIPTION_ORDER) out.push(await captureCase(scenario, description, hooks));
    }
  } finally {
    if (toolMode === undefined) delete process.env.OPENHOURS_TOOL_MODE;
    else process.env.OPENHOURS_TOOL_MODE = toolMode;
    resetToolDowngrades();
  }
  return out;
}
