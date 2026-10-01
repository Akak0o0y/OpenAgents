import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import { VERIFIED_WORK_CATEGORY, workspacePath, type ArtifactStore } from './artifacts.js';
import { checkDeliverable, type EvidenceSource } from './deliverable-checks.js';
import { MISSION_RESUME_CATEGORY } from './internal-data.js';
import type { WorkContract } from './work-contract.js';

/**
 * Checked intermediate work: the exact files that last passed a run's contract checks. One sealed record per run,
 * replaced by each verification, stripped of content when invalidated and removed when a delivery is published.
 * It is never a completed delivery and never replays an external action.
 */
export const VERIFIED_WORK_VERSION = 2;
const MAX_FILE_BYTES = 256 * 1024, MAX_TOTAL_BYTES = 1024 * 1024, MAX_DELIVERABLES = 16, MAX_SOURCES = 12;

export interface ManifestEntry { path: string; bytes: number; sha256: string }
/** Where the checks were originally earned, kept separate from the adopting attempt's own revision. */
export interface VerificationProvenance { runId: string; agentId: string; revision: number; verifiedAt: string }

export interface VerifiedWork {
  version: typeof VERIFIED_WORK_VERSION;
  /** verified: finish-eligible checks; unverified: retained bytes that must pass checks again; invalidated: content dropped. */
  state: 'verified' | 'unverified' | 'invalidated';
  runId: string;
  agentId: string;
  contractId: string;
  contractSha256: string;
  kind: 'code' | 'report' | 'plan';
  revision: number;
  verifiedAt: string;
  summary?: string;
  manifest: ManifestEntry[];
  provenance?: VerificationProvenance;
  files?: Record<string, string>;
  note?: string;
  invalidatedBy?: string;
  invalidatedAt?: string;
  /** HMAC over every field except content and the seal, keyed by a runtime-only secret. */
  seal: string;
}

/** Metadata saved with a result; file contents stay in the retained record. */
export interface CheckedWorkSummary {
  available: boolean;
  runId: string;
  revision: number;
  contractId: string;
  contractSha256: string;
  verifiedAt: string;
  files: ManifestEntry[];
  provenance?: VerificationProvenance;
  reason?: string;
}

type Unsealed = Omit<VerifiedWork, 'version' | 'agentId' | 'manifest' | 'seal'>;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
export const contractSha256 = (contract: WorkContract): string => sha256(JSON.stringify(canonical(contract)));
export const manifestOf = (files: Record<string, string>): ManifestEntry[] =>
  Object.keys(files).sort().map(path => ({ path, bytes: Buffer.byteLength(files[path]), sha256: sha256(files[path]) }));

/** The same deliverable rule the write action enforces. */
export function isWritableDeliverable(contract: WorkContract, path: string): boolean {
  return contract.writableFiles ? contract.writableFiles.includes(path)
    : (path === 'README.md' || /^src\/.+\.(js|json)$/.test(path)) && !Object.hasOwn(contract.initialFiles, path);
}

/** The sealing key is created once per profile in a table no API reads or writes. */
function integrityKey(store: AgentStore): Buffer {
  const db = store.getDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS runtime_integrity (name TEXT PRIMARY KEY, secret TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO runtime_integrity(name, secret) VALUES (?, ?)').run('checked-work', randomBytes(32).toString('hex'));
  return Buffer.from((db.prepare('SELECT secret FROM runtime_integrity WHERE name = ?').get('checked-work') as { secret: string }).secret, 'hex');
}
function sealOf(store: AgentStore, record: Omit<VerifiedWork, 'seal'>): string {
  const { files: _content, ...covered } = record;
  return createHmac('sha256', integrityKey(store)).update(JSON.stringify(canonical(covered))).digest('hex');
}
function sealed(store: AgentStore, agentId: string, work: Unsealed, manifest = manifestOf(work.files ?? {})): VerifiedWork {
  const record: Omit<VerifiedWork, 'seal'> = { ...work, version: VERIFIED_WORK_VERSION, agentId, manifest };
  return { ...record, seal: sealOf(store, record) };
}
function sealMatches(store: AgentStore, record: VerifiedWork): boolean {
  if (typeof record.seal !== 'string' || !/^[a-f0-9]{64}$/.test(record.seal)) return false;
  const { seal, ...rest } = record;
  return timingSafeEqual(Buffer.from(seal, 'hex'), Buffer.from(sealOf(store, rest), 'hex'));
}

export function checkedWorkSummary(work: Pick<VerifiedWork, 'state' | 'runId' | 'revision' | 'contractId' | 'contractSha256' | 'verifiedAt' | 'manifest' | 'provenance' | 'files' | 'note' | 'invalidatedBy'>, unavailable?: string): CheckedWorkSummary {
  const reason = unavailable
    ?? (work.state === 'invalidated' ? `Invalidated by ${work.invalidatedBy ?? 'a later action'} after verification revision ${work.revision}.`
      : work.state === 'unverified' ? work.note ?? 'Retained as unverified material; it must pass the contract checks again.'
        : !work.files ? 'No checked files are retained.' : undefined);
  return { available: !reason, runId: work.runId, revision: work.revision, contractId: work.contractId, contractSha256: work.contractSha256, verifiedAt: work.verifiedAt,
    files: work.manifest ?? [], ...(work.provenance ? { provenance: work.provenance } : {}), ...(reason ? { reason } : {}) };
}

/** Raw stored record. Untrusted until reusableCheckedWork validates it. */
export function readVerifiedWork(store: AgentStore, runId: string): VerifiedWork | null {
  const run = store.getTaskRun(runId);
  const row = run && store.getAgentData(run.agent_id, runId, VERIFIED_WORK_CATEGORY);
  return row ? JSON.parse(row.data_json) as VerifiedWork : null;
}

/** Releases every recovery pin that protects this run's checked work. */
export function releaseCheckedWorkPins(store: AgentStore, runId: string): void {
  store.getDatabase().prepare('DELETE FROM agent_data WHERE category = ? AND task_run_id = ?').run(MISSION_RESUME_CATEGORY, runId);
}

export class VerifiedWorkStore {
  constructor(private readonly store: AgentStore, private readonly artifacts: ArtifactStore) {}

  /** Replaces the run's record within the installation storage cap. A record that cannot be retained is reported, never assumed. */
  save(work: Unsealed): CheckedWorkSummary {
    const run = this.store.getTaskRun(work.runId);
    if (!run) throw new Error('Checked work requires its task run.');
    const record = sealed(this.store, run.agent_id, work);
    return this.store.transaction(() => {
      const previous = this.store.getAgentData(run.agent_id, run.id, VERIFIED_WORK_CATEGORY);
      try { this.artifacts.assertCapacity(Buffer.byteLength(JSON.stringify(record)), previous ? Buffer.byteLength(previous.data_json) : 0); }
      catch (error) {
        this.remove(run.id);
        return checkedWorkSummary(record, `Checked work was not retained: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.write(record);
      return checkedWorkSummary(record);
    });
  }

  /** Persisted before a mutation is dispatched, so a crash cannot resurrect stale checks. Content is dropped; metadata remains. */
  invalidate(runId: string, cause: string): CheckedWorkSummary | undefined {
    const run = this.store.getTaskRun(runId), current = readVerifiedWork(this.store, runId);
    if (!run || !current) return undefined;
    if (current.state === 'invalidated') return checkedWorkSummary(current);
    const { version: _v, agentId: _a, manifest, seal: _s, files: _f, ...rest } = current;
    const record = sealed(this.store, run.agent_id, { ...rest, state: 'invalidated', invalidatedBy: cause, invalidatedAt: new Date().toISOString() }, Array.isArray(manifest) ? manifest : []);
    this.write(record);
    return checkedWorkSummary(record);
  }

  /**
   * Moves validated checked work to the attempt that resumes it and releases its recovery pin in one transaction.
   * If the storage cap cannot hold the replacement, the original record and pin stay untouched.
   */
  adopt(from: VerifiedWork, toRunId: string, next: Pick<VerifiedWork, 'state' | 'revision' | 'note'>): { adopted: true; summary: CheckedWorkSummary } | { adopted: false; reason: string } {
    const to = this.store.getTaskRun(toRunId);
    if (!to || to.agent_id !== from.agentId) return { adopted: false, reason: 'The resuming run belongs to another bot.' };
    const provenance = from.provenance ?? { runId: from.runId, agentId: from.agentId, revision: from.revision, verifiedAt: from.verifiedAt };
    const record = sealed(this.store, to.agent_id, { state: next.state, runId: to.id, contractId: from.contractId, contractSha256: from.contractSha256, kind: from.kind,
      revision: next.revision, verifiedAt: new Date().toISOString(), summary: from.summary, provenance, files: from.files, ...(next.note ? { note: next.note } : {}) });
    return this.store.transaction(() => {
      const source = this.store.getAgentData(from.agentId, from.runId, VERIFIED_WORK_CATEGORY);
      const existing = this.store.getAgentData(to.agent_id, to.id, VERIFIED_WORK_CATEGORY);
      try {
        this.artifacts.assertCapacity(Buffer.byteLength(JSON.stringify(record)), (source ? Buffer.byteLength(source.data_json) : 0) + (existing ? Buffer.byteLength(existing.data_json) : 0));
      } catch (error) {
        return { adopted: false as const, reason: `Checked work stays on run ${from.runId}: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.write(record);
      this.remove(from.runId);
      releaseCheckedWorkPins(this.store, from.runId);
      return { adopted: true as const, summary: checkedWorkSummary(record) };
    });
  }

  /** Keeps bytes as unverified material after a failed, refused or interrupted recheck. */
  markUnverified(runId: string, note: string): CheckedWorkSummary | undefined {
    const run = this.store.getTaskRun(runId), current = readVerifiedWork(this.store, runId);
    if (!run || !current || current.state === 'invalidated') return current ? checkedWorkSummary(current) : undefined;
    const { version: _v, agentId: _a, manifest: _m, seal: _s, ...rest } = current;
    const record = sealed(this.store, run.agent_id, { ...rest, state: 'unverified', note });
    this.write(record);
    return checkedWorkSummary(record);
  }

  remove(runId: string): void {
    const run = this.store.getTaskRun(runId);
    if (run) this.store.getDatabase().prepare('DELETE FROM agent_data WHERE agent_id = ? AND category = ? AND key = ?').run(run.agent_id, VERIFIED_WORK_CATEGORY, runId);
  }

  private write(record: VerifiedWork): void {
    const run = this.store.getTaskRun(record.runId)!;
    this.store.setAgentData({ agentId: run.agent_id, taskRunId: run.id, routineId: run.routine_id ?? null, category: VERIFIED_WORK_CATEGORY, key: run.id, data: record });
  }
}

function validSources(text: string): EvidenceSource[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_SOURCES) throw new Error('Captured sources are malformed or exceed the source cap.');
  const ids = new Set<string>();
  return parsed.map(value => {
    const source = value as EvidenceSource;
    if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 80 || ids.has(source.id) || typeof source.origin !== 'string'
      || typeof source.text !== 'string' || typeof source.capturedAt !== 'string' || source.sha256 !== sha256(source.text)) throw new Error('A captured source failed its integrity check.');
    ids.add(source.id);
    return source;
  });
}

/**
 * Prior checks carry over only when the sealed record belongs to this bot and run, the contract is unchanged, and every
 * byte, path and fixture matches the manifest. Plans and reports are also rechecked deterministically; resumed code must
 * pass its fixed checks again before finish (see WorkRuntime). Anything else stays unverified material.
 */
export function reusableCheckedWork(store: AgentStore, runId: string, agentId: string, contract: WorkContract): { work: VerifiedWork; sources?: EvidenceSource[] } | { reason: string } {
  const run = store.getTaskRun(runId);
  const record = run?.agent_id === agentId ? readVerifiedWork(store, runId) : null;
  if (!record) return { reason: 'No checked work is retained for that run.' };
  if (record.version !== VERIFIED_WORK_VERSION) return { reason: `The checked-work record uses an unsupported format (${String(record.version ?? 'legacy')}); it cannot be reused as verified.` };
  if (!sealMatches(store, record)) return { reason: 'The checked-work record failed its integrity seal; it cannot be reused as verified.' };
  if (record.runId !== runId || record.agentId !== agentId) return { reason: 'The checked-work record belongs to another run or bot.' };
  if (record.state !== 'verified' || !record.files) return { reason: checkedWorkSummary(record).reason ?? 'The checked work is no longer valid.' };
  if (record.contractId !== contract.id || record.contractSha256 !== contractSha256(contract)) return { reason: 'The contract changed after verification; the work must be verified again.' };
  const kind = contract.kind ?? 'code';
  if (record.kind !== kind) return { reason: 'The checked-work record is for a different contract kind.' };
  try {
    const files = record.files, paths = Object.keys(files).sort(), manifest = record.manifest;
    if (!Array.isArray(manifest) || manifest.length !== paths.length) throw new Error('manifest');
    let total = 0;
    manifest.forEach((entry, index) => {
      if (!entry || entry.path !== paths[index] || workspacePath(entry.path) !== entry.path || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES
        || Buffer.byteLength(files[entry.path]) !== entry.bytes || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(files[entry.path]) !== entry.sha256) throw new Error('manifest');
      total += entry.bytes;
    });
    if (total > MAX_TOTAL_BYTES) throw new Error('manifest');
    if (kind === 'code') {
      for (const [path, content] of Object.entries(contract.initialFiles)) if (files[path] !== content) throw new Error('fixture');
      const deliverables = paths.filter(path => !Object.hasOwn(contract.initialFiles, path));
      if (deliverables.length > MAX_DELIVERABLES || deliverables.some(path => !isWritableDeliverable(contract, path))) throw new Error('paths');
      return { work: record };
    }
    const expected = kind === 'plan' ? ['plan.json', 'plan.md'] : ['report.json', 'report.md', 'sources.json'];
    if (paths.join('\n') !== expected.join('\n')) throw new Error('paths');
    const sources = kind === 'report' ? validSources(files['sources.json']) : [];
    const again = checkDeliverable(kind, files[`${kind}.json`], sources);
    if (paths.some(path => again[path] !== files[path])) throw new Error('recheck');
    return kind === 'report' ? { work: record, sources } : { work: record };
  } catch {
    return { reason: 'The retained files do not match their verified manifest, fixtures or contract checks; the work must be verified again.' };
  }
}
