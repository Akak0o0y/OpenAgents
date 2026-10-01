// The size of the bot's own screen.
//
// A person resizes a window or changes resolution constantly; the desktop was fixed at
// whatever it started with. Sites lay out differently at different widths, and a bot that
// cannot change its screen cannot see what a person on a narrower one would see.
//
// The VNC server already publishes a list of standard modes, so resizing selects one of
// those. An earlier version generated a timing line with `cvt`, which is not installed
// here - x11-xserver-utils ships only xrandr - and would have been a large dependency to
// add for something the server can already do.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const exec = async (command, args) =>
  (await run(command, args, { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':1' } })).stdout;

export function validateDisplayInput(input) {
  if (!input || !['get', 'set'].includes(input.operation)) throw new Error('Unknown display operation. Use get or set.');
  if (input.operation !== 'set') return;
  for (const [name, value] of [['width', input.width], ['height', input.height]]) {
    if (!Number.isInteger(value) || value < 320 || value > 7680) throw new Error(`Supply ${name} between 320 and 7680.`);
  }
  // An odd dimension breaks yuv420p encoding, so a later recording of this screen would
  // fail with something that looks unrelated to the resize that caused it.
  if (input.width % 2 || input.height % 2) throw new Error('Width and height must both be even numbers.');
}

/** The connected output and the sizes it will accept, read from the server itself. */
async function outputModes(execFn) {
  const query = String(await execFn('xrandr', ['--query'])).split('\n');
  const index = query.findIndex(row => / connected/.test(row));
  if (index < 0) throw new Error('This display reports no connected output, so it cannot be resized.');
  const output = query[index].split(/\s+/)[0];
  const modes = [];
  for (const row of query.slice(index + 1)) {
    if (/ connected| disconnected/.test(row)) break;
    const match = /^\s+(\d{3,5})x(\d{3,5})\s/.exec(row);
    if (match) modes.push({ width: Number(match[1]), height: Number(match[2]) });
  }
  return { output, modes };
}

export async function displayGet(execFn = exec) {
  const geometry = String(await execFn('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
  const available = await outputModes(execFn).then(r => r.modes).catch(() => []);
  return { width: geometry[0], height: geometry[1], available: available.map(m => `${m.width}x${m.height}`) };
}

export async function displaySet(input, execFn = exec) {
  validateDisplayInput({ ...input, operation: 'set' });
  const { width, height } = input;
  const { output, modes } = await outputModes(execFn);
  if (!modes.some(m => m.width === width && m.height === height)) {
    throw new Error(`This display does not offer ${width}x${height}. Available sizes: ${modes.map(m => `${m.width}x${m.height}`).join(', ') || 'none reported'}.`);
  }
  await execFn('xrandr', ['--output', output, '--mode', `${width}x${height}`]);
  const now = await displayGet(execFn);
  if (now.width !== width || now.height !== height) {
    throw new Error(`The display did not resize: it is still ${now.width}x${now.height}. The viewer may need to reconnect.`);
  }
  return { ...now, output };
}

export function executeDisplay(input, execFn = exec) {
  validateDisplayInput(input);
  return input.operation === 'get' ? displayGet(execFn) : displaySet(input, execFn);
}
