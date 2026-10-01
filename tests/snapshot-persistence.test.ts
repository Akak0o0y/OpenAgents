import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The page text a run read must outlive the run.
 *
 * BROWSER_STATE kept a URL and a screenshot, so when a run clicked the wrong control there
 * was no record of what it had been looking at. A real failure could not be explained after
 * the fact - not by the operator, and not by anything measuring those decisions later.
 *
 * This is a source-level guard: the emission path needs a live Playwright session to
 * exercise, which tests/browser-tools.test.ts does. What is checked here is that the field
 * is carried and that it is the already-redacted, already-capped string rather than raw
 * page text, because this one goes into durable storage.
 */
// Resolved from the repository root, which is the working directory for npm test, so the
// same path works whether this runs from source or from dist.
const source = readFileSync(path.resolve('src/daemon/browser-tools.ts'), 'utf8');

test('the page text the model read is carried into the browser state event', () => {
  const lastState = source.slice(source.indexOf('s.lastState = {'), source.indexOf('this.emit(s, \'BROWSER_STATE\''));
  assert.match(lastState, /snapshot: \(result as \{ snapshot\?: string \}\)\.snapshot/,
    'BROWSER_STATE must carry the snapshot, or a wrong click cannot be explained afterwards');
  assert.match(source, /lastState\?:[\s\S]{0,400}snapshot\?: string/, 'the type must admit the field');
});

test('what is stored is the redacted, capped string the model saw, not raw page text', () => {
  // One expression produces it: redact() strips typed account details, slice bounds it.
  assert.match(source, /const snapshot = this\.redact\(s, await[\s\S]{0,200}\.slice\(0, 24000\)/,
    'the snapshot handed to the model - and now stored - must stay redacted and bounded');
  // Nothing may store a second, unredacted copy.
  const raw = source.match(/snapshot:\s*await\s/g) ?? [];
  assert.equal(raw.length, 0, 'no unredacted page text may be assigned into a stored field');
});
