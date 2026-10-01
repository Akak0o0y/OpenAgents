import test from 'node:test';
import assert from 'node:assert/strict';
import { executeComputer, validateComputerInput } from '../../docker/bot-desktop/computer.mjs';

test('native input validates before dispatch and keeps text out of shell commands', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push({ command, args }); return args[0] === 'getdisplaygeometry' ? '1440 900' : ''; };
  for (const input of [{ action: 'exec', text: 'command' }, { action: 'click', x: -1, y: 0 }, { action: 'key', key: 'Return; rm anything' }, { action: 'type', text: 'a\0b' }, { action: 'scroll', direction: 'down', amount: 21 }]) {
    assert.throws(() => validateComputerInput(input));
  }
  assert.equal(calls.length, 0);
  await executeComputer({ action: 'type', text: '$(do not execute); --key Return' }, run);
  assert.deepEqual(calls.at(-1), { command: 'xdotool', args: ['type', '--clearmodifiers', '--delay', '12', '--', '$(do not execute); --key Return'] });
  const count = calls.length;
  await assert.rejects(executeComputer({ action: 'click', x: 1500, y: 20 }, run), /outside/);
  assert.equal(calls.length, count + 1, 'only geometry was queried, no input dispatched');
});

test('drag always releases the mouse even after failure', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    if (args[0] === 'getdisplaygeometry') return '1440 900';
    if (args[0] === 'mousemove' && args[2] === '100') throw new Error('display interrupted');
    return '';
  };
  await assert.rejects(executeComputer({ action: 'drag', x: 20, y: 20, toX: 100, toY: 100 }, run), /interrupted/);
  assert.deepEqual(calls.at(-1), ['mouseup', '1']);
});

test('drag moves the pointer in steps so drop targets see motion', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push(args); return args[0] === 'getdisplaygeometry' ? '1440 900' : ''; };
  await executeComputer({ action: 'drag', x: 20, y: 20, toX: 200, toY: 100 }, run);
  const moves = calls.filter(args => args[0] === 'mousemove').map(args => [Number(args[2]), Number(args[3])]);
  const held = moves.slice(1);
  assert.ok(held.length > 2, `a drag that jumps straight to the target reports no motion, got ${held.length} moves`);
  assert.deepEqual(held.at(-1), [200, 100], 'the drag must still finish on the requested point');
  for (let i = 1; i < held.length; i++) {
    assert.ok(held[i][0] >= held[i - 1][0] && held[i][1] >= held[i - 1][1], 'the pointer must advance toward the target');
  }
  assert.deepEqual(calls.at(-1), ['mouseup', '1']);
});

test('waiting, clipboard and window actions are bounded and shell-safe', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'getdisplaygeometry') return '1440 900';
    if (command === 'wmctrl') return '0x03000007  0 milo  Milo - Google Drive - Google Chrome\n0x04200003  0 milo  Downloads - Thunar\n';
    return '';
  };
  for (const input of [{ action: 'wait', ms: 10 }, { action: 'wait', ms: 99999 }, { action: 'clipboard', text: 'a\0b' },
    { action: 'focus_window', window: '; rm -rf /' }, { action: 'focus_window', window: 'Chrome' }]) {
    assert.throws(() => validateComputerInput(input), `expected ${JSON.stringify(input)} to be refused`);
  }
  validateComputerInput({ action: 'key', key: 'ctrl+minus' });
  validateComputerInput({ action: 'key', key: 'ctrl+shift+bracketleft' });
  assert.throws(() => validateComputerInput({ action: 'key', key: 'ctrl+$(whoami)' }));

  const clipboard = calls.length;
  await executeComputer({ action: 'clipboard', text: '$(do not execute)' }, run);
  const wrote = calls.slice(clipboard).find(entry => entry.command === 'xclip');
  assert.ok(wrote, 'clipboard text must reach xclip');
  assert.ok(!wrote.args.includes('$(do not execute)'), 'clipboard text must travel in a file, never on the command line');

  const listed = await executeComputer({ action: 'windows' }, run);
  assert.deepEqual(listed.windows, [
    { id: '0x03000007', title: 'Milo - Google Drive - Google Chrome' },
    { id: '0x04200003', title: 'Downloads - Thunar' },
  ]);
});
