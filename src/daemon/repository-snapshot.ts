import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { publicAddress, resolveAddresses } from './web-research.js';
import { workspacePath } from './artifacts.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Read-only snapshots of public GitHub repositories, for repository work in an isolated workspace.
 *
 * The archive comes from GitHub over HTTPS through a socket pinned to a checked public address, so no local git
 * installation is needed and no redirect can reach a private service. Only bounded UTF-8 text files are kept.
 * Binaries, symbolic links, dependency folders and unsafe paths are recorded as skipped, never silently dropped.
 */

export interface RepositoryRef { owner: string; repo: string; ref: string; paths?: string[]; workingTree?: boolean }
export interface SnapshotLimits { archiveBytes: number; extractedBytes: number; files: number; fileBytes: number }
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { archiveBytes: 8 * 1024 * 1024, extractedBytes: 32 * 1024 * 1024, files: 2000, fileBytes: 256 * 1024 };

export interface SkippedFile { path: string; reason: string }
export interface RepositorySnapshot {
  repository: RepositoryRef;
  source: string;
  archiveSha256: string;
  /** Commit recorded by GitHub in the archive, when present. */
  commit: string | null;
  fetchedAt: string;
  files: Record<string, string>;
  binaries?: Record<string, string>;
  skipped: SkippedFile[];
  textBytes: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const IGNORED = /^(?:\.git|node_modules|\.venv|venv|__pycache__|\.next|coverage)(?:\/|$)/;
const ALLOWED_HOSTS = new Set(['codeload.github.com', 'github.com', 'api.github.com']);
const NUL = 0;

export function parseRepository(value: string): RepositoryRef {
  const text = value.trim();
  const fromUrl = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^?#]+)|\/(?:issues|pull)\/\d+)?\/?(?:[?#].*)?$/.exec(text);
  const short = /^([^/\s@]+)\/([^/\s@]+)(?:@(\S+))?$/.exec(text);
  const match = fromUrl ?? short;
  if (!match) throw new Error('Name a GitHub repository as owner/repo, owner/repo@ref or a github.com URL.');
  const owner = match[1], repo = match[2].replace(/\.git$/, '');
  const ref = match[3] ? (fromUrl ? decodeURIComponent(match[3]) : match[3]).replace(/\/+$/, '') : 'HEAD';
  if (!NAME.test(owner) || !NAME.test(repo) || !REF.test(ref) || ref.split('/').some(part => part === '' || part === '..' || part === '.')) {
    throw new Error('That GitHub repository name or ref is not valid.');
  }
  return { owner, repo, ref };
}

export function archiveUrl(repository: RepositoryRef): string {
  return `https://codeload.github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tar.gz/${repository.ref.split('/').map(encodeURIComponent).join('/')}`;
}

const mib = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** HTTPS GET from GitHub hosts only, pinned to a public address, bounded in size and time. */
export async function downloadGitHubArchive(value: string, signal: AbortSignal, maxBytes: number, redirects = 0, token?: string): Promise<Buffer> {
  signal.throwIfAborted();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('Repository archives are downloaded only from GitHub over HTTPS.');
  }
  const addresses = await resolveAddresses(url.hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('GitHub resolved to a private or reserved address, so the download was refused.');
  const address = addresses[0];
  const response = await new Promise<{ status: number; location?: string; body?: Buffer }>((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET', signal, family: address.family,
      headers: { 'User-Agent': 'OpenAgents/0.1 repository', Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity',
        ...(token && url.hostname === 'api.github.com' ? { Authorization: `Bearer ${token}` } : {}) },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, location: res.headers.location }); return; }
      if (status !== 200) {
        res.resume();
        reject(new Error(`GitHub returned HTTP ${status} for the repository archive${status === 404 ? ' (repository or ref not found, or private)' : status === 429 ? ' (rate limited)' : ''}.`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      const tooLarge = () => new Error(`The repository archive exceeds the ${mib(maxBytes)} MiB limit.`);
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); reject(tooLarge()); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) req.destroy(tooLarge()); else chunks.push(chunk); });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    const timeout = setTimeout(() => req.destroy(new Error('The repository download timed out.')), 60_000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
    req.end();
  });
  if (response.status >= 300 && response.status < 400) {
    if (!response.location || redirects >= 4) throw new Error('GitHub redirected too many times or without a destination.');
    // A redirect receives no credential. Private archive redirects carry their own short-lived signature.
    return downloadGitHubArchive(new URL(response.location, url).href, signal, maxBytes, redirects + 1);
  }
  return response.body!;
}

/** Reads a gzip-compressed ustar/pax archive into bounded text files, stripping GitHub's top-level directory. */
export function extractTarGz(archive: Buffer, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS, includeBinary = false): { files: Record<string, string>; binaries?: Record<string, string>; skipped: SkippedFile[]; textBytes: number; commit: string | null } {
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: limits.extractedBytes }); }
  catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(String(error))
      ? `The extracted repository exceeds the ${mib(limits.extractedBytes)} MiB limit.` : 'The repository archive is not a valid gzip file.');
  }
  const files: Record<string, string> = {};
  const binaries: Record<string, string> = {};
  const skipped: SkippedFile[] = [];
  let textBytes = 0, offset = 0, count = 0;
  let paxPath: string | undefined, longName: string | undefined, commit: string | null = null;
  const text = (start: number, length: number) => {
    const raw = tar.subarray(start, start + length);
    const end = raw.indexOf(NUL);
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
  };
  while (offset + 512 <= tar.length) {
    const header = offset;
    if (tar.subarray(header, header + 512).every(byte => byte === NUL)) break;
    const size = parseInt(text(header + 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The repository archive has a corrupt entry.');
    const type = tar[header + 156] === NUL ? '0' : String.fromCharCode(tar[header + 156]);
    const dataStart = header + 512, dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('The repository archive is truncated.');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'g') { commit = /comment=([0-9a-f]{40})/.exec(data.toString('utf8'))?.[1] ?? commit; continue; }
    if (type === 'x') { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1]; continue; }
    if (type === 'L') { longName = text(dataStart, size); continue; }
    const prefix = text(header + 257, 6).startsWith('ustar') ? text(header + 345, 155) : '';
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${text(header, 100)}` : text(header, 100));
    paxPath = longName = undefined;
    const relative = name.split('/').slice(1).join('/');
    if (!relative || type === '5' || relative.endsWith('/')) continue;
    if (type !== '0' && type !== '7') { skipped.push({ path: relative.slice(0, 300), reason: type === '2' ? 'symbolic link' : 'not a regular file' }); continue; }
    if (IGNORED.test(relative)) { skipped.push({ path: relative.slice(0, 300), reason: 'dependency or tool folder' }); continue; }
    let safe: string;
    try { safe = workspacePath(relative); } catch { skipped.push({ path: relative.slice(0, 300), reason: 'unsupported path' }); continue; }
    if (size > limits.fileBytes) { skipped.push({ path: safe, reason: `larger than ${Math.round(limits.fileBytes / 1024)} KiB` }); continue; }
    if (includeBinary && (data.includes(NUL) || !Buffer.from(data.toString('utf8')).equals(data))) {
      if (count >= limits.files) { skipped.push({ path: safe, reason: 'file count limit' }); continue; }
      binaries[safe] = data.toString('base64'); count++; continue;
    }
    if (data.subarray(0, 8192).includes(NUL)) { skipped.push({ path: safe, reason: 'binary' }); continue; }
    const content = data.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(data)) { skipped.push({ path: safe, reason: 'not UTF-8 text' }); continue; }
    if (count >= limits.files) { skipped.push({ path: safe, reason: `more than ${limits.files} text files` }); continue; }
    files[safe] = content;
    textBytes += size;
    count++;
  }
  return { files, ...(includeBinary ? { binaries } : {}), skipped: skipped.slice(0, 1000), textBytes, commit };
}

export class RepositoryFetcher {
  constructor(private readonly options: { download?: (url: string, signal: AbortSignal, maxBytes: number) => Promise<Buffer>; limits?: Partial<SnapshotLimits>;
    local?: Record<string, string>; githubToken?: (repository: RepositoryRef) => string | undefined } = {}) {}

  async snapshot(repository: RepositoryRef, signal: AbortSignal): Promise<RepositorySnapshot> {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, archiveBytes: 64 * 1024 * 1024, extractedBytes: 128 * 1024 * 1024, files: 20000, fileBytes: 2 * 1024 * 1024, ...this.options.limits };
    const selected = repository.paths?.map(p => workspacePath(p));
    if (selected?.some(p => IGNORED.test(p))) throw new Error('Dependency and Git internals cannot be selected.');
    if (repository.workingTree && repository.owner !== 'local') throw new Error('Working-tree input requires a configured local alias.');
    if (selected?.length && repository.owner !== 'local') return this.selectedSnapshot(repository, selected, limits, signal);
    let source = archiveUrl(repository), archive: Buffer, localCommit: string | undefined;
    if (repository.owner === 'local') {
      const root = this.options.local?.[repository.repo];
      if (!root || !path.isAbsolute(root)) throw new Error('This local repository alias has not been configured by the operator.');
      const git = (args: string[], maxBuffer: number) => new Promise<Buffer>((resolve, reject) => {
        execFile('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'buffer', maxBuffer, timeout: 60000, signal, windowsHide: true }, (error, stdout) => {
          // Do not include host paths or git diagnostics in model-visible errors.
          if (error) reject(new Error('Local Git snapshot failed. Check the configured checkout, ref and archive size limit.'));
          else resolve(stdout);
        });
      });
      localCommit = (await git(['rev-parse', '--verify', '--end-of-options', `${repository.ref}^{commit}`], 4096)).toString('utf8').trim();
      if (!/^[a-f0-9]{40}$/.test(localCommit)) throw new Error('Local repository did not resolve to a supported commit.');
      if (repository.workingTree) {
        const entries = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...(selected?.length ? ['--', ...selected] : [])], 8 * 1024 * 1024)).toString('utf8').split('\0').filter(Boolean);
        const files: Record<string,string> = {}, binaries: Record<string,string> = {}, skipped: SkippedFile[] = [];
        let size = 0; const realRoot = await fs.realpath(root);
        for (const p of new Set(entries)) {
          signal.throwIfAborted();
          let safe: string; try { safe = workspacePath(p); } catch { skipped.push({path:p,reason:'unsupported path'}); continue; }
          if (IGNORED.test(safe) || /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519)$/.test(safe)) { skipped.push({path:safe,reason:'excluded private or dependency file'}); continue; }
          const file = path.resolve(root,safe);
          let stat; try { stat = await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
          const real = await fs.realpath(file);
          if (!stat.isFile() || stat.isSymbolicLink() || !real.startsWith(realRoot + path.sep)) { skipped.push({path:safe,reason:'not a contained regular file'}); continue; }
          if (stat.size > limits.fileBytes) throw new Error(`Selected working file ${safe} exceeds its size limit.`);
          if (Object.keys(files).length + Object.keys(binaries).length >= limits.files) throw new Error('Working-tree file count exceeds the snapshot limit; select fewer paths.');
          const data = await fs.readFile(real); size += data.length;
          if (size > limits.extractedBytes || data.length > limits.fileBytes) throw new Error('Working-tree snapshot exceeds its byte limit; select fewer paths.');
          if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) binaries[safe] = data.toString('base64'); else files[safe] = data.toString('utf8');
        }
        return {repository,source:`local/${repository.repo}@${localCommit} (working tree)`,commit:localCommit,files,binaries,skipped,textBytes:Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0),archiveSha256:createHash('sha256').update(JSON.stringify({files,binaries})).digest('hex'),fetchedAt:new Date().toISOString()};
      }
      archive = await git(['archive', '--format=tar.gz', '--prefix=snapshot/', localCommit, ...(selected?.length ? ['--', ...selected] : [])], limits.archiveBytes);
      source = `local/${repository.repo}@${localCommit}`;
    } else {
      const token = this.options.githubToken?.(repository);
      if (token) source = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tarball/${encodeURIComponent(repository.ref)}`;
      archive = await (this.options.download ? this.options.download(source, signal, limits.archiveBytes) : downloadGitHubArchive(source, signal, limits.archiveBytes, 0, token));
    }
    signal.throwIfAborted();
    if (archive.length > limits.archiveBytes) throw new Error(`The repository archive exceeds the ${mib(limits.archiveBytes)} MiB limit.`);
    const extracted = extractTarGz(archive, limits, true);
    if (localCommit) extracted.commit = localCommit;
    if (!Object.keys(extracted.files).length && !Object.keys(extracted.binaries ?? {}).length) throw new Error('The repository archive contains no readable files.');
    return { repository, source, archiveSha256: createHash('sha256').update(archive).digest('hex'), fetchedAt: new Date().toISOString(), ...extracted };
  }

  /** Walk only selected trees at a pinned commit. Large unrelated folders are never downloaded. */
  private async selectedSnapshot(repository: RepositoryRef, paths: string[], limits: SnapshotLimits, signal: AbortSignal): Promise<RepositorySnapshot> {
    const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
    const token = this.options.githubToken?.(repository); let calls = 0, bytes = 0;
    const get = async (endpoint: string, max = 3 * 1024 * 1024) => {
      if (++calls > 400) throw new Error('Selected repository exceeds 400 GitHub requests; select a smaller subtree.');
      const url = base + endpoint;
      const data = await (this.options.download ? this.options.download(url,signal,max) : downloadGitHubArchive(url,signal,max,0,token));
      return JSON.parse(data.toString('utf8'));
    };
    const commit = await get(`/commits/${encodeURIComponent(repository.ref)}`);
    if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha)) throw new Error('GitHub did not resolve a valid commit.');
    const files: Record<string,string> = {}, binaries: Record<string,string> = {}, skipped: SkippedFile[] = [];
    const walk = async (treeId: string, prefix: string): Promise<void> => {
      const tree = await get(`/git/trees/${treeId}`);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Selected Git tree is incomplete. Select a narrower path.');
      for (const entry of tree.tree) {
        const p = workspacePath(prefix + entry.path);
        if (IGNORED.test(p) || !paths.some(s=>p===s||p.startsWith(s+'/')||s.startsWith(p+'/'))) continue;
        if (!/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error('Invalid Git object.');
        if (entry.type==='tree') { await walk(entry.sha,p+'/'); continue; }
        if (entry.type!=='blob' || !['100644','100755'].includes(entry.mode)) { skipped.push({path:p,reason:'not a regular file'}); continue; }
        if (Object.keys(files).length+Object.keys(binaries).length >= limits.files || entry.size > limits.fileBytes) throw new Error('Selected repository exceeds file limits. Select fewer paths.');
        const blob = await get(`/git/blobs/${entry.sha}`,Math.ceil(limits.fileBytes*1.5)+4096);
        if (blob.encoding!=='base64' || typeof blob.content!=='string') throw new Error('Unsupported Git blob encoding.');
        const data=Buffer.from(blob.content.replace(/\s/g,''),'base64'); bytes+=data.length;
        if (data.length>limits.fileBytes || bytes>limits.extractedBytes) throw new Error('Selected repository exceeds byte limits.');
        const gitHash=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
        if(gitHash!==entry.sha)throw new Error('GitHub blob integrity check failed.');
        if(data.includes(0)||!Buffer.from(data.toString('utf8')).equals(data)) binaries[p]=data.toString('base64'); else files[p]=data.toString('utf8');
      }
    };
    await walk(commit.commit.tree.sha,'');
    if(!Object.keys(files).length&&!Object.keys(binaries).length)throw new Error('No files matched the selected repository paths.');
    return {repository,source:`${base}/git/commits/${commit.sha} (selected paths)`,commit:commit.sha,files,binaries,skipped,textBytes:Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0),archiveSha256:createHash('sha256').update(JSON.stringify({files,binaries})).digest('hex'),fetchedAt:new Date().toISOString()};
  }
}
