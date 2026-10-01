import type { AgentStore } from './agent-store.js';
import type { ChatMessage } from '../evals/llm-client.js';

/**
 * Earlier results a scheduled routine run should build on rather than repeat: the replies of its
 * latest runs that completed. A failed, aborted or crashed run's report is not a result. Given back
 * as the bot's own earlier turn, an old "Desktop build failed" was repeated as a current blocker by
 * every later run, without the desktop being tried again.
 */
export function routineHistory(store: AgentStore, routineId: string): ChatMessage[] {
  const rows = store.getDatabase().prepare(`SELECT m.content FROM chat_messages m JOIN task_runs r ON r.id = m.task_run_id
    WHERE r.routine_id = ? AND r.status = 'COMPLETED' AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 3`).all(routineId) as Array<{ content: string }>;
  return rows.reverse().map((row) => ({ role: 'assistant' as const, content: row.content.slice(0, 4000) }));
}
