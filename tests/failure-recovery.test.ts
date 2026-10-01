import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryInstruction, stopMessage, parseFailureReason } from '../src/daemon/failure-recovery.js';
import { parseStructuredAction } from '../src/daemon/work-actions.js';

test('a reply that could not be parsed says what to do instead of naming the symptom', () => {
  // The run that prompted this sent sixty-line python scripts inside the action.
  const oversized = '{"tool":"desktop_run","command":"python3 -c \'\nimport socket, json\nprint("x")\n';
  const reason = parseFailureReason(oversized);
  assert.match(reason, /desktop_files/, 'it must name the route that works');
  assert.match(reason, /desktop_run/);
  assert.doesNotMatch(reason, /^The response did not contain one complete JSON action object\.$/);

  assert.match(parseFailureReason('I will now open the browser and look at the page.'), /no JSON action object/);
  assert.match(parseFailureReason('{"tool":"browser","action":"snapshot"'), /never closed it/);
});

test('the parser reports the actionable reason, not the bare symptom', () => {
  try {
    parseStructuredAction('here is what I think, with no action at all');
    assert.fail('expected a parse failure');
  } catch (error) {
    assert.match(String((error as Error).message), /Reply with exactly one JSON object/);
  }
});

test('recovery names the obstacle, forbids repeating it, and offers a route out', () => {
  const seen = [
    'The response did not contain one complete JSON action object.',
    'Browser target is missing, blocked or not usable for this action. Take a fresh snapshot and choose the current control; no interaction was dispatched.',
  ];
  const instruction = recoveryInstruction(seen);
  assert.match(instruction, /Three actions in a row failed/);
  assert.match(instruction, /Repeating any of them will fail the same way/);
  assert.match(instruction, /desktop_files/, 'the JSON failure must carry its concrete fix');
  assert.match(instruction, /snapshot/, 'the stale-ref failure must carry its concrete fix');
  // Giving up silently is exactly what the operator objected to.
  assert.match(instruction, /"tool":"block"/);
  assert.match(instruction, /ask_user_question/);
});

test('an uninstalled program is diagnosed rather than repeated', () => {
  const instruction = recoveryInstruction(['The command finished with exit status 127 on this bot\'s computer.']);
  assert.match(instruction, /not installed/);
  assert.match(instruction, /command -v/);
  // The run that prompted this hand-wrote a raw WebSocket client because no library was
  // present. It can install one now, and the guidance has to say so.
  assert.match(instruction, /pip install --user/);
  assert.match(instruction, /npm install -g/);
  assert.match(instruction, /Do not hand-write a protocol client/);
});

test('the final stop message carries the diagnosis, not a pointer to the logs', () => {
  const message = stopMessage([
    'The response did not contain one complete JSON action object.',
    'The response did not contain one complete JSON action object.',
    'Browser target is missing, blocked or not usable for this action.',
  ]);
  assert.match(message, /change of approach did not resolve/);
  assert.match(message, /one complete JSON action object/, 'the operator must see what actually failed');
  assert.match(message, /Browser target is missing/);
  // The duplicate is collapsed rather than repeated three times.
  assert.equal(message.match(/one complete JSON action object/g)?.length, 1);
  assert.doesNotMatch(message, /Review the recorded tool results/);
});

test('with no recorded errors the stop message still reads as a sentence', () => {
  assert.match(stopMessage([]), /Stopped after repeated failed actions/);
  assert.doesNotMatch(stopMessage(['', '  ']), /: $/);
});
