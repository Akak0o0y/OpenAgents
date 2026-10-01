/**
 * Profile ownership and migration.
 *
 * Two failures matter here and both are silent if they happen: a malformed
 * stored profile taking the avatar renderer down, and the localStorage
 * migration either skipping a bot or overwriting server state with a stale
 * local copy.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_APPEARANCE_STORAGE_KEY,
  MIGRATION_MARKER_KEY,
  PROFILE_CATEGORY,
  PROFILE_KEY,
  defaultProfile,
  loadWorkspaceUiState,
  normaliseFlags,
  normaliseProfile,
  normaliseReactions,
} from './botProfile.js';
import { api, type AgentRow } from './transport.js';

const agent: AgentRow = {
  id: 'atlas',
  name: 'Atlas',
  model_id: 'test-model',
  current_status: 'IDLE',
  budget_cap_usd: 10,
};

const base = defaultProfile(agent);

describe('normaliseProfile', () => {
  it('keeps a well-formed stored profile', () => {
    const stored = { ...base, shape: 'hex', color: '#123456', label: 'ops', notifications: true };
    const result = normaliseProfile(stored, base);
    expect(result.shape).toBe('hex');
    expect(result.color).toBe('#123456');
    expect(result.label).toBe('ops');
    expect(result.notifications).toBe(true);
  });

  it('falls back for an unknown shape rather than passing it to the renderer', () => {
    expect(normaliseProfile({ shape: 'dodecahedron' }, base).shape).toBe(base.shape);
  });

  it('migrates the retired gem shape instead of resetting the bot', () => {
    expect(normaliseProfile({ shape: 'gem' }, base).shape).toBe('crystal');
  });

  it('rejects a colour that is not a six-digit hex', () => {
    expect(normaliseProfile({ color: 'red' }, base).color).toBe(base.color);
    expect(normaliseProfile({ color: '#abc' }, base).color).toBe(base.color);
    expect(normaliseProfile({ color: '#AABBCC' }, base).color).toBe('#AABBCC');
  });

  it('clamps an out-of-range eye scale', () => {
    expect(normaliseProfile({ eyeScale: 99 }, base).eyeScale).toBe(2);
    expect(normaliseProfile({ eyeScale: -5 }, base).eyeScale).toBe(0.5);
    expect(normaliseProfile({ eyeScale: 'big' }, base).eyeScale).toBe(base.eyeScale);
  });

  it('drops an avatar that is not an image data URL', () => {
    expect(normaliseProfile({ avatarImage: 'https://example.invalid/x.png' }, base).avatarImage).toBeNull();
    expect(normaliseProfile({ avatarImage: 'data:image/png;base64,AAA' }, base).avatarImage).toBe(
      'data:image/png;base64,AAA'
    );
  });

  it('survives complete rubbish', () => {
    expect(normaliseProfile(null, base)).toEqual(base);
    expect(normaliseProfile('a string', base)).toEqual(base);
    expect(normaliseProfile(42, base)).toEqual(base);
  });
});

describe('normaliseFlags and normaliseReactions', () => {
  it('defaults every flag to false and no section', () => {
    expect(normaliseFlags(undefined)).toEqual({ pinned: false, unread: false, hidden: false, section: null });
  });

  it('treats a blank section as no section', () => {
    expect(normaliseFlags({ section: '   ' }).section).toBeNull();
  });

  it('keeps only string emoji arrays', () => {
    expect(normaliseReactions({ m1: ['👍', 7, null], m2: 'nope', m3: [] })).toEqual({ m1: ['👍'] });
  });
});

describe('loadWorkspaceUiState', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads profiles from the daemon', async () => {
    vi.spyOn(api, 'agentData').mockResolvedValue({
      data: [
        {
          id: 'row1',
          agent_id: 'atlas',
          key: PROFILE_KEY,
          category: PROFILE_CATEGORY,
          data_json: JSON.stringify({ ...base, label: 'from server' }),
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    const { state, error } = await loadWorkspaceUiState([agent]);
    expect(error).toBeNull();
    expect(state.profiles.atlas.label).toBe('from server');
  });

  it('migrates a legacy localStorage appearance up to the daemon exactly once', async () => {
    localStorage.setItem(
      LEGACY_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ atlas: { shape: 'cloud', label: 'legacy' } })
    );
    vi.spyOn(api, 'agentData').mockResolvedValue({ data: [] });
    const setSpy = vi.spyOn(api, 'setAgentData').mockResolvedValue({ record: {} as never });

    const first = await loadWorkspaceUiState([agent]);
    expect(first.migrated).toEqual(['atlas']);
    expect(first.state.profiles.atlas.shape).toBe('cloud');
    expect(first.state.profiles.atlas.label).toBe('legacy');
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(MIGRATION_MARKER_KEY)!)).toEqual({ atlas: true });

    // A second load must not push the stale local copy again.
    const second = await loadWorkspaceUiState([agent]);
    expect(second.migrated).toEqual([]);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('never lets a legacy value overwrite what the server already holds', async () => {
    localStorage.setItem(
      LEGACY_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ atlas: { label: 'stale local' } })
    );
    vi.spyOn(api, 'agentData').mockResolvedValue({
      data: [
        {
          id: 'row1',
          agent_id: 'atlas',
          key: PROFILE_KEY,
          category: PROFILE_CATEGORY,
          data_json: JSON.stringify({ ...base, label: 'server wins' }),
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    const setSpy = vi.spyOn(api, 'setAgentData').mockResolvedValue({ record: {} as never });

    const { state } = await loadWorkspaceUiState([agent]);
    expect(state.profiles.atlas.label).toBe('server wins');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('keeps the local value visible when the migration write fails', async () => {
    localStorage.setItem(
      LEGACY_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ atlas: { label: 'offline' } })
    );
    vi.spyOn(api, 'agentData').mockResolvedValue({ data: [] });
    vi.spyOn(api, 'setAgentData').mockRejectedValue(new Error('daemon down'));

    const { state, migrated } = await loadWorkspaceUiState([agent]);
    expect(state.profiles.atlas.label).toBe('offline');
    // Not reported as migrated, and the marker stays unset so it retries.
    expect(migrated).toEqual([]);
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBeNull();
  });

  it('reports a daemon without agent-data support instead of throwing', async () => {
    vi.spyOn(api, 'agentData').mockRejectedValue(
      new Error('This daemon was started without agent data support.')
    );
    const { state, error } = await loadWorkspaceUiState([agent]);
    expect(error).toMatch(/without agent data support/);
    // Still renders, with the generated default.
    expect(state.profiles.atlas).toEqual(base);
  });
});
