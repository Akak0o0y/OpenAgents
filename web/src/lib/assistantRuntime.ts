/**
 * The assistant-ui runtime, backed by the OpenAgents daemon.
 *
 * WHY `useExternalStoreRuntime` AND NOT `useLocalRuntime`. The two differ on
 * who owns the transcript. `useLocalRuntime` owns it, and the app feeds it a
 * model adapter - which would make assistant-ui the source of truth for
 * messages that actually live in the daemon's SQLite database and are loaded
 * from it on every thread switch. `useExternalStoreRuntime` inverts that: the
 * app keeps the array, assistant-ui renders it and calls back when the person
 * does something. That matches what is already true here, so nothing has to be
 * mirrored and there is no second copy to fall out of step.
 *
 * WHAT IS DELIBERATELY NOT WIRED, and why it is left undefined rather than
 * stubbed:
 *
 * Cancellation is wired to the active durable request through the daemon.
 *
 *   onEdit     Editing a sent message means rewriting history. The daemon
 *              stores an append-only transcript with no update route, so an
 *              edit could change the screen but not the database - and would
 *              silently revert on reload.
 *
 *   onReload   "Regenerate" implies replacing an answer. There are no branches
 *              in this schema; re-asking appends a new exchange. That is
 *              offered explicitly as "Ask again" instead, where the wording can
 *              say so.
 *
 * Each of those becomes wireable the moment the daemon grows the route. Until
 * then their absence is the honest shape of this backend.
 */

import { useMemo } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ChatMessageRow } from './transport.js';

/**
 * A daemon row as assistant-ui understands it.
 *
 * The id has to be stable across renders or assistant-ui remounts every
 * message on each poll. A persisted row has a database id; an optimistic one
 * does not yet, so it falls back to its creation timestamp - which is unique
 * within a thread because it is the moment the person pressed send.
 */
function convertMessage(row: ChatMessageRow): ThreadMessageLike {
  return {
    id: row.id !== undefined ? `m${row.id}` : `t${row.created_at}`,
    role: row.role,
    content: [{ type: 'text', text: row.content }],
    createdAt: new Date(row.created_at),
    metadata: { custom: { taskRunId: row.task_run_id ?? null } },
  };
}

/** The text of a composed message, which assistant-ui hands over as parts. */
export function textOfAppend(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

export interface OpenAgentsRuntimeOptions {
  messages: ChatMessageRow[];
  /** True while a reply is being waited for. Drives the thinking indicator. */
  isRunning: boolean;
  /** True while the transcript itself is being fetched. */
  isLoading: boolean;
  /**
   * Send. Resolves when the reply has been stored, rejects with a message the
   * interface can show - the daemon's own wording, not a generic failure.
   */
  onSend: (text: string) => Promise<void>;
  onCancel?: () => Promise<void>;
  /** False when there is no thread yet, or the daemon has no chat service. */
  canSend: boolean;
}

export function useOpenAgentsRuntime({
  messages,
  isRunning,
  isLoading,
  onSend,
  onCancel,
  canSend,
}: OpenAgentsRuntimeOptions) {
  // The adapter object is rebuilt whenever anything in it changes, which is
  // what assistant-ui reads on each render; the callbacks close over the
  // current send so a stale one can never be invoked.
  const adapter = useMemo(
    () => ({
      messages,
      isRunning,
      isLoading,
      isSendDisabled: !canSend,
      convertMessage,
      onCancel,
      onNew: async (message: AppendMessage) => {
        const text = textOfAppend(message);
        if (!text) return;
        await onSend(text);
      },
    }),
    [messages, isRunning, isLoading, canSend, onSend, onCancel]
  );

  return useExternalStoreRuntime(adapter);
}
