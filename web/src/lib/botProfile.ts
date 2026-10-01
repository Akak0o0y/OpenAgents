/**
 * Bot profile: the fields the workspace owns, and where each one lives.
 *
 * Three fields on a bot are already server-owned and edited through
 * `PATCH /api/agents/:id`: name, description (the system prompt) and the model
 * plus budget cap. Everything else the settings panel edits - the label, the
 * notification switch, and the whole avatar - had no home at all: the previous
 * implementation kept it in `localStorage`, which meant a bot looked different
 * on every machine and the operator's own second browser showed a stranger.
 *
 * OWNERSHIP, decided here rather than left implicit:
 *
 *   name / description / model / budget   -> agents table, PATCH /api/agents/:id
 *   label / notifications / avatar        -> agent_data, category "ui"
 *   sidebar flags (pin, unread, hidden)   -> agent_data, category "ui"
 *   message reactions                     -> agent_data, category "ui"
 *   theme, and anything about THIS BROWSER-> localStorage, and only that
 *
 * `agent_data` is the daemon's existing durable per-agent store. It is already
 * validated, already scoped to an agent that must exist, and already exposed
 * over HTTP, so putting profile state there needs no new table and no new
 * trust boundary.
 *
 * MIGRATION: the old localStorage blob is read once per agent, pushed to the
 * server if the server has nothing, and then marked as migrated. It is not
 * deleted - a migration that failed halfway must not have destroyed the only
 * copy of the operator's customisation.
 */

import { api, type AgentDataRow, type AgentRow } from './transport.js';
import { getAgentBotPersonality } from './aora-bot/index.js';
import { resolveShape, type AoraShape } from './aora-bot/shapes.js';

export const PROFILE_CATEGORY = 'ui';
export const PROFILE_KEY = 'bot-profile';
export const FLAGS_KEY = 'conversation-flags';
export const REACTIONS_KEY = 'message-reactions';

export const LEGACY_APPEARANCE_STORAGE_KEY = 'openhours.bot-appearance.v1';
export const MIGRATION_MARKER_KEY = 'openhours.bot-appearance.migrated.v1';

/** Eleven swatches, matching the reference's label vocabulary.
 *
 * The values are OpenAgents' own. The reference notes that its "Black" swatch
 * renders light against a dark interface; that is preserved as an observation
 * about the label, not copied as a colour. */
export const BOT_COLORS: Array<{ id: string; label: string; value: string }> = [
  { id: 'black', label: 'Black', value: '#F2F3F5' },
  { id: 'brown', label: 'Brown', value: '#8C6239' },
  { id: 'red', label: 'Red', value: '#F0384B' },
  { id: 'orange', label: 'Orange', value: '#F5701A' },
  { id: 'yellow', label: 'Yellow', value: '#F2A324' },
  { id: 'green', label: 'Green', value: '#1FB973' },
  { id: 'cyan', label: 'Cyan', value: '#16B3A4' },
  { id: 'blue', label: 'Blue', value: '#2C86F0' },
  { id: 'violet', label: 'Violet', value: '#8A5CF0' },
  { id: 'magenta', label: 'Magenta', value: '#EC3F97' },
  { id: 'gray', label: 'Gray', value: '#7A7F87' },
];

export interface BotProfile {
  shape: AoraShape;
  color: string;
  eyeColor: string;
  eyeScale: number;
  emotion: string;
  idle: boolean;
  sketch: boolean;
  /** Optional short category shown under the name. */
  label: string;
  notifications: boolean;
  /** A data: URL from the Upload tab, when the operator supplied one. */
  avatarImage: string | null;
}

export interface ConversationFlags {
  pinned: boolean;
  unread: boolean;
  hidden: boolean;
  section: string | null;
}

export const DEFAULT_FLAGS: ConversationFlags = {
  pinned: false,
  unread: false,
  hidden: false,
  section: null,
};

/** Reactions for one bot's transcript, keyed by message id. */
export type ReactionMap = Record<string, string[]>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** 512KB of base64 is already a very large avatar; beyond that is a mistake. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** The profile a bot has before anyone customises it. Deterministic per bot. */
export function defaultProfile(agent: Pick<AgentRow, 'id' | 'name' | 'model_id'>): BotProfile {
  const generated = getAgentBotPersonality(agent);
  return {
    shape: generated.shape,
    color: generated.color,
    eyeColor: generated.eyeColor,
    eyeScale: 1,
    emotion: '02',
    idle: true,
    sketch: false,
    label: '',
    notifications: false,
    avatarImage: null,
  };
}

/**
 * Coerce whatever came back from the server (or an old localStorage blob) into
 * a profile. Unknown shapes, bad colours and out-of-range scales fall back to
 * the default instead of reaching the renderer, because a malformed stored
 * value must not be able to break the avatar for every later session.
 */
export function normaliseProfile(raw: unknown, base: BotProfile): BotProfile {
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Record<string, unknown>;
  const avatar = typeof value.avatarImage === 'string' ? value.avatarImage : null;
  return {
    // resolveShape follows aliases, so a bot saved as `gem` becomes `crystal`
    // rather than silently reverting to the generated default.
    shape: resolveShape(value.shape) ?? base.shape,
    color: typeof value.color === 'string' && HEX_RE.test(value.color) ? value.color : base.color,
    eyeColor:
      typeof value.eyeColor === 'string' && HEX_RE.test(value.eyeColor) ? value.eyeColor : base.eyeColor,
    eyeScale:
      typeof value.eyeScale === 'number' && Number.isFinite(value.eyeScale)
        ? Math.min(2, Math.max(0.5, value.eyeScale))
        : base.eyeScale,
    emotion: typeof value.emotion === 'string' && value.emotion.length <= 8 ? value.emotion : base.emotion,
    idle: typeof value.idle === 'boolean' ? value.idle : base.idle,
    sketch: typeof value.sketch === 'boolean' ? value.sketch : base.sketch,
    label: typeof value.label === 'string' ? value.label.slice(0, 60) : base.label,
    notifications: typeof value.notifications === 'boolean' ? value.notifications : base.notifications,
    avatarImage:
      avatar && avatar.startsWith('data:image/') && avatar.length <= MAX_AVATAR_BYTES ? avatar : null,
  };
}

export function normaliseFlags(raw: unknown): ConversationFlags {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FLAGS };
  const value = raw as Record<string, unknown>;
  return {
    pinned: value.pinned === true,
    unread: value.unread === true,
    hidden: value.hidden === true,
    section: typeof value.section === 'string' && value.section.trim() ? value.section.slice(0, 40) : null,
  };
}

export function normaliseReactions(raw: unknown): ReactionMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: ReactionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const emoji = value.filter((e): e is string => typeof e === 'string' && e.length <= 8).slice(0, 12);
    if (emoji.length) out[key.slice(0, 64)] = emoji;
  }
  return out;
}

function parseRecord(rows: AgentDataRow[], agentId: string, key: string): unknown {
  const row = rows.find((r) => r.agent_id === agentId && r.key === key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.data_json);
  } catch {
    return undefined;
  }
}

export interface WorkspaceUiState {
  profiles: Record<string, BotProfile>;
  flags: Record<string, ConversationFlags>;
  reactions: Record<string, ReactionMap>;
}

function readLegacyAppearances(): Record<string, Partial<BotProfile>> {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_APPEARANCE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function readMigrationMarker(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(MIGRATION_MARKER_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function markMigrated(agentId: string): void {
  try {
    const marker = readMigrationMarker();
    marker[agentId] = true;
    localStorage.setItem(MIGRATION_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // A browser that refuses storage simply re-attempts the migration next
    // time. The server write is idempotent, so that is harmless.
  }
}

/**
 * Load every bot's UI state from the daemon, migrating the legacy localStorage
 * appearance blob on the way through.
 *
 * Returns the state plus a list of agents whose legacy data was migrated, so
 * the caller can say so rather than silently changing what the operator sees.
 */
export async function loadWorkspaceUiState(
  agents: AgentRow[]
): Promise<{ state: WorkspaceUiState; migrated: string[]; error: string | null }> {
  const state: WorkspaceUiState = { profiles: {}, flags: {}, reactions: {} };
  const migrated: string[] = [];
  let rows: AgentDataRow[] = [];
  let error: string | null = null;

  try {
    rows = (await api.agentData(undefined, PROFILE_CATEGORY)).data;
  } catch (cause) {
    // A daemon without agent-data support is a real state, not a crash. The
    // workspace still renders with generated avatars and says that
    // customisation cannot be saved.
    error = cause instanceof Error ? cause.message : 'Could not load saved bot profiles.';
  }

  const legacy = error === null ? readLegacyAppearances() : {};
  const marker = readMigrationMarker();

  for (const agent of agents) {
    const base = defaultProfile(agent);
    const stored = parseRecord(rows, agent.id, PROFILE_KEY);
    if (stored === undefined && legacy[agent.id] && !marker[agent.id]) {
      const upgraded = normaliseProfile(legacy[agent.id], base);
      try {
        await api.setAgentData({
          agentId: agent.id,
          key: PROFILE_KEY,
          category: PROFILE_CATEGORY,
          data: upgraded,
        });
        markMigrated(agent.id);
        migrated.push(agent.id);
        state.profiles[agent.id] = upgraded;
      } catch {
        // Keep showing the local value; the marker stays unset so the next
        // load tries again.
        state.profiles[agent.id] = upgraded;
      }
    } else {
      state.profiles[agent.id] = normaliseProfile(stored, base);
    }
    state.flags[agent.id] = normaliseFlags(parseRecord(rows, agent.id, FLAGS_KEY));
    state.reactions[agent.id] = normaliseReactions(parseRecord(rows, agent.id, REACTIONS_KEY));
  }

  return { state, migrated, error };
}

export function saveProfile(agentId: string, profile: BotProfile) {
  return api.setAgentData({
    agentId,
    key: PROFILE_KEY,
    category: PROFILE_CATEGORY,
    data: profile,
  });
}

export function saveFlags(agentId: string, flags: ConversationFlags) {
  return api.setAgentData({
    agentId,
    key: FLAGS_KEY,
    category: PROFILE_CATEGORY,
    data: flags,
  });
}

export function saveReactions(agentId: string, reactions: ReactionMap) {
  return api.setAgentData({
    agentId,
    key: REACTIONS_KEY,
    category: PROFILE_CATEGORY,
    data: reactions,
  });
}
