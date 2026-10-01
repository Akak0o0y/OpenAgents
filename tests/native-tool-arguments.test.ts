/**
 * A provider can return a native tool call whose arguments are not valid JSON. Substituting an
 * empty argument object would dispatch a different action from the one the model chose, and the
 * model would then be told its action was invalid rather than that its arguments never arrived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolCallAsAction, ProviderCallError } from '../src/evals/llm-client.js';

test('a native tool call becomes the JSON action the runtime expects', () => {
  assert.equal(
    nativeToolCallAsAction({ name: 'browser', arguments: '{"action":"navigate","url":"https://example.com"}' }, 'fixture-model'),
    JSON.stringify({ action: 'navigate', url: 'https://example.com', tool: 'browser' }),
  );
  assert.equal(nativeToolCallAsAction({ name: 'verify', arguments: '' }, 'fixture-model'), JSON.stringify({ tool: 'verify' }),
    'a tool that takes no arguments is still a valid action');
  assert.equal(nativeToolCallAsAction({ name: 'browser', arguments: '[1,2]' }, 'fixture-model'), undefined,
    'a non-object argument payload is not turned into an action');
});

test('unparseable tool arguments are reported instead of silently dropped', () => {
  assert.throws(
    () => nativeToolCallAsAction({ name: 'browser', arguments: '{"action":"navigate",' }, 'fixture-model'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCallError, 'a malformed provider response raises a provider error');
      assert.equal((error as ProviderCallError).code, 'INVALID_RESPONSE');
      assert.match((error as Error).message, /browser tool call whose arguments are not valid JSON/);
      assert.match((error as Error).message, /No action was executed/);
      return true;
    },
  );
});
