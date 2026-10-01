/**
 * Local provider usage reading.
 *
 * Four things here are easy to get wrong and expensive to get wrong quietly:
 *
 *   1. Codex logs a per-turn DELTA and a running CUMULATIVE total on the same
 *      line. Summing the cumulative one multiplies a session's usage by the
 *      number of turns in it, and the result still looks plausible.
 *   2. The session directories also hold credentials. Nothing here may read
 *      them, and the guarantee is the *.jsonl filter, so it is asserted.
 *   3. The files are append-only and the index reads only new bytes. If the
 *      offset accounting is wrong, appended usage is double-counted or lost.
 *   4. A session being written to right now ends in a partial line, which must
 *      not be parsed until it is complete.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLocalUsage } from '../src/daemon/local-usage.js';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-usage-'));
}

const DAY = '2026-09-09T10:00:00.000Z';

function claudeLine(model: string, usage: Record<string, number>, at = DAY): string {
  return JSON.stringify({ type: 'assistant', timestamp: at, message: { model, usage } });
}

function codexUsageLine(last: Record<string, number>, total: Record<string, number>, at = DAY) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: at,
    payload: { info: { last_token_usage: last, total_token_usage: total } },
  });
}

function codexModelLine(model: string, at = DAY): string {
  return JSON.stringify({ type: 'turn_context', timestamp: at, payload: { model } });
}

/** A home directory with the provider layout the readers expect. */
function makeHome(): { home: string; claudeDir: string; codexDir: string; index: string } {
  const home = scratch();
  const claudeDir = path.join(home, '.claude', 'projects', 'proj');
  const codexDir = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  return { home, claudeDir, codexDir, index: path.join(home, 'index.json') };
}

const run = (home: string, index: string) =>
  collectLocalUsage({ indexPath: index, home, windowDays: 3650 });

describe('Claude Code sessions', () => {
  test('sums per-turn usage by model and day', () => {
    const { home, claudeDir, index } = makeHome();
    fs.writeFileSync(
      path.join(claudeDir, 'a.jsonl'),
      [
        claudeLine('claude-opus-5', {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        }),
        claudeLine('claude-opus-5', { input_tokens: 1, output_tokens: 2 }),
      ].join('\n') + '\n'
    );

    const report = run(home, index);
    const claude = report.providers.find((p) => p.id === 'claude-code');
    assert.ok(claude, 'the Claude provider should be present');
    const model = claude.models['claude-opus-5'];
    assert.equal(model.input, 11);
    assert.equal(model.output, 7);
    assert.equal(model.cacheRead, 100);
    assert.equal(model.cacheWrite, 20);
    assert.equal(model.total, 138);
  });

  test('ignores lines that carry no usage', () => {
    const { home, claudeDir, index } = makeHome();
    fs.writeFileSync(
      path.join(claudeDir, 'a.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: DAY, message: { content: 'hello' } }),
        'not json at all',
        claudeLine('claude-opus-5', { input_tokens: 3, output_tokens: 1 }),
      ].join('\n') + '\n'
    );

    const report = run(home, index);
    assert.equal(report.providers[0].totals.total, 4);
  });
});

describe('Codex sessions', () => {
  test('sums the per-turn delta, never the cumulative total', () => {
    const { home, codexDir, index } = makeHome();
    // Two turns. The cumulative column reaches 300; the deltas are 100 each.
    fs.writeFileSync(
      path.join(codexDir, 'rollout.jsonl'),
      [
        codexModelLine('gpt-6-astra'),
        codexUsageLine(
          { input_tokens: 100, output_tokens: 0 },
          { input_tokens: 100, output_tokens: 0 }
        ),
        codexUsageLine(
          { input_tokens: 100, output_tokens: 0 },
          { input_tokens: 200, output_tokens: 0 }
        ),
      ].join('\n') + '\n'
    );

    const report = run(home, index);
    const codex = report.providers.find((p) => p.id === 'codex');
    assert.ok(codex);
    // 200, not 300 - the trap this test exists for.
    assert.equal(codex.totals.total, 200);
    assert.equal(codex.models['gpt-6-astra'].total, 200);
  });

  test('attributes usage to the model named earlier in the session', () => {
    const { home, codexDir, index } = makeHome();
    fs.writeFileSync(
      path.join(codexDir, 'r.jsonl'),
      [
        codexModelLine('gpt-5.6-sol'),
        codexUsageLine({ input_tokens: 7, output_tokens: 3 }, { input_tokens: 7, output_tokens: 3 }),
      ].join('\n') + '\n'
    );

    const report = run(home, index);
    assert.ok(report.providers[0].models['gpt-5.6-sol']);
  });
});

describe('the incremental index', () => {
  test('counts appended usage once, not twice', () => {
    const { home, claudeDir, index } = makeHome();
    const file = path.join(claudeDir, 'a.jsonl');
    fs.writeFileSync(file, claudeLine('m', { input_tokens: 10, output_tokens: 0 }) + '\n');

    const first = run(home, index);
    assert.equal(first.providers[0].totals.total, 10);

    fs.appendFileSync(file, claudeLine('m', { input_tokens: 5, output_tokens: 0 }) + '\n');
    const second = run(home, index);

    // 15, not 25 (double-counted) and not 5 (the earlier lines lost).
    assert.equal(second.providers[0].totals.total, 15);
    assert.ok(second.bytesRead > 0, 'the appended bytes should have been read');
  });

  test('reads nothing at all when nothing changed', () => {
    const { home, claudeDir, index } = makeHome();
    fs.writeFileSync(
      path.join(claudeDir, 'a.jsonl'),
      claudeLine('m', { input_tokens: 10, output_tokens: 0 }) + '\n'
    );

    run(home, index);
    const warm = run(home, index);

    assert.equal(warm.bytesRead, 0, 'a warm scan must not re-read unchanged files');
    assert.equal(warm.providers[0].totals.total, 10);
  });

  test('re-reads a file from the start when it shrank', () => {
    const { home, claudeDir, index } = makeHome();
    const file = path.join(claudeDir, 'a.jsonl');
    fs.writeFileSync(
      file,
      [
        claudeLine('m', { input_tokens: 10, output_tokens: 0 }),
        claudeLine('m', { input_tokens: 10, output_tokens: 0 }),
      ].join('\n') + '\n'
    );
    run(home, index);

    // Replaced, not appended to - the stored offset is meaningless now.
    fs.writeFileSync(file, claudeLine('m', { input_tokens: 3, output_tokens: 0 }) + '\n');
    const after = run(home, index);

    assert.equal(after.providers[0].totals.total, 3);
  });

  test('leaves a half-written trailing line for the next scan', () => {
    const { home, claudeDir, index } = makeHome();
    const file = path.join(claudeDir, 'a.jsonl');
    const complete = claudeLine('m', { input_tokens: 10, output_tokens: 0 });
    const partial = claudeLine('m', { input_tokens: 999, output_tokens: 0 }).slice(0, 40);
    fs.writeFileSync(file, complete + '\n' + partial);

    const first = run(home, index);
    assert.equal(first.providers[0].totals.total, 10, 'the fragment must not be parsed');

    // The writer finishes the line.
    fs.writeFileSync(
      file,
      complete + '\n' + claudeLine('m', { input_tokens: 999, output_tokens: 0 }) + '\n'
    );
    const second = run(home, index);
    assert.equal(second.providers[0].totals.total, 1009);
  });
});

describe('what is never read', () => {
  test('credential files in the same directories are not opened', () => {
    const { home, claudeDir, codexDir, index } = makeHome();
    // Real names, in the real places, containing something a leak would show.
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ token: 'SECRET-CLAUDE' })
    );
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ key: 'SECRET-CODEX' }));
    // A non-jsonl file inside the session directory itself.
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ key: 'SECRET-NESTED' }));
    fs.writeFileSync(
      path.join(claudeDir, 'a.jsonl'),
      claudeLine('m', { input_tokens: 1, output_tokens: 0 }) + '\n'
    );

    const report = run(home, index);
    const serialised = JSON.stringify(report);
    assert.ok(!serialised.includes('SECRET'), 'no credential content may reach the report');

    // And the index - which is written to disk - must not hold them either.
    assert.ok(!fs.readFileSync(index, 'utf-8').includes('SECRET'));
  });

  test('says what it could not read rather than omitting it', () => {
    const { home, index } = makeHome();
    const report = run(home, index);
    const ids = report.unavailable.map((u) => u.id);
    assert.ok(ids.includes('subscriptions'), 'plan limits must be declared unavailable');
    for (const item of report.unavailable) {
      assert.ok(item.reason.length > 20, `${item.id} needs a real reason`);
    }
  });
});

describe('the window', () => {
  test('excludes days older than the window', () => {
    const { home, claudeDir, index } = makeHome();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    fs.writeFileSync(
      path.join(claudeDir, 'a.jsonl'),
      [
        claudeLine('m', { input_tokens: 500, output_tokens: 0 }, old),
        claudeLine('m', { input_tokens: 7, output_tokens: 0 }, new Date().toISOString()),
      ].join('\n') + '\n'
    );

    const report = collectLocalUsage({ indexPath: index, home, windowDays: 7 });
    assert.equal(report.providers[0].totals.total, 7);
  });
});
