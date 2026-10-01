import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Files whose contents define the running implementation. A display version such as
 * "0.4.4" can be reused across different builds, so upgrade and support decisions need
 * an identity derived from the code that is actually loaded.
 */
const IMPLEMENTATION_FILES = [
  'dist/src/daemon/index.js',
  'dist/src/daemon/ws-server.js',
  'dist/src/daemon/work-runtime.js',
  'dist/src/daemon/browser-tools.js',
  'web/dist/index.html',
] as const;

/** Package root of the running app: <root>/dist/src/daemon/build-identity.js -> <root>. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

const cache = new Map<string, string>();

/**
 * A short, stable identity for the implementation under `root`. Two builds that share a
 * version but differ in compiled output produce different identities; an unchanged build
 * always produces the same one. Missing files are recorded rather than throwing, so a
 * partial installation is still reported instead of crashing startup.
 */
export function buildIdentity(root = packageRoot()): string {
  const cached = cache.get(root);
  if (cached) return cached;
  const digest = createHash('sha256');
  for (const relative of IMPLEMENTATION_FILES) {
    digest.update(relative);
    try { digest.update(createHash('sha256').update(readFileSync(path.join(root, relative))).digest()); }
    catch { digest.update('absent'); }
  }
  // The packager rewrites package.json when it builds an app (it drops scripts and
  // devDependencies), so hashing that file would make a package never match the source it was
  // built from. Only the declared version takes part, which still separates two releases that
  // ship identical code.
  let version = 'unknown';
  try { version = String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown'); }
  catch { version = 'unreadable'; }
  digest.update('version:' + version);
  const identity = digest.digest('hex').slice(0, 16);
  cache.set(root, identity);
  return identity;
}
