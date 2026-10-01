/**
 * Sound and screen size on the bot's own desktop.
 *
 * The container has no sound card and its screen size comes from the VNC server, so both
 * are synthesised here. What matters is that asking for something unavailable is refused
 * rather than quietly producing a silent video or a screen that never changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-media-'));
process.env.HOME = home;
process.env.DISPLAY = ':1';
const { audioAvailable, startRecording, stopRecording } = await import('../../docker/bot-desktop/recorder.mjs');
const { validateDisplayInput, displaySet, displayGet } = await import('../../docker/bot-desktop/display.mjs');

/** What `xrandr --query` prints: an output, then the sizes it will accept. */
const QUERY = [
  'Screen 0: minimum 32 x 32, current 1440 x 900, maximum 32768 x 32768',
  'VNC-0 connected 1440x900+0+0 0mm x 0mm',
  '   1440x900      60.00*+',
  '   1280x720      60.00  ',
  '   800x600       60.00  ',
  '',
].join('\n');

test('sound is reported present only when the sink actually exists', () => {
  assert.equal(audioAvailable(() => '0\talsa_output.monitor\tmodule\ts16le\n'), false);
  assert.equal(audioAvailable(() => '0\topenhours.monitor\tmodule-null-sink\ts16le\n'), true);
  // pactl missing entirely is a silent desktop, not a crash.
  assert.equal(audioAvailable(() => { throw new Error('pactl: not found'); }), false);
});

test('recording with sound feeds the sink and takes it away again', async () => {
  const spawned = [];
  const fake = (file, args) => {
    const child = new EventEmitter();
    spawned.push({ file, args, child });
    child.pid = 5000 + spawned.length;
    child.exitCode = null; child.signalCode = null;
    child.stderr = Readable.from([]);
    child.kill = () => { child.exitCode = 0; child.killed = true; child.emit('exit', 0, null); return true; };
    return child;
  };
  await startRecording({ maxSeconds: 20, fps: 10, audio: true }, fake, () => true);
  const silence = spawned.find(s => s.file === 'pacat');
  const ffmpeg = spawned.find(s => s.file === 'ffmpeg');
  // An idle PulseAudio sink emits nothing, so a recorder reading its monitor starved and
  // wrote a 262-byte header with no frames. Measured in a container.
  assert.ok(silence, 'silence must be fed while recording or the monitor yields nothing');
  assert.ok(ffmpeg.args.includes('openhours.monitor'), 'the recording must read the sink monitor');
  assert.ok(ffmpeg.args.includes('aac'), 'an audio codec must be selected');
  // The fake writes no file, so the stop reports no usable video - the guard working.
  // What matters here is that the feeder was taken away regardless.
  await stopRecording().catch(() => undefined);
  assert.equal(silence.child.killed, true, 'the feeder must not outlive the recording that started it');
});

test('recording refuses sound this desktop cannot provide', async () => {
  await assert.rejects(
    startRecording({ audio: true }, () => { throw new Error('should never spawn'); }, () => false),
    /no working sound device/,
  );
});

test('a screen size is refused unless it can actually be encoded', () => {
  for (const bad of [
    { operation: 'set', width: 1920 },
    { operation: 'set', width: 100, height: 100 },
    { operation: 'set', width: 9000, height: 1080 },
    // Odd dimensions break yuv420p, so a later recording would fail for a reason that
    // looks unrelated to the resize that caused it.
    { operation: 'set', width: 1921, height: 1080 },
    { operation: 'set', width: 1920, height: 1081 },
    { operation: 'resize', width: 1920, height: 1080 },
  ]) assert.throws(() => validateDisplayInput(bad), `expected ${JSON.stringify(bad)} to be refused`);
  validateDisplayInput({ operation: 'set', width: 1920, height: 1080 });
  validateDisplayInput({ operation: 'get' });
});

test('resizing selects a size the display actually offers', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'xrandr') return QUERY;
    if (command === 'xdotool') return '1280 720\n';
    return '';
  };
  const result = await displaySet({ width: 1280, height: 720 }, exec);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.output, 'VNC-0');
  assert.ok(calls.includes('xrandr --output VNC-0 --mode 1280x720'), `got ${JSON.stringify(calls)}`);
});

test('a size the display does not offer is refused with the sizes it does', async () => {
  const exec = async (command) => (command === 'xrandr' ? QUERY : '1440 900\n');
  await assert.rejects(displaySet({ width: 1234, height: 722 }, exec), /does not offer 1234x722/);
  await assert.rejects(displaySet({ width: 1234, height: 722 }, exec), /1440x900, 1280x720, 800x600/);
});

test('a resize that did not take effect is reported, not assumed', async () => {
  const exec = async (command) => (command === 'xrandr' ? QUERY : '1440 900\n'); // the server ignored it
  await assert.rejects(displaySet({ width: 1280, height: 720 }, exec), /did not resize: it is still 1440x900/);
});

test('reading the size asks the display and lists what it will accept', async () => {
  const exec = async (command) => (command === 'xrandr' ? QUERY : '1440 900\n');
  assert.deepEqual(await displayGet(exec), { width: 1440, height: 900, available: ['1440x900', '1280x720', '800x600'] });
});

test.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
