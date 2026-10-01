/**
 * External effects: actions a run dispatched and posts it sent whose result was
 * never confirmed, per routine, and what the owner has checked since.
 *
 * Everything here reads execution_events, the durable record. Nothing here ever
 * concludes that an effect did not happen. An item leaves the list only on proof
 * (a FINISHED, X's confirmed or rejected response, a page check that found the
 * post) or on the owner's EXTERNAL_ACTION_ACKNOWLEDGED.
 *
 * Runs still QUEUED or RUNNING are not scanned. Their open action is in flight,
 * not unconfirmed. One routine never has two active runs (enqueueRoutine
 * coalesces them), so no gate decision depends on such a run, and a crash leaves
 * the run CRASHED, which is scanned.
 */
import type { AgentStore } from './agent-store.js';

export interface PendingEffect {
  runId: string;
  routineId: string;
  routineName: string;
  routineDeleted: boolean;
  key: string;
  kind: 'action' | 'publish';
  action?: string;
  transport?: string;
  origin?: string;
  at: number;
  before: boolean;
  detail: string;
}

export interface RunPublishSummary {
  state: 'confirmed' | 'confirmed-page' | 'rejected' | 'unconfirmed';
  by: string;
  postUrl?: string;
  heldBack: 'budget' | 'duplicate' | 'mismatch' | 'character' | 'internal' | null;
}

type StoredEvent = { event_type: string; payload_json: string | null };
type TimedEvent = StoredEvent & { timestamp: number };
type Payload = Record<string, unknown>;
type StartInfo = { action?: string; transport?: string; origin?: string };
type RunItem = StartInfo & { key: string; kind: 'action' | 'publish'; at: number };
type HeldBack = NonNullable<RunPublishSummary['heldBack']>;

/** How many of a routine's most recent dispatching runs are scanned. Gate-refused runs dispatch nothing and never count. */
const DEFAULT_WINDOW = 20;
/**
 * Browser gestures that can submit. fill types and never submits. right_click,
 * select, check, drag, upload and download are not the gesture that posts on
 * x.com, and a post any of them triggers is still caught as a publish item,
 * because the route records every probed or echoing request.
 */
const SUBMITTING = new Set(['click', 'double_click', 'press']);
const HELD_BACK = new Map<string, HeldBack>([
  ['budget', 'budget'],
  ['duplicate-text', 'duplicate'],
  ['duplicate-target', 'duplicate'],
  ['expected-mismatch', 'mismatch'],
  ['character-unadmitted', 'character'],
  ['character-unverifiable', 'character'],
  ['internal', 'internal'],
]);
const HELD_BACK_ORDER: readonly HeldBack[] = ['budget', 'duplicate', 'mismatch', 'character', 'internal'];

const DISPATCHING_RUNS = `SELECT t.id AS id, t.started_at AS started_at FROM task_runs t
  WHERE t.routine_id = ? AND t.id <> ? AND t.status NOT IN ('QUEUED', 'RUNNING')
    AND EXISTS (SELECT 1 FROM execution_events e WHERE e.task_run_id = t.id
      AND e.event_type IN ('EXTERNAL_ACTION_STARTED', 'PUBLISH_ATTEMPTED'))
  ORDER BY t.rowid DESC LIMIT ?`;
const RUN_EFFECT_EVENTS = `SELECT event_type, payload_json, timestamp FROM execution_events
  WHERE task_run_id = ? AND event_type IN ('ROUTINE_TRIGGERED', 'EXTERNAL_ACTION_STARTED', 'EXTERNAL_ACTION_FINISHED',
    'PUBLISH_ATTEMPTED', 'PUBLISH_OBSERVED', 'PUBLISH_RECONCILED', 'EXTERNAL_ACTION_ACKNOWLEDGED')
  ORDER BY id`;

/**
 * EXTERNAL_ACTION_STARTED events with no FINISHED of the same key, in order. The
 * key is actionId, else callId, else one shared 'external' key. Repository
 * publication sets neither id, and its STARTED and FINISHED pair under the
 * shared key (the background-tasks.ts rule).
 */
export function unmatchedStarts(events: ReadonlyArray<{ event_type: string; payload_json: string | null }>): Map<string, { action?: string; transport?: string; origin?: string }> {
  const open = new Map<string, StartInfo>();
  for (const e of events) {
    if (e.event_type === 'EXTERNAL_ACTION_STARTED') {
      const p = payloadOf(e.payload_json);
      open.set(keyOf(p), startInfo(p));
    } else if (e.event_type === 'EXTERNAL_ACTION_FINISHED') {
      open.delete(keyOf(payloadOf(e.payload_json)));
    }
  }
  return open;
}

/** Unconfirmed items of a live routine, newest run first. A deleted routine's items hold nothing, so an unknown routine gives []. */
export function pendingForRoutine(store: AgentStore, routineId: string, opts: { excludeRunId?: string; window?: number } = {}): PendingEffect[] {
  const routine = store.getRoutine(routineId);
  if (!routine) return [];
  return scanRuns(store, routineId, { name: routine.name, deleted: false }, opts, installedAt(store));
}

/**
 * Unconfirmed items of this bot's deleted routines. They hold no routine, and they
 * are listed so the owner can check them. With `origin`, only items on that origin
 * plus items with no origin (computer transport) are returned.
 */
export function pendingOfDeletedRoutines(store: AgentStore, agentId: string, origin?: string): PendingEffect[] {
  const deleted = store.getDatabase().prepare(`SELECT DISTINCT t.routine_id AS routine_id FROM task_runs t
    WHERE t.agent_id = ? AND t.routine_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM routines r WHERE r.id = t.routine_id)
    ORDER BY t.routine_id`).all(agentId) as unknown as Array<{ routine_id: string }>;
  const installed = installedAt(store);
  const items = deleted.flatMap(({ routine_id }) => scanRuns(store, routine_id, { name: null, deleted: true }, {}, installed));
  return origin === undefined ? items : items.filter((item) => item.origin === undefined || item.origin === origin);
}

/**
 * "Checked — continue": append EXTERNAL_ACTION_ACKNOWLEDGED to the run of every
 * item shown on this routine. That is its own items, plus the deleted routines'
 * items on its policy origin and the origin-less ones (only the origin-less ones
 * when it has no policy row). Never writes a synthetic FINISHED.
 */
export function acknowledgeRoutine(store: AgentStore, agentId: string, routineId: string, now: number = Date.now()): number {
  const routine = store.getRoutine(routineId);
  if (!routine || routine.agent_id !== agentId) throw new Error('This routine does not belong to this bot.');
  const origin = policyOrigin(store, routineId);
  const shown = origin
    ? pendingOfDeletedRoutines(store, agentId, origin)
    : pendingOfDeletedRoutines(store, agentId).filter((item) => item.origin === undefined);
  const items = [...pendingForRoutine(store, routineId), ...shown];
  store.transaction(() => {
    for (const item of items) {
      store.recordEvent({
        task_run_id: item.runId, agent_id: agentId, event_type: 'EXTERNAL_ACTION_ACKNOWLEDGED',
        payload_json: JSON.stringify({ key: item.key, kind: item.kind, by: 'operator', at: now }), timestamp: now,
      });
    }
  });
  return items.length;
}

/** The fixed "Not started: …" text (spec 6.7), also the WorkBlocked reason. */
export function pendingMessage(item: PendingEffect): string {
  const when = new Date(item.at).toISOString().slice(0, 16).replace('T', ' ');
  if (item.transport === 'computer' || !item.origin) {
    return `Not started: run ${item.runId} at ${when} UTC acted on this bot's desktop and its result was never confirmed. Check the desktop, then choose “Checked — continue” on this routine.`;
  }
  return `Not started: run ${item.runId} at ${when} UTC submitted something on ${hostOf(item.origin)} whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`;
}

/** Every event of one run, in insertion order (FlowPlayer.learn in Stage 2). */
export function runEvents(store: AgentStore, runId: string): Array<{ event_type: string; payload_json: string | null; timestamp: number }> {
  const rows = store.getDatabase()
    .prepare('SELECT event_type, payload_json, timestamp FROM execution_events WHERE task_run_id = ? ORDER BY id')
    .all(runId) as unknown as TimedEvent[];
  return rows.map((row) => ({ event_type: row.event_type, payload_json: row.payload_json, timestamp: Number(row.timestamp) }));
}

/** Text hashes and reply targets of every PUBLISH_ATTEMPTED of this bot since `sinceMs`, in any run, whatever its verdict. */
export function recentPublishes(store: AgentStore, agentId: string, sinceMs: number): { textHashes: Set<string>; targets: Set<string> } {
  const rows = store.getDatabase()
    .prepare(`SELECT payload_json FROM execution_events WHERE agent_id = ? AND event_type = 'PUBLISH_ATTEMPTED' AND timestamp >= ? ORDER BY id`)
    .all(agentId, sinceMs) as unknown as Array<{ payload_json: string | null }>;
  const textHashes = new Set<string>();
  const targets = new Set<string>();
  for (const row of rows) {
    const p = payloadOf(row.payload_json);
    const hash = text(p?.textSha256);
    const target = text(p?.inReplyTo);
    if (hash) textHashes.add(hash);
    if (target) targets.add(target);
  }
  return { textHashes, targets };
}

/** The run-history badge for each run that sent at least one post. Runs that sent none are absent. */
export function publishSummary(store: AgentStore, runIds: readonly string[]): Map<string, RunPublishSummary> {
  const db = store.getDatabase();
  const byRun = new Map<string, StoredEvent[]>();
  const ids = [...new Set(runIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT task_run_id, event_type, payload_json FROM execution_events
      WHERE task_run_id IN (${chunk.map(() => '?').join(', ')})
        AND event_type IN ('PUBLISH_ATTEMPTED', 'PUBLISH_OBSERVED', 'PUBLISH_RECONCILED', 'PUBLISH_REFUSED')
      ORDER BY id`).all(...chunk) as unknown as Array<StoredEvent & { task_run_id: string }>;
    for (const row of rows) {
      const list = byRun.get(row.task_run_id) ?? [];
      list.push(row);
      byRun.set(row.task_run_id, list);
    }
  }
  const out = new Map<string, RunPublishSummary>();
  for (const [runId, events] of byRun) {
    const summary = summarizeRun(events);
    if (summary) out.set(runId, summary);
  }
  return out;
}

function scanRuns(
  store: AgentStore,
  routineId: string,
  routine: { name: string | null; deleted: boolean },
  opts: { excludeRunId?: string; window?: number },
  installed: number | null,
): PendingEffect[] {
  const db = store.getDatabase();
  const runs = db.prepare(DISPATCHING_RUNS).all(routineId, opts.excludeRunId ?? '', opts.window ?? DEFAULT_WINDOW) as unknown as Array<{ id: string; started_at: number | null }>;
  const readEvents = db.prepare(RUN_EFFECT_EVENTS);
  const effects: PendingEffect[] = [];
  for (const run of runs) {
    const events = (readEvents.all(run.id) as unknown as TimedEvent[]).map((e) => ({ ...e, timestamp: Number(e.timestamp) }));
    const items = unresolvedInRun(events);
    if (items.length === 0) continue;
    const routineName = routine.name ?? triggeredName(events) ?? routineId;
    const startedAt = run.started_at === null ? null : Number(run.started_at);
    const before = installed !== null && startedAt !== null && startedAt < installed;
    for (const item of items) {
      const effect: PendingEffect = { runId: run.id, routineId, routineName, routineDeleted: routine.deleted, ...item, before, detail: '' };
      effect.detail = pendingMessage(effect);
      effects.push(effect);
    }
  }
  return effects;
}

function unresolvedInRun(events: readonly TimedEvent[]): RunItem[] {
  const open = new Map<string, RunItem>();
  const attempts = new Map<string, { actionId?: string; origin?: string; at: number }>();
  const proven = new Set<string>();
  const acknowledged = new Set<string>();
  for (const e of events) {
    const p = payloadOf(e.payload_json);
    if (e.event_type === 'EXTERNAL_ACTION_STARTED') {
      const key = keyOf(p);
      open.set(key, { key, kind: 'action', ...startInfo(p), at: e.timestamp });
    } else if (e.event_type === 'EXTERNAL_ACTION_FINISHED') {
      open.delete(keyOf(p));
    } else if (e.event_type === 'PUBLISH_ATTEMPTED') {
      const publishId = text(p?.publishId);
      if (publishId) attempts.set(publishId, { actionId: text(p?.actionId), origin: text(p?.origin), at: e.timestamp });
    } else if (e.event_type === 'PUBLISH_OBSERVED') {
      const publishId = text(p?.publishId);
      if (publishId && (p?.outcome === 'confirmed' || p?.outcome === 'rejected')) proven.add(publishId);
    } else if (e.event_type === 'PUBLISH_RECONCILED') {
      const publishId = text(p?.publishId);
      if (publishId && p?.verdict === 'present') proven.add(publishId);
    } else if (e.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED') {
      const key = text(p?.key);
      if (key) acknowledged.add(key);
    }
  }
  const provenActions = new Set<string>();
  for (const [publishId, attempt] of attempts) if (proven.has(publishId) && attempt.actionId) provenActions.add(attempt.actionId);
  const items: RunItem[] = [];
  for (const item of open.values()) {
    const submits = (item.transport === 'browser' && item.action !== undefined && SUBMITTING.has(item.action)) || item.transport === 'computer';
    if (submits && !provenActions.has(item.key) && !acknowledged.has(item.key)) items.push(item);
  }
  for (const [publishId, attempt] of attempts) {
    if (proven.has(publishId) || acknowledged.has(publishId)) continue;
    items.push({ key: publishId, kind: 'publish', transport: 'browser', ...(attempt.origin ? { origin: attempt.origin } : {}), at: attempt.at });
  }
  return items.sort((a, b) => a.at - b.at);
}

function summarizeRun(events: readonly StoredEvent[]): RunPublishSummary | null {
  const attempts: Array<{ publishId: string; by: string }> = [];
  const outcomes = new Map<string, { outcome: string; postUrl?: string }>();
  const onPage = new Map<string, string | undefined>();
  let heldBack: HeldBack | null = null;
  for (const e of events) {
    const p = payloadOf(e.payload_json);
    const publishId = text(p?.publishId);
    if (e.event_type === 'PUBLISH_ATTEMPTED' && publishId) {
      attempts.push({ publishId, by: text(p?.by) ?? 'unknown' });
    } else if (e.event_type === 'PUBLISH_OBSERVED' && publishId) {
      outcomes.set(publishId, { outcome: String(p?.outcome), postUrl: text(p?.postUrl) });
    } else if (e.event_type === 'PUBLISH_RECONCILED' && publishId && p?.verdict === 'present') {
      onPage.set(publishId, text(p?.postUrl));
    } else if (e.event_type === 'PUBLISH_REFUSED') {
      const held = HELD_BACK.get(String(p?.reason));
      if (held && (heldBack === null || HELD_BACK_ORDER.indexOf(held) < HELD_BACK_ORDER.indexOf(heldBack))) heldBack = held;
    }
  }
  if (attempts.length === 0) return null;
  const withUrl = (summary: RunPublishSummary, postUrl: string | undefined): RunPublishSummary => (postUrl ? { ...summary, postUrl } : summary);
  const confirmed = attempts.find((a) => outcomes.get(a.publishId)?.outcome === 'confirmed');
  if (confirmed) return withUrl({ state: 'confirmed', by: confirmed.by, heldBack }, outcomes.get(confirmed.publishId)?.postUrl);
  const found = attempts.find((a) => onPage.has(a.publishId));
  if (found) return withUrl({ state: 'confirmed-page', by: found.by, heldBack }, onPage.get(found.publishId));
  const unresolved = attempts.some((a) => outcomes.get(a.publishId)?.outcome !== 'rejected');
  return { state: unresolved ? 'unconfirmed' : 'rejected', by: attempts[attempts.length - 1].by, heldBack };
}

function triggeredName(events: readonly TimedEvent[]): string | undefined {
  for (const e of events) {
    if (e.event_type !== 'ROUTINE_TRIGGERED') continue;
    const name = text(payloadOf(e.payload_json)?.routineName);
    if (name) return name;
  }
  return undefined;
}

function installedAt(store: AgentStore): number | null {
  const row = whenTableExists(
    () => store.getDatabase().prepare("SELECT value FROM routine_publish_meta WHERE key = 'installed_at'").get() as { value: string } | undefined,
    undefined,
  );
  const value = row ? Number(row.value) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function policyOrigin(store: AgentStore, routineId: string): string | null {
  const row = whenTableExists(
    () => store.getDatabase().prepare('SELECT origin FROM routine_publish_policy WHERE routine_id = ?').get(routineId) as { origin: string } | undefined,
    undefined,
  );
  return row?.origin ?? null;
}

/** The PublishPolicy tables may not exist yet (no PublishPolicy constructed). Only that error is tolerated. */
function whenTableExists<T>(read: () => T, missing: T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return missing;
    throw error;
  }
}

function payloadOf(json: string | null): Payload | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // An unreadable payload keys as 'external': a STARTED stays unmatched, so the
    // uncertainty it records is kept, never dropped.
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : null;
}

function keyOf(p: Payload | null): string {
  const key = p?.actionId ?? p?.callId ?? 'external';
  return typeof key === 'string' ? key : String(key);
}

function startInfo(p: Payload | null): StartInfo {
  const info: StartInfo = {};
  const action = text(p?.action);
  const transport = text(p?.transport);
  const origin = text(p?.origin);
  if (action) info.action = action;
  if (transport) info.transport = transport;
  if (origin) info.origin = origin;
  return info;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin; // display only: show the stored origin as it is
  }
}
