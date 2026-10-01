/**
 * The release gate reads suite totals from runner output. A parser that silently degrades turns a
 * real total into "unreadable", and an unreadable total once looked exactly like a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText, counts, failureNames, NODE_TOTAL, FAILURE_MARK } from '../../scripts/lib/suite-output.mjs';

const ESCAPE = String.fromCharCode(27);
const CR = String.fromCharCode(13);

test('node --test totals survive colour and carriage returns', () => {
  const raw = [`${NODE_TOTAL} tests 34`, `${NODE_TOTAL} pass 32`, `${NODE_TOTAL} fail 2`].join(CR + '\n') + CR + '\n';
  assert.deepEqual(counts(plainText(raw)), { pass: 32, fail: 2 });
  const coloured = `${ESCAPE}[32m${NODE_TOTAL} pass 7${ESCAPE}[39m\n${NODE_TOTAL} fail 0\n`;
  assert.deepEqual(counts(plainText(coloured)), { pass: 7, fail: 0 });
});

test('vitest totals are read through its colour codes', () => {
  const raw = ` ${ESCAPE}[2m Tests ${ESCAPE}[22m ${ESCAPE}[1m${ESCAPE}[32m344 passed${ESCAPE}[39m${ESCAPE}[22m (344)\n`;
  assert.deepEqual(counts(plainText(raw)), { pass: 344, fail: 0 });
  const failing = ` Tests  ${ESCAPE}[31m3 failed${ESCAPE}[39m | ${ESCAPE}[32m12 passed${ESCAPE}[39m (15)\n`;
  assert.deepEqual(counts(plainText(failing)), { pass: 12, fail: 3 });
});

test('output that states no totals is unreadable, never zero', () => {
  assert.deepEqual(counts(plainText('built fine, nothing to report\n')), { pass: NaN, fail: NaN });
  assert.ok(Number.isNaN(counts('').pass), 'empty output cannot be mistaken for a passing run');
});

test('failing test names drop their durations and the summary heading', () => {
  const raw = [
    `${FAILURE_MARK} DockerSandbox: path traversal rejection guards the host (60070.1099ms)`,
    `${FAILURE_MARK} failing tests:`,
    `${FAILURE_MARK} DockerSandbox: path traversal rejection guards the host (60070.1099ms)`,
    `  ${FAILURE_MARK} availableTools filters tools according to context flags (15.8332ms)`,
  ].join('\n');
  assert.deepEqual(failureNames(plainText(raw)), [
    'DockerSandbox: path traversal rejection guards the host',
    'availableTools filters tools according to context flags',
  ], 'names are de-duplicated across the run and its summary');
});
