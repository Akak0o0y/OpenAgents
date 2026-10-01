/**
 * Cross-content search.
 *
 * The workspace search dialog is a command surface over EVERYTHING the daemon
 * durably knows: bots, conversation messages, routines, and the files a run
 * produced. It is implemented here, against SQLite, rather than in the browser
 * over whatever the client happens to have fetched - a client-side filter would
 * silently miss every message not currently in memory and would report "no
 * results" for data that exists.
 *
 * Two boundaries are deliberate:
 *
 *  - GROUPS are not searchable because this daemon has no group conversations.
 *    The category answers with an explicit `unsupported` marker so the UI can
 *    say so instead of rendering an empty list that looks like "nothing found".
 *  - LINKS are extracted from message text rather than stored, so the category
 *    is honest about being derived: it can only find links inside messages the
 *    daemon persisted.
 */

import type { DatabaseSync } from 'node:sqlite';

export type SearchKind = 'bot' | 'message' | 'routine' | 'file' | 'link' | 'group' | 'action';

export interface SearchResult {
  kind: SearchKind;
  /** Stable identity for the row within its kind. */
  id: string;
  title: string;
  /** Optional second line. Absent rather than empty when there is nothing to say. */
  subtitle?: string;
  /** The agent this result belongs to, when it belongs to one. */
  agentId?: string;
  /** Conversation this result lives in, for message results. */
  threadId?: string;
  /** Epoch ms, when the row has a meaningful time. */
  timestamp?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** Kinds this daemon genuinely cannot search, with the reason. */
  unsupported: Array<{ kind: SearchKind; reason: string }>;
  truncated: boolean;
}

export const SEARCH_KINDS: SearchKind[] = [
  'bot',
  'message',
  'routine',
  'file',
  'link',
  'group',
  'action',
];

export const MAX_SEARCH_LIMIT = 100;

/** SQLite LIKE wildcards in operator input must match literally, not as globs. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

/**
 * Search the daemon's durable content.
 *
 * `kinds` restricts the search; an empty or omitted list searches everything
 * this daemon can search. The limit is per kind so one noisy category cannot
 * crowd out the others.
 */
export function searchContent(
  db: DatabaseSync,
  options: { query: string; kinds?: SearchKind[]; limit?: number } = { query: '' }
): SearchResponse {
  const query = (options.query ?? '').trim();
  const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_SEARCH_LIMIT));
  const wanted = new Set<SearchKind>(
    options.kinds && options.kinds.length > 0 ? options.kinds : SEARCH_KINDS
  );

  const results: SearchResult[] = [];
  const unsupported: SearchResponse['unsupported'] = [];
  let truncated = false;

  const pattern = likePattern(query);
  // An empty query is a legitimate state: the dialog opens with recent content
  // before anything is typed. It lists rather than filters.
  const filtering = query.length > 0;

  if (wanted.has('bot')) {
    const rows = filtering
      ? (db
          .prepare(
            `SELECT id, name, system_prompt, model_id, updated_at FROM agents
             WHERE name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR IFNULL(system_prompt, '') LIKE ? ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?`
          )
          .all(pattern, pattern, pattern, limit + 1) as any[])
      : (db
          .prepare(`SELECT id, name, system_prompt, model_id, updated_at FROM agents ORDER BY updated_at DESC LIMIT ?`)
          .all(limit + 1) as any[]);
    truncated = pushRows(results, rows, limit, (row) => ({
      kind: 'bot',
      id: String(row.id),
      title: String(row.name),
      subtitle: row.system_prompt ? String(row.system_prompt) : String(row.model_id),
      agentId: String(row.id),
      timestamp: row.updated_at ? Number(row.updated_at) : undefined,
    })) || truncated;
  }

  if (wanted.has('message')) {
    const rows = filtering
      ? (db
          .prepare(
            `SELECT m.id, m.thread_id, m.content, m.role, m.created_at, t.agent_id, t.title
             FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE m.content LIKE ? ESCAPE '\\'
             ORDER BY m.id DESC LIMIT ?`
          )
          .all(pattern, limit + 1) as any[])
      : [];
    truncated = pushRows(results, rows, limit, (row) => ({
      kind: 'message',
      id: `msg-${row.id}`,
      title: String(row.content),
      subtitle: String(row.title),
      agentId: String(row.agent_id),
      threadId: String(row.thread_id),
      timestamp: Number(row.created_at),
    })) || truncated;
  }

  if (wanted.has('routine')) {
    const rows = filtering
      ? (db
          .prepare(
            `SELECT id, agent_id, name, human_schedule, cron_expression, next_run_at FROM routines
             WHERE name LIKE ? ESCAPE '\\' OR prompt_template LIKE ? ESCAPE '\\'
             ORDER BY next_run_at ASC LIMIT ?`
          )
          .all(pattern, pattern, limit + 1) as any[])
      : (db
          .prepare(
            `SELECT id, agent_id, name, human_schedule, cron_expression, next_run_at FROM routines
             ORDER BY next_run_at ASC LIMIT ?`
          )
          .all(limit + 1) as any[]);
    truncated = pushRows(results, rows, limit, (row) => ({
      kind: 'routine',
      id: String(row.id),
      title: String(row.name),
      subtitle: String(row.human_schedule ?? row.cron_expression),
      agentId: String(row.agent_id),
      timestamp: Number(row.next_run_at),
    })) || truncated;
  }

  if (wanted.has('file')) {
    // Files a run produced are recorded as agent data; live container
    // workspaces are reached through /api/runs/:id/workspace and are not
    // searchable here, which the empty state says outright.
    const rows = filtering
      ? (db
          .prepare(
            `SELECT id, agent_id, key, category, updated_at FROM agent_data
             WHERE key LIKE ? ESCAPE '\\' OR data_json LIKE ? ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?`
          )
          .all(pattern, pattern, limit + 1) as any[])
      : [];
    truncated = pushRows(results, rows, limit, (row) => ({
      kind: 'file',
      id: String(row.id),
      title: String(row.key),
      subtitle: String(row.category),
      agentId: String(row.agent_id),
      timestamp: Number(row.updated_at),
    })) || truncated;
  }

  if (wanted.has('link') && filtering) {
    const rows = db
      .prepare(
        `SELECT m.id, m.thread_id, m.content, m.created_at, t.agent_id
         FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
         WHERE m.content LIKE '%http%' ORDER BY m.id DESC LIMIT 500`
      )
      .all() as any[];
    const lower = query.toLowerCase();
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const matches = String(row.content).match(URL_RE) ?? [];
      for (const url of matches) {
        if (!url.toLowerCase().includes(lower)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        if (count >= limit) {
          truncated = true;
          break;
        }
        count += 1;
        results.push({
          kind: 'link',
          id: `link-${row.id}-${count}`,
          title: url,
          agentId: String(row.agent_id),
          threadId: String(row.thread_id),
          timestamp: Number(row.created_at),
        });
      }
      if (count >= limit) break;
    }
  }

  if (wanted.has('group')) {
    unsupported.push({
      kind: 'group',
      reason: 'This daemon has no group conversations, so there is nothing to search.',
    });
  }

  return { query, results, unsupported, truncated };
}

/** Push up to `limit` mapped rows and report whether more were available. */
function pushRows<T>(
  out: SearchResult[],
  rows: T[],
  limit: number,
  map: (row: T) => SearchResult
): boolean {
  const more = rows.length > limit;
  for (const row of rows.slice(0, limit)) out.push(map(row));
  return more;
}
