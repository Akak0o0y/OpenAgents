#!/usr/bin/env node
/**
 * Cut a release into the publish folder.
 *
 * The whole chain, so "ship the new version" is one command rather than a
 * remembered sequence: compile the daemon, build the interface, regenerate the
 * icon, package the installer and the portable exe, copy them out, checksum
 * them, and rewrite the README so the checksums in it always describe the files
 * beside it.
 *
 * WHY THE README IS GENERATED. A checksum written by hand is a checksum that
 * goes stale on the next build, and a stale one is worse than none: it tells a
 * user the download was tampered with when it was not. It is derived from the
 * files, every time.
 *
 * The publish folder is deliberately OUTSIDE the repository. What ships is not
 * source, and a 113 MB binary has no business in git history.
 *
 * Usage:
 *   node scripts/publish-app.mjs                 # full build, then publish
 *   node scripts/publish-app.mjs --no-build      # publish what is already built
 *   node scripts/publish-app.mjs --to <folder>   # somewhere other than the default
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let releaseDir = path.join(repoRoot, 'desktop', 'release');

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const fromIndex=args.indexOf('--from');
if(fromIndex!==-1){if(!skipBuild||!args[fromIndex+1])throw new Error('--from requires --no-build and an existing package directory.');releaseDir=path.resolve(args[fromIndex+1]);}
const toIndex = args.indexOf('--to');
const publishDir =
  toIndex !== -1 && args[toIndex + 1]
    ? path.resolve(args[toIndex + 1])
    : path.join(os.homedir(), 'Desktop', 'OpenAgents-App');

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;

// ------------------------------------------------------- qualification gate ---
// Delivery requires evidence from the exact build being delivered. A version number is
// reused across builds, so the recorded build identity is what must match. --unqualified
// still publishes and warns on the console, for a deliberate unqualified delivery.
const unqualified = args.includes('--unqualified');
let gateRecord = null;
try { gateRecord = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs', 'validation', 'release-gate.json'), 'utf-8')); } catch { gateRecord = null; }
let candidateBuildId = null;
try {
  const { buildIdentity } = await import(new URL('../dist/src/daemon/build-identity.js', import.meta.url));
  candidateBuildId = buildIdentity(repoRoot);
} catch { candidateBuildId = null; }
const gateMatches = !!gateRecord && gateRecord.qualified === true && !!candidateBuildId && gateRecord.buildId === candidateBuildId;
if (!gateMatches && !unqualified) {
  const reason = !gateRecord ? 'no release-gate record exists'
    : !candidateBuildId ? 'this candidate has no build identity; compile it first'
    : gateRecord.qualified !== true ? `the recorded run did not qualify (${(gateRecord.suites ?? []).filter(s => s.exitCode !== 0).map(s => s.id).join(', ') || 'see record'})`
    : `the record qualifies build ${gateRecord.buildId}, but this candidate is ${candidateBuildId}`;
  console.error(`Refusing to publish: ${reason}.`);
  console.error('Run `node scripts/release-gate.mjs` against this candidate, or pass --unqualified to publish it knowingly.');
  process.exit(1);
}
if (!gateMatches) console.warn('WARNING: publishing without matching qualification evidence (--unqualified).');


// A release script's failures are read by a person deciding what to do next, so
// they print as sentences. Unexpected errors keep their stack.
process.on('uncaughtException', (cause) => {
  if (cause instanceof Error && cause.message.includes('locked by another process')) {
    console.error(`\n${cause.message}\n`);
    process.exit(1);
  }
  throw cause;
});

function run(command, commandArgs) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit', shell: true });
}

// ------------------------------------------------------------------ build ---

if (!skipBuild) {
  run('npm', ['run', 'build']);
  run('npm', ['run', 'web:build']);
  run('npm', ['--prefix', 'desktop', 'run', 'icon']);
  // Windows can hold the previous output open - a shell sitting inside it, or a
  // copy of the app still running. Clearing it first turns a confusing EBUSY
  // half-way through packaging into a clear failure here.
  fs.rmSync(releaseDir, { recursive: true, force: true });
  run('npm', ['--prefix', 'desktop', 'run', 'dist']);
}

// ---------------------------------------------------------------- collect ---

const wanted = [
  { file: `OpenAgents-${version}-setup.exe`, required: true },
  { file: `OpenAgents-${version}-portable.exe`, required: true },
  { file: `OpenAgents-${version}-setup.exe.blockmap`, required: false },
  { file: 'latest.yml', required: false },
];

const missing = wanted.filter((w) => w.required && !fs.existsSync(path.join(releaseDir, w.file)));
if (missing.length > 0) {
  console.error(
    `\nNot built: ${missing.map((m) => m.file).join(', ')}\n` +
      `Looked in ${releaseDir}. Run without --no-build, or check the packaging output.`
  );
  process.exit(1);
}

fs.mkdirSync(publishDir, { recursive: true });

/**
 * Copy, retrying a locked destination.
 *
 * Overwriting an installer that is currently RUNNING - a portable build someone
 * is trying out, an installed copy still open - fails with EBUSY on Windows.
 * That happens often enough while iterating that failing the whole release for
 * it is the wrong behaviour; it is worth a few seconds and then a message that
 * names the actual cause rather than an errno.
 */
function copyWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (cause) {
      const locked = cause.code === 'EBUSY' || cause.code === 'EPERM';
      if (!locked || attempt >= attempts) {
        if (locked) {
          throw new Error(
            `${path.basename(to)} is locked by another process.\n` +
              `  Close any running copy of OpenAgents - including one started from\n` +
              `  the published folder - and run this again.`
          );
        }
        throw cause;
      }
      // Antivirus scanning a freshly written 113 MB binary also lands here, and
      // that clears on its own.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

/** Old versions are left alone - a release folder is a history, not a mirror. */
const copied = [];
for (const { file } of wanted) {
  const from = path.join(releaseDir, file);
  if (!fs.existsSync(from)) continue;
  copyWithRetry(from, path.join(publishDir, file));
  copied.push(file);
}

// --------------------------------------------------------------- checksums ---

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex').toUpperCase();
}

const installers = copied.filter((f) => f.endsWith('.exe'));
const checksums = installers.map((file) => ({
  file,
  hash: sha256(path.join(publishDir, file)),
  mb: (fs.statSync(path.join(publishDir, file)).size / 1024 / 1024).toFixed(0),
}));

// ------------------------------------------------------------------ README ---

const readme = `# OpenAgents ${version} — Windows

A desktop workspace for your own AI bots. The app is self-contained: it needs no
Node.js, no npm and no terminal.

## Which file

| File | Use it when |
| --- | --- |
| \`OpenAgents-${version}-setup.exe\` | You want the app installed — Start Menu entry, desktop shortcut, an uninstaller. Installs for the current user, so it needs no administrator. |
| \`OpenAgents-${version}-portable.exe\` | You just want to run it. One file, no installation, works where you cannot install software. |

Both contain exactly the same application.

**SHA-256**

\`\`\`
${checksums.map((c) => `${c.hash}  ${c.file}`).join('\n')}
\`\`\`

## First run

Windows will show a **SmartScreen warning** — "Windows protected your PC". This
build is not code-signed, so Windows has no publisher to check it against.
Choose *More info* → *Run anyway*.

That warning is honest, and your users will see it too. It goes away when the
build is signed with a code-signing certificate, which this release does not
have.

The app opens on a startup screen while its local server starts, then moves to
your workspace by itself. The app runs on your machine and sends data to
the model providers, websites and connectors you choose to use. OCR runs locally.

## Docker

Chat works while the secure workspace is being prepared. OpenAgents checks
Windows components, downloads and verifies Docker Desktop when missing, installs
it, and starts it automatically. A specific Ubuntu distribution is not required.
The managed browser is also downloaded automatically when missing.

Approve any Windows permission prompt and review Docker's terms if shown.
If Windows needs a restart, save your work, restart, then reopen OpenAgents to
continue setup automatically. Firmware virtualization and organization policies
can require your computer administrator. Setup progress and Retry setup appear
inside OpenAgents; no terminal commands are needed for the supported setup path.

## Running in the background

Closing the window keeps OpenAgents running in the system tray, so routines
keep running on schedule. Quit from the tray icon, or turn this off in
Settings → General → System. Starting at sign-in is available there too, and
is off until you turn it on.

If the local server crashes or stops answering, OpenAgents restarts it. If its
port is taken by another program, it picks another and remembers it.

## Where your data lives

\`%APPDATA%\\OpenHours\`

| File | What it is |
| --- | --- |
| \`openhours.db\` | Your bots, conversations, runs and routines. |
| \`openhours.config.json\` | Optional. Declare bots and MCP servers here. Absent by default — the app runs on built-in defaults without it. |
| \`openhours.config.example.json\` | A template, written on first run so there is something to copy. |
| \`window-state.json\` | Window size and position. |
| \`desktop-settings.json\` | Background running, start at sign-in, Docker autostart. |
| \`desktop-state.json\` | The port the app chose and the version that last opened this folder. |
| \`logs\\\\\` | Rotated logs. Keys, tokens and your user folder are removed before anything is written. |
| \`backups\\\\\` | A copy of the database taken before a different version opens it. The newest three are kept. |

**Uninstalling does not delete this folder.** Your conversations survive an
uninstall and a reinstall. Delete it yourself if you want a clean slate.

## If something goes wrong

Help → **Copy diagnostics** puts a report on the clipboard - versions, server
and Docker status, recent log lines - with keys and tokens removed. Help →
**Open logs folder** shows the full logs. The same two are in the tray menu.

## What this build does not do yet

- **It is not signed.** See the SmartScreen note above.
- **Windows only.** macOS and Linux targets are configured in the project but
  have never been built or tested.
- **No auto-update.** \`latest.yml\` is included for a future update feed, but
  the app does not check for one.

---

Built from the project at \`Desktop\\OpenHours\` with \`npm run publish\`.
Generated ${new Date().toISOString().slice(0, 10)}.
`;

fs.writeFileSync(path.join(publishDir, 'README.md'), readme);

// ------------------------------------------------------------------ report ---

console.log(`\nPublished OpenAgents ${version} to ${publishDir}\n`);
for (const c of checksums) console.log(`  ${c.file.padEnd(38)} ${c.mb.padStart(4)} MB`);
for (const f of copied.filter((f) => !f.endsWith('.exe'))) console.log(`  ${f}`);
console.log(`  README.md (checksums regenerated)\n`);
