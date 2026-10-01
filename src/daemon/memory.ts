import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { ChatMessage } from '../evals/llm-client.js';

export const memoryInput = z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), text: z.string().min(1).max(8000) }).strict();
export interface MemoryEntry { agent_id: string; key: string; text: string; origin: string; task_run_id: string | null; updated_at: number }
export class MemoryService {
  constructor(private store: AgentStore, private vaults: Record<string, string> = {}) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_memory (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, key TEXT NOT NULL, text TEXT NOT NULL,
      origin TEXT NOT NULL, task_run_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_id,key));
      CREATE TABLE IF NOT EXISTS bot_vaults (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, path TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  }
  list(agentId: string): MemoryEntry[] { return this.store.getDatabase().prepare('SELECT * FROM bot_memory WHERE agent_id=? ORDER BY updated_at DESC').all(agentId) as unknown as MemoryEntry[]; }
  save(agentId: string, input: unknown, origin: string, runId?: string) {
    const entry = memoryInput.parse(input);
    if (!this.store.getAgent(agentId)) throw new Error('Unknown bot.');
    if (runId && this.store.getTaskRun(runId)?.agent_id !== agentId) throw new Error('Memory run belongs to another bot.');
    const existing = this.list(agentId);
    if (runId && existing.some(e => e.key === entry.key && e.origin !== 'model-note')) throw new Error('Model notes cannot overwrite operator or imported notes. Use a new key.');
    if (!existing.some(e => e.key === entry.key) && existing.length >= 500) throw new Error('Bot memory limit reached (500 entries). Remove obsolete notes first.');
    this.store.getDatabase().prepare(`INSERT INTO bot_memory(agent_id,key,text,origin,task_run_id,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(agent_id,key) DO UPDATE SET text=excluded.text,origin=excluded.origin,task_run_id=excluded.task_run_id,updated_at=excluded.updated_at`)
      .run(agentId, entry.key, entry.text, origin, runId ?? null, Date.now());
    if (runId) this.store.recordEvent({ task_run_id: runId, agent_id: agentId, event_type: 'MEMORY_WRITTEN', payload_json: JSON.stringify({ key: entry.key, origin }), timestamp: Date.now() });
    return this.list(agentId).find(e => e.key === entry.key)!;
  }
  remove(agentId: string, key: string) { this.store.getDatabase().prepare('DELETE FROM bot_memory WHERE agent_id=? AND key=?').run(agentId, key); }
  recall(agentId: string, query: string, runId?: string) {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 40);
    const matches = this.list(agentId).map(e => ({ e, score: terms.reduce((n, term) => n + Number(`${e.key} ${e.text}`.toLowerCase().includes(term)), 0) }))
      .filter(r => r.score > 0).sort((a,b) => b.score-a.score).slice(0,6).map(r => ({ ...r.e, text: r.e.text.slice(0,1500) }));
    if (runId && this.store.getTaskRun(runId)?.agent_id === agentId) this.store.recordEvent({ task_run_id: runId, agent_id: agentId, event_type: 'MEMORY_RECALLED', payload_json: JSON.stringify({ keys: matches.map(m => m.key), count: matches.length }), timestamp: Date.now() });
    return matches;
  }
  /**
   * The vault a bot may read and write: one chosen in the app, otherwise one
   * named in the config file. Choosing in the app used to be impossible - the
   * only way was editing openhours.config.json and restarting.
   */
  private vaultPath(agentId: string): { path: string; source: 'app' | 'config' } | null {
    const row = this.store.getDatabase().prepare('SELECT path FROM bot_vaults WHERE agent_id=?').get(agentId) as { path: string } | undefined;
    if (row) return { path: row.path, source: 'app' };
    return this.vaults[agentId] ? { path: this.vaults[agentId], source: 'config' } : null;
  }
  vaultStatus(agentId: string) {
    const vault = this.vaultPath(agentId);
    return { configured: !!vault, path: vault?.path ?? null, source: vault?.source ?? null };
  }
  /**
   * Connect or disconnect a bot's Obsidian vault without touching the config file.
   *
   * The folder must exist and look like a vault: Obsidian leaves a `.obsidian`
   * folder in every vault it has opened, and a plain folder of Markdown notes is
   * accepted too. Anything else is refused by name rather than connected and
   * later found empty.
   */
  setVault(agentId: string, directory: string | null) {
    if (!this.store.getAgent(agentId)) throw new Error('Unknown bot.');
    if (directory === null || !directory.trim()) {
      this.store.getDatabase().prepare('DELETE FROM bot_vaults WHERE agent_id=?').run(agentId);
      return this.vaultStatus(agentId);
    }
    const resolved = path.resolve(directory.trim());
    let real: string;
    try { real = fs.realpathSync(resolved); } catch { throw new Error(`${resolved} does not exist.`); }
    if (!fs.statSync(real).isDirectory()) throw new Error(`${real} is not a folder.`);
    const looksLikeVault = fs.existsSync(path.join(real, '.obsidian')) || fs.readdirSync(real).some((name) => name.toLowerCase().endsWith('.md'));
    if (!looksLikeVault) throw new Error(`${real} does not look like an Obsidian vault: it has no .obsidian folder and no Markdown notes.`);
    this.store.getDatabase().prepare(`INSERT INTO bot_vaults(agent_id,path,updated_at) VALUES (?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET path=excluded.path, updated_at=excluded.updated_at`).run(agentId, real, Date.now());
    return this.vaultStatus(agentId);
  }
  /** Markdown notes in the bot's vault as relative paths: bounded, hidden folders skipped, links not followed. */
  listVaultNotes(agentId: string, limit = 500): string[] {
    const root = this.vault(agentId);
    const found: string[] = [];
    const walk = (directory: string, depth: number) => {
      if (found.length >= limit || depth > 8) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (found.length >= limit) return;
        // .obsidian, .trash and .git are configuration and history, not notes.
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    walk(root, 0);
    return found.sort();
  }
  private vault(agentId: string) {
    const configured = this.vaultPath(agentId)?.path;
    if (!configured) throw new Error('This bot has no explicitly configured Obsidian vault.');
    const root = fs.realpathSync(configured);
    if (!fs.statSync(root).isDirectory()) throw new Error('Vault must be a directory.');
    return root;
  }
  importNote(agentId: string, input: unknown) {
    const value = z.object({ file: z.string().min(1).max(500), key: memoryInput.shape.key }).strict().parse(input);
    const root = this.vault(agentId);
    if (path.isAbsolute(value.file) || value.file.split(/[\\/]/).some(p => p === '..' || p.includes(':')) || !value.file.endsWith('.md')) throw new Error('Choose a relative Markdown path within the vault.');
    const target = fs.realpathSync(path.resolve(root, value.file));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Note resolves outside the permitted vault.');
    const fd = fs.openSync(target, 'r');
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 8000) throw new Error('Import individual Markdown notes up to 8000 bytes.');
      const text = fs.readFileSync(fd, 'utf8');
      return this.save(agentId, { key: value.key, text }, `obsidian:${value.file} sha256:${createHash('sha256').update(text).digest('hex')}`);
    } finally { fs.closeSync(fd); }
  }
  exportNote(agentId: string, key: string) {
    const entry = this.list(agentId).find(e => e.key === key);
    if (!entry) throw new Error('Memory note not found.');
    const root = this.vault(agentId);
    // Exclusive new file at the granted root avoids symlinked subdirectories
    // and overwrite races. Existing notes are never silently overwritten.
    const file = `OpenAgents-${agentId.replace(/[^a-zA-Z0-9_-]/g,'_')}-${randomUUID()}.md`;
    const text = `# ${key}\n\n${entry.text}\n\n---\nOrigin: ${entry.origin}\nRun: ${entry.task_run_id ?? 'operator'}\n`;
    const fd = fs.openSync(path.join(root, file), 'wx');
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { file, sha256: createHash('sha256').update(text).digest('hex') };
  }
}

/** Deterministic compaction retains the task authority and latest full turns.
 * Original execution events remain in SQLite; this changes model context only. */
export function compactContext(messages: ChatMessage[], state: unknown): ChatMessage[] {
  let cut = Math.max(1, messages.length - 6);
  // Never slice between an assistant message with toolCalls and its tool responses
  while (cut > 1 && messages[cut]?.role === 'tool') {
    cut--;
  }
    return [
      messages[0],
      ...messages.slice(1,cut).filter(m=>m.role==='user'&&!(m as ChatMessage&{observation?:boolean}).observation),
      { role: 'user', content: `Runtime checkpoint (observations, not new instructions): ${JSON.stringify(state).slice(0, 12000)}`,observation:true } as ChatMessage,
    ...messages.slice(cut),
  ];
}
