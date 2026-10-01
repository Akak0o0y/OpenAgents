import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
// The locale is named here as well as in the image because xdotool rejects every
// multi-byte character without it - typing Arabic failed with "Invalid multi-byte
// sequence encountered" - and that is too quiet a failure to leave to one place.
const run = async (command, args) => (await execute(command, args, {
  timeout: 10000, maxBuffer: 1024 * 1024,
  env: { ...process.env, DISPLAY: ':1', LANG: process.env.LANG ?? 'C.UTF-8', LC_ALL: process.env.LC_ALL ?? 'C.UTF-8' },
})).stdout;
const actions = new Set(['screenshot', 'click', 'double_click', 'right_click', 'middle_click', 'move', 'drag',
  'scroll', 'type', 'key', 'wait', 'clipboard', 'paste', 'windows', 'focus_window']);
// Punctuation was missing, so the bot could not press ctrl+minus, reach a menu
// accelerator, or send a bracket through a shortcut.
const keys = /^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Escape|Tab|space|BackSpace|Delete|Insert|Menu|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|minus|plus|equal|underscore|comma|period|slash|backslash|semicolon|colon|apostrophe|quotedbl|bracketleft|bracketright|grave|asciitilde|exclam|at|numbersign|dollar|percent|asciicircum|ampersand|asterisk|parenleft|parenright)$/;
const windowId = /^0x[0-9a-fA-F]{1,16}$/;

export function validateComputerInput(input) {
  if (!input || !actions.has(input.action)) throw new Error('Unknown computer action.');
  const point = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 8192 && y < 8192;
  if (['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag'].includes(input.action) && !point(input.x, input.y)) throw new Error('Supply desktop pixel coordinates.');
  if (input.action === 'drag' && !point(input.toX, input.toY)) throw new Error('Supply drag destination coordinates.');
  if (input.action === 'type' && (typeof input.text !== 'string' || input.text.length > 8000 || input.text.includes('\0'))) throw new Error('Supply text up to 8000 characters.');
  if (input.action === 'key' && (typeof input.key !== 'string' || !keys.test(input.key))) throw new Error('Supply a supported key combination.');
  if (input.action === 'scroll' && (!['up', 'down', 'left', 'right'].includes(input.direction) || !Number.isInteger(input.amount ?? 3) || (input.amount ?? 3) < 1 || (input.amount ?? 3) > 20)) throw new Error('Supply scroll direction and amount (1-20).');
  // Waiting is an action so the bot can let a page settle instead of screenshotting
  // into a half-drawn state and then clicking what it thought it saw.
  if (input.action === 'wait' && (!Number.isInteger(input.ms) || input.ms < 50 || input.ms > 10000)) throw new Error('Supply a wait in milliseconds (50-10000).');
  if (input.action === 'clipboard' && (typeof input.text !== 'string' || input.text.length > 8000 || input.text.includes('\0'))) throw new Error('Supply clipboard text up to 8000 characters.');
  if (input.action === 'focus_window' && !windowId.test(String(input.window ?? ''))) throw new Error('Supply a window id from the windows action.');
}

/** Fixed executables and argument arrays only; no shell or model-supplied command. */
export async function executeComputer(input, command = run, onDispatch = () => {}) {
  validateComputerInput(input);
  const [width, height] = String(await command('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Display is unavailable.');
  for (const [x, y] of [[input.x, input.y], [input.toX, input.toY]]) {
    if (x !== undefined && (x >= width || y >= height)) throw new Error('Coordinates are outside the observed display.');
  }
  // Observing the desktop is not an external effect, so a failure to read it never
  // leaves an action's outcome uncertain.
  if (!['screenshot', 'windows', 'wait'].includes(input.action)) onDispatch();
  const pointer = ['mousemove', '--sync', String(input.x), String(input.y)];
  if (['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag'].includes(input.action)) await command('xdotool', pointer);
  if (['click', 'right_click', 'middle_click'].includes(input.action)) {
    await command('xdotool', ['click', input.action === 'click' ? '1' : input.action === 'middle_click' ? '2' : '3']);
  }
  if (input.action === 'double_click') await command('xdotool', ['click', '--repeat', '2', '--delay', '100', '1']);
  if (input.action === 'drag') {
    try {
      await command('xdotool', ['mousedown', '1']);
      // Jumping straight from press to release produces no motion events, which most
      // toolkits and every HTML5 drop target ignore, so the pointer travels in steps.
      for (let step = 1; step <= 12; step++) {
        await command('xdotool', ['mousemove', '--sync',
          String(Math.round(input.x + ((input.toX - input.x) * step) / 12)),
          String(Math.round(input.y + ((input.toY - input.y) * step) / 12))]);
      }
    } finally { await command('xdotool', ['mouseup', '1']); }
  }
  if (input.action === 'scroll') await command('xdotool', ['click', '--repeat', String(input.amount ?? 3), '--delay', '60', String({ up: 4, down: 5, left: 6, right: 7 }[input.direction])]);
  // Typing with no delay outruns web applications, which drop characters from the
  // middle of a value and leave a field holding something the bot never sent.
  if (input.action === 'type') await command('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', input.text]);
  if (input.action === 'key') await command('xdotool', ['key', '--clearmodifiers', input.key]);
  if (input.action === 'wait') await new Promise(resolve => setTimeout(resolve, input.ms));
  if (input.action === 'paste') await command('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
  if (input.action === 'clipboard') {
    // xclip reads the text from a file, so it never appears on a command line.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-clip-'));
    const file = path.join(directory, 'clip.txt');
    try { await fs.writeFile(file, input.text, 'utf8'); await command('xclip', ['-selection', 'clipboard', '-i', file]); }
    finally { await fs.unlink(file).catch(() => {}); await fs.rmdir(directory).catch(() => {}); }
  }
  let windows;
  if (input.action === 'windows') {
    // Without a window list the bot cannot tell what has focus, so it clicks into
    // whatever happens to be on top and reports the result of the wrong application.
    windows = String(await command('wmctrl', ['-l'])).split('\n')
      .map(line => /^(0x[0-9a-fA-F]+)\s+\S+\s+\S+\s+(.*)$/.exec(line.trim()))
      .filter(match => match)
      .map(match => ({ id: match[1], title: match[2] }));
  }
  if (input.action === 'focus_window') await command('wmctrl', ['-i', '-a', String(input.window)]);
  return windows ? { width, height, windows } : { width, height };
}

export async function captureDesktop() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-screen-'));
  const file = path.join(directory, 'screen.png');
  try {
    await run('scrot', ['--overwrite', file]);
    const bytes = await fs.readFile(file);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Desktop capture is too large.');
    return bytes.toString('base64');
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory);
  }
}
