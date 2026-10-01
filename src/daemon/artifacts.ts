import { createHash, randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';

export interface Artifact {
  id: string;
  taskRunId: string;
  agentId: string;
  path: string;
  bytes: number;
  sha256: string;
  downloadUrl: string;
}

export function workspacePath(value: string): string {
  const normalized = value.replace(/^\.\//, '');
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(normalized) || normalized.split('/').some(p => p === '.' || p === '..')) {
    throw new Error('Use a relative workspace file path without traversal or special characters.');
  }
  return normalized;
}

/** Retained checked intermediate work (agent_data category) shares the installation storage cap with published files. */
export const VERIFIED_WORK_CATEGORY = 'verified-work';
export const MAX_BROWSER_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** Bounded text deliverables stored independently of Docker's volume lifecycle. */
export class ArtifactStore {
  constructor(private readonly store: AgentStore, private readonly maxStoredBytes = 256 * 1024 * 1024) {}

  save(taskRunId: string, files: Record<string, string>): Artifact[] {
    const run = this.store.getTaskRun(taskRunId);
    if (!run) throw new Error('Artifact run does not exist.');
    const rows = Object.entries(files).map(([file, content]) => {
      const path = workspacePath(file);
      const bytes = Buffer.byteLength(content);
      if (bytes > 256 * 1024) throw new Error(`Artifact ${path} exceeds 256 KiB.`);
      return { id: randomUUID(), path, content, bytes, sha256: createHash('sha256').update(content).digest('hex') };
    });
    if (!rows.length || rows.length > 32 || rows.reduce((n, row) => n + row.bytes, 0) > 1024 * 1024) throw new Error('Deliverables must contain 1–32 text files totaling at most 1 MiB.');
    // Joins a caller's finalization transaction, so files are never published apart from their result and status.
    return this.store.transaction(() => {
      this.assertCapacity(rows.reduce((n, row) => n + row.bytes, 0));
      const insert = this.store.getDatabase().prepare('INSERT INTO run_artifacts(id, task_run_id, agent_id, path, content, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(row.id, run.id, run.agent_id, row.path, row.content, row.bytes, row.sha256, Date.now());
      return this.list(taskRunId);
    });
  }

  /** Binary deliverables commit in the same caller transaction as text, result and terminal status. */
  saveBinary(taskRunId: string, files: Record<string, Buffer>): Artifact[] {
    const run = this.store.getTaskRun(taskRunId);
    if (!run) throw new Error('Artifact run does not exist.');
    const rows = Object.entries(files).map(([file, bytes]) => ({ path: workspacePath(file), bytes }));
    if (rows.length > 8 || rows.some(row => row.bytes.length > 4 * 1024 * 1024) || rows.reduce((n,row)=>n+row.bytes.length,0)>8*1024*1024) throw new Error('Binary deliverables exceed the 8-file / 8 MiB limit.');
    return this.store.transaction(() => {
      this.assertCapacity(rows.reduce((n,row)=>n+row.bytes.length,0));
      const insert=this.store.getDatabase().prepare("INSERT INTO run_artifacts(id,task_run_id,agent_id,path,content,bytes,sha256,created_at,encoding,purpose) VALUES (?,?,?,?,?,?,?,?, 'base64','deliverable')");
      for (const row of rows) insert.run(randomUUID(),run.id,run.agent_id,row.path,row.bytes.toString('base64'),row.bytes.length,createHash('sha256').update(row.bytes).digest('hex'),Date.now());
      return this.list(taskRunId);
    });
  }

  /** Bytes counted against the installation cap: published files plus retained checked work. */
  storedBytes(): number {
    const db = this.store.getDatabase();
    const files = Number((db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM run_artifacts').get() as { n: number }).n);
    const checked = Number((db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(data_json AS BLOB))),0) AS n FROM agent_data WHERE category = ?').get(VERIFIED_WORK_CATEGORY) as { n: number }).n);
    return files + checked;
  }

  assertCapacity(adding: number, releasing = 0): void {
    if (this.storedBytes() - releasing + adding > this.maxStoredBytes) throw new Error('Installation artifact storage limit reached. Preview storage cleanup before removing old files.');
  }

  /** Operator edits are durable, bounded, and conditional on the version opened. */
  edit(taskRunId: string, file: string, content: string, expectedContent: string): void {
    const safePath = workspacePath(file);
    const run = this.store.getTaskRun(taskRunId);
    if (!run) throw new Error('This task no longer exists.');
    if (run.status === 'RUNNING' || run.status === 'QUEUED') throw new Error('Wait for the task to finish before editing its files.');
    const bytes = Buffer.byteLength(content);
    if (bytes > 256 * 1024 || content.includes('\0')) throw new Error('Only text files up to 256 KiB can be saved.');
    this.store.transaction(() => {
      const db = this.store.getDatabase();
      const row = db.prepare('SELECT content, bytes, encoding, purpose FROM run_artifacts WHERE task_run_id=? AND path=?').get(taskRunId, safePath) as { content: string; bytes: number; encoding: string; purpose: string } | undefined;
      if (!row) throw new Error('This file has not been retained. Download a copy before editing.');
      if (row.encoding === 'base64' || row.purpose !== 'deliverable') throw new Error('Binary files and captured evidence cannot be edited as text.');
      if (row.content !== expectedContent) throw new Error('This file changed since you opened it. Copy your edits, then reload the file.');
      this.assertCapacity(bytes, row.bytes);
      db.prepare('UPDATE run_artifacts SET content=?, bytes=?, sha256=? WHERE task_run_id=? AND path=?')
        .run(content, bytes, createHash('sha256').update(content).digest('hex'), taskRunId, safePath);
    });
  }

  /** Captured browser evidence is retained even on failed runs; it never counts as a verified delivery. */
  saveEvidence(taskRunId: string, file: string, bytes: Buffer): Artifact {
    return this.saveBrowserBytes(taskRunId, file, bytes, false);
  }

  /** Downloads remain unverified evidence, with a separate bounded file-transfer budget. */
  saveDownload(taskRunId: string, file: string, bytes: Buffer): Artifact {
    return this.saveBrowserBytes(taskRunId, `browser/downloads/${workspacePath(file)}`, bytes, true);
  }

  private saveBrowserBytes(taskRunId: string, file: string, bytes: Buffer, download: boolean): Artifact {
    const run = this.store.getTaskRun(taskRunId);
    if (!run) throw new Error('Evidence run does not exist.');
    const safePath = workspacePath(file);
    if (bytes.length > (download ? MAX_BROWSER_DOWNLOAD_BYTES : 1024 * 1024)) throw new Error(download ? 'Download exceeds 8 MiB.' : 'Browser evidence exceeds 1 MiB.');
    const db = this.store.getDatabase();
    return this.store.transaction(() => {
      const used = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS size FROM run_artifacts WHERE task_run_id=? AND purpose='evidence' AND (path LIKE 'browser/downloads/%') = ?").get(taskRunId, Number(download)) as { n: number; size: number };
      if (used.n >= 12 || used.size + bytes.length > (download ? 32 : 4) * 1024 * 1024) throw new Error('Run browser evidence limit reached.');
      this.assertCapacity(bytes.length);
      const id = randomUUID();
      db.prepare("INSERT INTO run_artifacts(id,task_run_id,agent_id,path,content,bytes,sha256,created_at,encoding,purpose) VALUES (?,?,?,?,?,?,?,?, 'base64','evidence')")
        .run(id, run.id, run.agent_id, safePath, bytes.toString('base64'), bytes.length, createHash('sha256').update(bytes).digest('hex'), Date.now());
      return this.list(taskRunId, true).find(a => a.id === id)!;
    });
  }

  list(taskRunId: string, includeEvidence = false): Artifact[] {
    const rows = this.store.getDatabase().prepare("SELECT id, task_run_id, agent_id, path, bytes, sha256 FROM run_artifacts WHERE task_run_id = ? AND (? OR purpose='deliverable') ORDER BY path").all(taskRunId, Number(includeEvidence)) as any[];
    return rows.map(row => ({ id: row.id, taskRunId: row.task_run_id, agentId: row.agent_id, path: row.path, bytes: Number(row.bytes), sha256: row.sha256,
      downloadUrl: `/api/runs/${encodeURIComponent(taskRunId)}/artifacts/${row.id}` }));
  }

  read(taskRunId: string, id: string): { path: string; content: string; sha256: string; encoding?: string } | null {
    const row = this.store.getDatabase().prepare('SELECT path, content, sha256, encoding FROM run_artifacts WHERE task_run_id = ? AND id = ?').get(taskRunId, id) as any;
    return row ? { path: row.path, content: row.content, sha256: row.sha256, ...(row.encoding === 'base64' ? { encoding: 'base64' } : {}) } : null;
  }
}
