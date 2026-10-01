/**
 * Public GitHub repository snapshots: naming, archive policy and bounded text extraction.
 * Archives are built in memory; no network is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepositoryFetcher, archiveUrl, downloadGitHubArchive, extractTarGz, parseRepository, DEFAULT_SNAPSHOT_LIMITS } from '../src/daemon/repository-snapshot.js';

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const COMMIT = 'a'.repeat(40);

test('local aliases snapshot committed content without importing dirty or untracked files', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'oh-local-repo-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
  git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.invalid');
  writeFileSync(path.join(root,'README.md'),'committed'); git('add','README.md'); git('commit','-qm','fixture');
  const commit=git('rev-parse','HEAD').trim();
  writeFileSync(path.join(root,'README.md'),'dirty'); writeFileSync(path.join(root,'secret.txt'),'untracked');
  const fetcher=new RepositoryFetcher({local:{fixture:root}});
  const snapshot=await fetcher.snapshot(parseRepository('local/fixture'),new AbortController().signal);
  assert.equal(snapshot.commit,commit); assert.deepEqual(snapshot.files,{'README.md':'committed'});
  await assert.rejects(fetcher.snapshot(parseRepository('local/other'),new AbortController().signal),/not been configured/);
});

test('scoped private repository access uses the API archive endpoint without exposing credentials in provenance', async () => {
  const fetcher=new RepositoryFetcher({githubToken:r=>r.owner==='private'?'test-secret':undefined,download:async url=>{
    assert.equal(url,'https://api.github.com/repos/private/repo/tarball/main');
    return archive(entry('pax_global_header',pax(`comment=${COMMIT}`),'g'),entry('repo/README.md','private text'));
  }});
  const snapshot=await fetcher.snapshot(parseRepository('private/repo@main'),new AbortController().signal);
  assert.equal(snapshot.commit,COMMIT); assert(!JSON.stringify(snapshot).includes('test-secret'));
});

function entry(name: string, content: Buffer | string, type = '0'): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644' + NUL, 100);
  header.write(data.length.toString(8).padStart(11, '0') + NUL, 124);
  header.write(type, 156);
  header.write('ustar' + NUL + '00', 257);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const pax = (record: string) => { const body = ` ${record}${LF}`; let length = body.length; length += String(length + String(length).length).length; return `${length}${body}`; };
const archive = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

test('repository names, refs and GitHub URLs parse to an exact owner, repository and ref', () => {
  assert.deepEqual(parseRepository('octocat/Hello-World'), { owner: 'octocat', repo: 'Hello-World', ref: 'HEAD' });
  assert.deepEqual(parseRepository('owner/repo@v1.2.3'), { owner: 'owner', repo: 'repo', ref: 'v1.2.3' });
  assert.deepEqual(parseRepository('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', ref: 'HEAD' });
  assert.deepEqual(parseRepository('https://github.com/owner/repo/issues/12'), { owner: 'owner', repo: 'repo', ref: 'HEAD' });
  assert.deepEqual(parseRepository('https://github.com/owner/repo/tree/release/2.x'), { owner: 'owner', repo: 'repo', ref: 'release/2.x' });
  for (const bad of ['owner', 'https://gitlab.com/owner/repo', 'owner/re po', 'owner/repo@../main', '../owner/repo', 'http://github.com/owner/repo']) {
    assert.throws(() => parseRepository(bad), /GitHub repository/, bad);
  }
  assert.equal(archiveUrl({ owner: 'owner', repo: 'repo', ref: 'release/2.x' }), 'https://codeload.github.com/owner/repo/tar.gz/release/2.x');
});

test('extraction keeps bounded UTF-8 text, records every skipped entry and captures the archive commit', () => {
  const longPath = `repo-${COMMIT.slice(0, 7)}/src/${'deep/'.repeat(25)}module.js`;
  const result = extractTarGz(archive(
    entry('pax_global_header', pax(`comment=${COMMIT}`), 'g'),
    entry(`repo-${COMMIT.slice(0, 7)}/`, '', '5'),
    entry(`repo-${COMMIT.slice(0, 7)}/README.md`, '# Project' + LF),
    entry(`repo-${COMMIT.slice(0, 7)}/src/index.js`, 'export const answer = 42;' + LF),
    entry('PaxHeader', pax(`path=${longPath}`), 'x'),
    entry('repo-abcdefg/src/placeholder-name.js', 'export default "long";' + LF),
    entry(`repo-${COMMIT.slice(0, 7)}/logo.png`, Buffer.from([137, 80, 78, 71, 0, 1, 2])),
    entry(`repo-${COMMIT.slice(0, 7)}/big.txt`, 'x'.repeat(DEFAULT_SNAPSHOT_LIMITS.fileBytes + 1)),
    entry(`repo-${COMMIT.slice(0, 7)}/node_modules/dep/index.js`, 'module.exports = 1;'),
    entry(`repo-${COMMIT.slice(0, 7)}/link`, '', '2'),
    entry(`repo-${COMMIT.slice(0, 7)}/latin1.txt`, Buffer.from([0x63, 0x61, 0x66, 0xe9])),
  ));
  assert.equal(result.commit, COMMIT);
  assert.deepEqual(Object.keys(result.files).sort(), ['README.md', 'src/index.js', longPath.split('/').slice(1).join('/')].sort());
  assert.equal(result.files['src/index.js'], 'export const answer = 42;' + LF);
  assert.deepEqual(result.skipped.map(s => [s.path, s.reason]), [
    ['logo.png', 'binary'], ['big.txt', 'larger than 256 KiB'], ['node_modules/dep/index.js', 'dependency or tool folder'],
    ['link', 'symbolic link'], ['latin1.txt', 'not UTF-8 text']]);
  assert.equal(result.textBytes, Buffer.byteLength('# Project' + LF) + Buffer.byteLength('export const answer = 42;' + LF) + Buffer.byteLength('export default "long";' + LF));
});

test('unsafe paths, file-count limits, oversized expansion, truncation and non-gzip input are refused or recorded', () => {
  const unsafe = extractTarGz(archive(entry('repo-x/../evil.js', 'bad'), entry('repo-x/ok.js', 'ok')));
  assert.deepEqual(Object.keys(unsafe.files), ['ok.js']);
  assert.equal(unsafe.skipped[0].reason, 'unsupported path');

  const counted = extractTarGz(archive(entry('repo-x/a.js', 'a'), entry('repo-x/b.js', 'b'), entry('repo-x/c.js', 'c')), { ...DEFAULT_SNAPSHOT_LIMITS, files: 2 });
  assert.deepEqual(Object.keys(counted.files), ['a.js', 'b.js']);
  assert.deepEqual(counted.skipped, [{ path: 'c.js', reason: 'more than 2 text files' }]);

  const bomb = gzipSync(Buffer.concat([entry('repo-x/zeros.txt', Buffer.alloc(3 * 1024 * 1024, 32)), Buffer.alloc(1024)]));
  assert.throws(() => extractTarGz(bomb, { ...DEFAULT_SNAPSHOT_LIMITS, extractedBytes: 1024 * 1024 }), /extracted repository exceeds the 1 MiB limit/);

  const full = Buffer.concat([entry('repo-x/file.js', 'y'.repeat(2000)), Buffer.alloc(1024)]);
  assert.throws(() => extractTarGz(gzipSync(full.subarray(0, 1024))), /truncated/);
  assert.throws(() => extractTarGz(Buffer.from('not gzip')), /not a valid gzip file/);
});

test('snapshots request the exact GitHub archive, record its hash and refuse empty or oversized archives', async () => {
  const requested: Array<[string, number]> = [];
  const body = archive(entry('pax_global_header', pax(`comment=${COMMIT}`), 'g'), entry('repo-x/src/index.js', 'export {};' + LF));
  const fetcher = new RepositoryFetcher({ download: async (url, _signal, maxBytes) => { requested.push([url, maxBytes]); return body; } });
  const snapshot = await fetcher.snapshot(parseRepository('owner/repo@main'), new AbortController().signal);
  assert.deepEqual(requested, [['https://codeload.github.com/owner/repo/tar.gz/main', 64 * 1024 * 1024]]);
  assert.equal(snapshot.commit, COMMIT);
  assert.match(snapshot.archiveSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(snapshot.files), ['src/index.js']);

  const empty = new RepositoryFetcher({ download: async () => archive(entry('repo-x/logo.png', Buffer.from([0, 1, 2]))) });
  assert.equal((await empty.snapshot(parseRepository('owner/repo'), new AbortController().signal)).binaries?.['logo.png'],'AAEC');
  const huge = new RepositoryFetcher({ download: async () => Buffer.alloc(2048), limits: { archiveBytes: 1024 } });
  await assert.rejects(huge.snapshot(parseRepository('owner/repo'), new AbortController().signal), /exceeds the 0 MiB limit|archive exceeds/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(new RepositoryFetcher({ download: async () => body }).snapshot(parseRepository('owner/repo'), cancelled.signal));
});

test('archive downloads are refused before any network access unless they are HTTPS to GitHub hosts', async () => {
  const signal = new AbortController().signal;
  for (const url of ['http://codeload.github.com/o/r/tar.gz/HEAD', 'https://example.com/o/r.tar.gz', 'https://user:pass@codeload.github.com/o/r/tar.gz/HEAD', 'https://codeload.github.com:8443/o/r/tar.gz/HEAD', 'https://127.0.0.1/o/r.tar.gz']) {
    await assert.rejects(downloadGitHubArchive(url, signal, 1024), /only from GitHub over HTTPS/, url);
  }
});
