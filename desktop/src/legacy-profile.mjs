import path from 'node:path';

/** The profile folder keeps its pre-0.6.0 name: renaming the product must not open an empty profile. */
export const LEGACY_PROFILE_FOLDER = 'OpenHours';

/**
 * Where Electron keeps userData. An explicit data folder always wins. A packaged app is pinned to the
 * legacy folder; a source run keeps Electron's default, so development never opens the owner's profile.
 */
export function chooseUserData({ override, isPackaged, appData }) {
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('OPENAGENTS_DATA_DIR must be an absolute profile directory.');
    return override;
  }
  return isPackaged ? path.join(appData, LEGACY_PROFILE_FOLDER) : null;
}
