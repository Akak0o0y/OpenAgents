import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const API_VERSION = 1;
export const SESSION_COOKIE = 'openhours_session';
export interface LocalCredentials { token: string; profileId: string; apiVersion: number }

export function profileIdentity(dbPath: string): string {
  const absolute = path.resolve(dbPath);
  return createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex');
}

export function loadLocalCredentials(dbPath: string): LocalCredentials {
  const profileId = profileIdentity(dbPath);
  const file = `${path.resolve(dbPath)}.auth.json`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ token: randomBytes(32).toString('hex'), profileId, apiVersion: API_VERSION }), { flag: 'wx', mode: 0o600 });
  } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(credentials.token) || credentials.profileId !== profileId || credentials.apiVersion !== API_VERSION) {
    throw new Error(`Invalid daemon credentials for this database profile: ${file}`);
  }
  return credentials;
}

export function secretMatches(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || !actual) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasCredentials(req: IncomingMessage, token: string): boolean {
  if (req.headers.authorization?.startsWith('Bearer ') && secretMatches(req.headers.authorization.slice(7), token)) return true;
  const cookie = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${SESSION_COOKIE}=`));
  return secretMatches(cookie?.slice(SESSION_COOKIE.length + 1), token);
}

/** A profile may have only one writer/cleanup owner. Stale locks are reclaimed by PID. */
export function acquireProfileLock(dbPath: string): () => void {
  const lockPath = `${path.resolve(dbPath)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const identity = randomBytes(16).toString('hex');
  // Every claimant holds this short-lived guard, including stale-lock recovery.
  // Without it, two starters can both unlink the dead owner's lock and one can
  // accidentally unlink the other starter's new lock. An interrupted guard is
  // deliberately refused; it needs operator inspection instead of unsafe cleanup.
  const guard = `${lockPath}.claim`;
  try { fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error(`Another startup is claiming this profile. If it was interrupted, verify its process has stopped before removing ${guard}.`);
    throw error;
  }
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, identity }), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).identity === identity) fs.unlinkSync(lockPath); } catch { /* already released */ }
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid profile lock: ${lockPath}`);
      try { process.kill(owner.pid, 0); } catch (probe: any) {
        if (probe.code === 'ESRCH') { fs.unlinkSync(lockPath); continue; }
        throw probe;
      }
      throw new Error('This OpenAgents database profile is already in use by a running daemon.');
    }
  }
  throw new Error('Could not acquire the OpenAgents profile lock.');
  } finally { fs.unlinkSync(guard); }
}
