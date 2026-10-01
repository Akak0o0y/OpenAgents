/**
 * The database, protected across app versions.
 *
 * A new version can change the database format as it opens it, and an older
 * version can then fail on - or damage - a profile it no longer understands.
 * Neither should cost someone their conversations. So when the version that
 * opens a profile differs from the one that last opened it, a copy is taken
 * first, and a downgrade is called out before it happens.
 *
 * The copy is only taken while nothing holds the database. A file-level copy of
 * a SQLite database in use can capture half a transaction; a copy of a closed
 * one, with its -wal and -shm alongside, is exactly the database.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DATABASE_FILE = 'openhours.db';
const COMPANIONS = ['', '-wal', '-shm'];

function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
  return match ? match.slice(1).map(part => part === undefined ? 0 : Number(part)) : null;
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 4; i++) {
    const leftPart = left[i] ?? 0;
    const rightPart = right[i] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

/** @returns {'first-run' | 'same' | 'upgrade' | 'downgrade'} */
export function versionTransition(lastVersion, currentVersion) {
  const order = compareVersions(lastVersion, currentVersion);
  if (order === null) return 'first-run';
  return order === 0 ? 'same' : order > 0 ? 'downgrade' : 'upgrade';
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Is a live daemon holding this database? Reads the daemon's own profile lock. */
export function databaseInUse(dbPath, alive = isProcessAlive) {
  try {
    const owner = JSON.parse(fs.readFileSync(`${dbPath}.lock`, 'utf8'));
    return alive(owner?.pid);
  } catch {
    return false;
  }
}

/**
 * Copy the database into `<dataDir>/backups`, keeping the newest `keep`.
 *
 * @returns {{ status: 'created', file: string } | { status: 'skipped', reason: string }}
 */
export function backupDatabase({ dataDir, fromVersion, toVersion, keep = 3, now = new Date(), inUse = databaseInUse }) {
  const dbPath = path.join(dataDir, DATABASE_FILE);
  if (!fs.existsSync(dbPath)) return { status: 'skipped', reason: 'There is no database yet.' };
  if (inUse(dbPath)) return { status: 'skipped', reason: 'A running server holds the database.' };

  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = `openhours-${fromVersion ?? 'unknown'}-to-${toVersion}-${stamp}.db`;
  const target = path.join(dir, base);
  for (const suffix of COMPANIONS) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`, fs.constants.COPYFILE_EXCL);
  }

  // Ordered by the time in the NAME, not the file's modified time: copying a
  // file on Windows keeps the source's modified time, so every backup would
  // look exactly as old as the database it was taken from.
  const stampOf = (name) => /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.db$/.exec(name)?.[1] ?? '';
  const backups = fs.readdirSync(dir)
    .filter((name) => /^openhours-.+\.db$/.test(name))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a))
    .map((name) => ({ name }));
  for (const old of backups.slice(keep)) {
    for (const suffix of COMPANIONS) fs.rmSync(path.join(dir, `${old.name}${suffix}`), { force: true });
  }
  return { status: 'created', file: target };
}

/**
 * The daemon's startup guard, left behind by a startup that was interrupted.
 *
 * The daemon refuses to start while `<db>.lock.claim` exists, on purpose: it
 * cannot tell an interrupted startup from a concurrent one, and asks for the
 * owning process to be verified first. The shell CAN verify it - the file holds
 * the PID - so a guard whose process is gone is removed here instead of
 * leaving a person to find and delete a file they have never heard of.
 */
export function clearStaleStartupClaim(dbPath, alive = isProcessAlive) {
  const claim = `${dbPath}.lock.claim`;
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(claim, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (Number.isSafeInteger(pid) && alive(pid)) return false;
  try {
    fs.rmSync(claim, { force: true });
    return true;
  } catch {
    return false;
  }
}
