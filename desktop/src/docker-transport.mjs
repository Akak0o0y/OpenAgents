import fs from 'node:fs';
import path from 'node:path';
import { hasWslDockerEngine } from './wsl-docker.mjs';

function saveChoice(file, legacyWsl) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ legacyWsl }));
  fs.renameSync(`${file}.tmp`, file);
}

/** Preserve a confirmed legacy engine; never pin a profile to an unresponsive guess. */
export async function preserveDockerTransport({ directory, previousVersion, probeLegacy, probeNative, inspectLegacy = () => hasWslDockerEngine('Ubuntu-22.04'), env = process.env }) {
  if (process.platform !== 'win32' || env.OPENHOURS_DOCKER_CMD?.trim() || env.OPENHOURS_WSL_DISTRO?.trim()) return;
  const file = path.join(directory, 'desktop-docker.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first upgrade */ }
  if (saved?.legacyWsl === true) {
    // A stopped local service still owns this profile's volumes. Do not switch
    // engines merely because its API has not answered during a cold start.
    // An old guess with no local service can still use Docker Desktop natively.
    const legacy = await probeLegacy();
    if (legacy.state === 'running' || await inspectLegacy()) {
      env.OPENHOURS_WSL_DISTRO = 'Ubuntu-22.04';
      return;
    }
    const native = await probeNative?.();
    if (native?.state === 'running') saveChoice(file, false);
    return;
  }
  if (saved?.legacyWsl === false || !/^0\.[0-3]\.\d+$/.test(previousVersion ?? '') || Number(previousVersion.split('.')[2]) >= 7) return;
  if (!fs.existsSync(path.join(directory, 'openhours.db'))) return;
  const status = await probeLegacy();
  // A timeout is not proof that this profile owns a legacy engine. Persisting
  // that guess is what trapped upgraded installations on a connection that
  // could never become healthy.
  const legacyWsl = status.state === 'running' || await inspectLegacy();
  saveChoice(file, legacyWsl);
  if (legacyWsl) env.OPENHOURS_WSL_DISTRO = 'Ubuntu-22.04';
}
