/**
 * Shared shapes for the workspace tree.
 *
 * Kept in its own module so the sidebar, the transcript and the details panel
 * can all name the same thing without importing each other.
 */

import type { BotProfile, ConversationFlags, ReactionMap } from '../lib/botProfile.js';
import { UI_LOCALE } from '../lib/numbers.js';
import type { AgentRow } from '../lib/transport.js';

export interface Teammate {
  id: string;
  name: string;
  /** The bot's system prompt. "Description" in the settings panel. */
  description: string;
  model: string;
  /** Provider connection from Settings, Providers. Null means the model ID's own provider. */
  connectionId?: string | null;
  routingMode?: 'pinned' | 'auto' | null;
  status: AgentRow['current_status'];
  budgetCapUsd: number;
  profile: BotProfile;
  flags: ConversationFlags;
  reactions: ReactionMap;
  updatedAt?: number;
  /** Newest conversation for this bot, when one exists. */
  threadId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
}

/** An unsent conversation. Not a bot, and never persisted as one. */
export interface ChatDraft {
  kind: 'direct' | 'group';
  /** Bot ids added to a group draft. A direct draft has at most one. */
  recipients: string[];
}

export type DetailsView = 'details' | 'settings' | 'routine' | 'file';

export interface SelectedWorkspaceFile {
  path: string;
  runId?: string | null;
  content?: string | null;
  artifactUrl?: string | null;
}

/** Where the details panel is, and which routine it is editing. */
export interface DetailsState {
  open: boolean;
  view: DetailsView;
  /** null while creating a new routine; an id while editing an existing one. */
  routineId: string | null;
  /** File selected for the workspace file viewer. */
  selectedFile?: SelectedWorkspaceFile | null;
}

/**
 * A short, human time for a sidebar row: today shows a clock, yesterday says
 * so, and anything older shows a date. Matches the reference's three cases.
 */
export function relativeDayLabel(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return '';
  const then = new Date(timestamp);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) {
    return then.toLocaleTimeString(UI_LOCALE, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  ) {
    return 'Yesterday';
  }
  return then.toLocaleDateString(UI_LOCALE, { month: 'short', day: 'numeric' });
}

/** Full date/time header used between conversation groups. */
export function transcriptDayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(UI_LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** True when two timestamps are far enough apart to deserve a separator. */
export function needsSeparator(previous: number | null, next: number): boolean {
  if (previous === null) return true;
  return next - previous > 15 * 60 * 1000;
}
