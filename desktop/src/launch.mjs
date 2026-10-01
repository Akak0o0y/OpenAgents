/**
 * Launcher.
 *
 * ELECTRON_RUN_AS_NODE turns electron.exe into a plain Node binary. Some
 * editors and terminals export it for their own tooling, and inheriting it here
 * means the app "starts" and never opens a window - it just runs main.mjs as a
 * script and exits. Clearing it explicitly is the difference between the app
 * launching and failing in a way with no error message.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) env.OH_DEV = '1';

const passthrough = process.argv.slice(2);

/*
 * A remote debugging port is remote control of the window, for anything on this
 * machine that can open a socket to it - no prompt, no origin check, no record.
 * It is the standard Chrome DevTools endpoint, so automation tools routinely
 * discover one and attach to it without meaning any harm. This window has
 * already been navigated away to an unrelated local project exactly that way.
 *
 * The flag stays available, because inspecting a translucent window from
 * outside it is genuinely useful. It does not stay QUIET. Leaving one open by
 * accident is the failure mode here, and an accident survives a flag but rarely
 * survives being told about it on every single launch.
 *
 * The window also defends itself: see the navigation guard in main.mjs, which
 * puts the app back if anything - including a debugger - points it elsewhere.
 */
const debugFlag = passthrough.find((arg) => arg.startsWith('--remote-debugging-port'));
if (debugFlag) {
  const port = debugFlag.split('=')[1] ?? '(default)';
  const rule = '-'.repeat(70);
  console.warn(
    [
      '',
      rule,
      '  REMOTE DEBUGGING IS ON.',
      '',
      `  Port ${port} accepts DevTools commands from ANY process on this`,
      '  machine. It can run code in this window and read what is on screen.',
      '  Quit the app when you are done, or relaunch without the flag.',
      rule,
      '',
    ].join('\n')
  );
}

const child = spawn(String(electron), [appRoot, ...passthrough], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
