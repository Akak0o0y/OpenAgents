/**
 * Attachment handling.
 *
 * A chat turn here is a text completion, so an attachment is inlined text and
 * nothing else. These tests pin the refusals, because each one exists to stop a
 * specific waste: a binary file becoming prompt-token noise the operator pays
 * for, or a huge file doing the same at scale.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  composeWithAttachments,
  formatBytes,
  looksTextual,
  readAttachments,
} from './attachments.js';

function file(name: string, content: string, type = ''): File {
  return new File([content], name, { type });
}

describe('looksTextual', () => {
  it('accepts files a browser reports as text', () => {
    expect(looksTextual(file('a.txt', 'x', 'text/plain'))).toBe(true);
    expect(looksTextual(file('a.json', '{}', 'application/json'))).toBe(true);
  });

  it('accepts source files the browser reports with no type at all', () => {
    // Browsers routinely report '' for .ts, .rs, .toml and friends, which is
    // why the extension allowlist exists.
    for (const name of ['a.ts', 'b.rs', 'c.toml', 'd.yaml', 'e.py', 'f.sql']) {
      expect(looksTextual(file(name, 'x')), name).toBe(true);
    }
  });

  it('rejects binaries', () => {
    expect(looksTextual(file('a.png', 'x', 'image/png'))).toBe(false);
    expect(looksTextual(file('a.pdf', 'x', 'application/pdf'))).toBe(false);
    expect(looksTextual(file('a.zip', 'x'))).toBe(false);
  });
});

describe('readAttachments', () => {
  it('reads a text file into an attachment', async () => {
    const { attachments, rejected } = await readAttachments([file('notes.md', '# Hi', 'text/markdown')]);
    expect(rejected).toHaveLength(0);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('notes.md');
    expect(attachments[0].content).toBe('# Hi');
  });

  it('rejects a binary and says why it cannot be sent', async () => {
    const { attachments, rejected } = await readAttachments([file('logo.png', 'x', 'image/png')]);
    expect(attachments).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/binary upload service/);
  });

  it('rejects an oversized file with both sizes in the message', async () => {
    const big = file('big.txt', 'a'.repeat(MAX_ATTACHMENT_BYTES + 10), 'text/plain');
    const { attachments, rejected } = await readAttachments([big]);
    expect(attachments).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/over the 64 KB limit/);
    expect(rejected[0].reason).toMatch(/prompt tokens you pay for/);
  });

  it('attaches what it can and reports only what it refused', async () => {
    const { attachments, rejected } = await readAttachments([
      file('a.txt', 'one', 'text/plain'),
      file('b.png', 'two', 'image/png'),
      file('c.md', 'three', 'text/markdown'),
    ]);
    expect(attachments.map((a) => a.name)).toEqual(['a.txt', 'c.md']);
    expect(rejected.map((r) => r.name)).toEqual(['b.png']);
  });

  it('enforces the per-message cap, counting what is already attached', async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) =>
      file(`f${i}.txt`, 'x', 'text/plain')
    );
    const fresh = await readAttachments(files);
    expect(fresh.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(fresh.rejected[0].reason).toMatch(/at most 4 files/);

    const topUp = await readAttachments([file('extra.txt', 'x', 'text/plain')], MAX_ATTACHMENTS);
    expect(topUp.attachments).toHaveLength(0);
    expect(topUp.rejected).toHaveLength(1);
  });
});

describe('composeWithAttachments', () => {
  it('returns the text unchanged when nothing is attached', () => {
    expect(composeWithAttachments('hello', [])).toBe('hello');
  });

  it('fences and labels each file so the bot can tell them apart', () => {
    const result = composeWithAttachments('look at this', [
      { id: '1', name: 'a.txt', bytes: 3, content: 'one' },
    ]);
    expect(result).toContain('look at this');
    expect(result).toContain('Attached file: a.txt (3 B)');
    expect(result).toContain('```\none\n```');
  });

  it('sends the files alone when there is no message text', () => {
    const result = composeWithAttachments('   ', [{ id: '1', name: 'a.txt', bytes: 3, content: 'one' }]);
    expect(result.startsWith('Attached file: a.txt')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('scales the unit to the size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
