// The bot's files, on the bot's own computer.
//
// Every path is resolved inside the bot home before anything is opened, so no
// operation reaches the rest of the container, and none of it can see the host.
// A shell could do all of this, but shells return text: these return structure,
// and they move bytes in and out without base64 games in a command line.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInHome } from './exec.mjs';

const MAX_READ = 4 * 1024 * 1024;
const MAX_WRITE = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const operations = new Set(['list', 'read', 'write', 'mkdir', 'move', 'remove']);

export function validateFileInput(input) {
  if (!input || !operations.has(input.operation)) {
    throw new Error(`Unknown file operation. Available: ${[...operations].join(', ')}.`);
  }
  if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('Supply a path inside the bot home.');
  if (input.path.includes('\0')) throw new Error('A path may not contain a null byte.');
  const target = resolveInHome(input.path);
  if (input.operation === 'move') {
    if (typeof input.to !== 'string' || !input.to.trim()) throw new Error('Supply a destination path.');
    resolveInHome(input.to);
  }
  if (input.operation === 'write') {
    if (typeof input.content !== 'string') throw new Error('Supply file content as a string.');
    if (input.encoding !== undefined && !['utf8', 'base64'].includes(input.encoding)) throw new Error('Encoding must be utf8 or base64.');
    if (Buffer.byteLength(input.content, input.encoding === 'base64' ? 'base64' : 'utf8') > MAX_WRITE) {
      throw new Error('Files larger than 4 MiB must be written by a command instead.');
    }
  }
  if (input.operation === 'read' && input.encoding !== undefined && !['utf8', 'base64'].includes(input.encoding)) {
    throw new Error('Encoding must be utf8 or base64.');
  }
  if (input.operation === 'remove' && target === resolveInHome('.')) {
    throw new Error('The home directory itself cannot be removed.');
  }
  return target;
}

export async function executeFile(input) {
  const target = validateFileInput(input);
  if (input.operation === 'list') {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const listed = [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      let size, modified;
      // A broken symlink or a file removed mid-listing must not fail the whole listing.
      try {
        const stat = await fs.stat(path.join(target, entry.name));
        size = stat.size; modified = new Date(stat.mtimeMs).toISOString();
      } catch { size = undefined; modified = undefined; }
      listed.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file', size, modified });
    }
    return { path: target, entries: listed, truncated: entries.length > MAX_ENTRIES };
  }
  if (input.operation === 'read') {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) throw new Error('That path is a directory. Use the list operation.');
    if (stat.size > MAX_READ) throw new Error(`The file is ${stat.size} bytes; reading is limited to 4 MiB. Use a command to process it in place.`);
    const bytes = await fs.readFile(target);
    const encoding = input.encoding ?? 'utf8';
    // Returning a binary file as text would hand the model replacement characters
    // and call it the file's contents.
    if (encoding === 'utf8' && bytes.includes(0)) {
      return { path: target, encoding: 'base64', content: bytes.toString('base64'), size: stat.size, note: 'This file is binary, so it was returned as base64.' };
    }
    return { path: target, encoding, content: bytes.toString(encoding), size: stat.size };
  }
  if (input.operation === 'write') {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
    await fs.writeFile(target, bytes);
    return { path: target, written: bytes.length };
  }
  if (input.operation === 'mkdir') {
    await fs.mkdir(target, { recursive: true });
    return { path: target, created: true };
  }
  if (input.operation === 'move') {
    const destination = resolveInHome(input.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(target, destination);
    return { path: target, movedTo: destination };
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory() && input.recursive !== true) {
    throw new Error('That path is a directory. Pass recursive to remove it and everything inside it.');
  }
  await fs.rm(target, { recursive: input.recursive === true, force: false });
  return { path: target, removed: true };
}
