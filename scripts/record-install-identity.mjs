// Build identity, launchers and profile facts for the Stage 1 release (spec section 15, step 2).
//
// A display version such as 0.4.9 is reused across builds, so this records what actually runs: the
// build identity of the source and of the package, what the owner's shortcuts and installations
// open, and which version last opened the owner's profile. It only reads, except for its evidence
// files and, with --preserve-release, one copy of the released package in the system temporary
// folder. It never opens the owner's database, never reads an .auth.json file and prints no token.
//
// Usage:
//   node scripts/record-install-identity.mjs --preserve-release [--date=YYYY-MM-DD]   (before npm run app:dir)
//   node scripts/record-install-identity.mjs [--package=<unpacked dir>] [--date=YYYY-MM-DD]   (after it)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT_NAMES, appExecutable } from './lib/app-executable.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const day = option('date') ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('--date must be YYYY-MM-DD.'); process.exit(2); }
const outDir = path.join(repoRoot, 'docs', 'validation', `${day}-honest-posting`);
const identityModule = path.join(repoRoot, 'dist', 'src', 'daemon', 'build-identity.js');
if (!fs.existsSync(identityModule)) { console.error('Run npm run build first: dist/src/daemon/build-identity.js is missing.'); process.exit(2); }
const { buildIdentity } = await import(pathToFileURL(identityModule).href);
const unpacked = path.join(repoRoot, 'desktop', 'release', 'win-unpacked');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const writeEvidence = (name, value) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
  console.log(JSON.stringify(value, null, 2));
  console.log(`Evidence: ${path.relative(repoRoot, path.join(outDir, name))}`);
};

/** An unpacked app directory (the folder holding OpenAgents.exe): its executable, display version and build identity. */
function describeApp(directory) {
  const app = path.join(directory, 'resources', 'app');
  const executable = appExecutable(directory);
  return {
    directory,
    executable,
    executableSha256: fs.existsSync(executable) ? sha256(executable) : null,
    displayVersion: readJson(path.join(app, 'package.json'))?.version ?? null,
    buildIdentity: fs.existsSync(app) ? buildIdentity(app) : null,
    containsStage1: fs.existsSync(path.join(app, 'dist', 'src', 'daemon', 'publish-policy.js')),
  };
}

if (args.includes('--preserve-release')) {
  // Before packaging: desktop/release/win-unpacked still holds the last released build. Keep a copy
  // of it, because npm run app:dir replaces that folder, and the upgrade test starts from it.
  const gate = readJson(path.join(repoRoot, 'docs', 'validation', 'release-gate.json'));
  const lastVersion = readJson(path.join(process.env.APPDATA ?? '', 'OpenHours', 'desktop-state.json'))?.lastVersion ?? null;
  const record = { at: new Date().toISOString(), source: unpacked, releaseGate: gate ? { buildId: gate.buildId, version: gate.version, qualified: gate.qualified, completedAt: gate.completedAt } : null, profileLastVersion: lastVersion, preserved: false };
  const current = fs.existsSync(unpacked) ? describeApp(unpacked) : null;
  if (!current) record.reason = 'desktop/release/win-unpacked does not exist.';
  else if (!gate || gate.qualified !== true) record.reason = 'docs/validation/release-gate.json has no qualified record.';
  else if (current.containsStage1) record.reason = 'desktop/release/win-unpacked already contains Stage 1, so it is not the released build.';
  else if (current.buildIdentity !== gate.buildId || current.displayVersion !== gate.version) {
    record.reason = `desktop/release/win-unpacked is build ${current.buildIdentity} (${current.displayVersion}), not the released build ${gate.buildId} (${gate.version}).`;
  } else {
    const directory = path.join(os.tmpdir(), `oh-released-${gate.version}-${gate.buildId}`, 'win-unpacked');
    const existing = fs.existsSync(directory) ? describeApp(directory) : null;
    if (!existing || existing.buildIdentity !== gate.buildId || existing.executableSha256 !== current.executableSha256) {
      fs.rmSync(directory, { recursive: true, force: true });
      console.log(`Copying ${unpacked} to ${directory} (about 540 MB).`);
      fs.cpSync(unpacked, directory, { recursive: true });
    }
    const copy = describeApp(directory);
    if (copy.buildIdentity !== gate.buildId || copy.executableSha256 !== current.executableSha256) {
      record.reason = `The copy at ${directory} does not match the released build.`;
    } else {
      Object.assign(record, { preserved: true, directory, version: copy.displayVersion, buildIdentity: copy.buildIdentity, executableSha256: copy.executableSha256, matchesProfileLastVersion: lastVersion === copy.displayVersion });
    }
  }
  writeEvidence('released-package.json', record);
  if (!record.preserved) console.error(`Not preserved: ${record.reason}`);
  process.exit(record.preserved ? 0 : 1);
}

// After packaging.
const packageDir = path.resolve(option('package') ?? unpacked);
const source = { root: repoRoot, buildIdentity: buildIdentity(repoRoot), displayVersion: readJson(path.join(repoRoot, 'package.json'))?.version ?? null };
const released = readJson(path.join(outDir, 'released-package.json'));

// Shortcut targets and per-user installations, read through PowerShell. Nothing is changed.
const script = [
  '$shell = New-Object -ComObject WScript.Shell',
  `$links = @(foreach ($name in @(${PRODUCT_NAMES.map(name => `'${name}'`).join(', ')})) { @{ via = 'Desktop shortcut'; path = (Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk')) }; @{ via = 'Start menu shortcut'; path = (Join-Path $env:APPDATA ('Microsoft\\Windows\\Start Menu\\Programs\\' + $name + '.lnk')) } })`,
  '$launchers = @(foreach ($l in $links) { if (Test-Path -LiteralPath $l.path) { [pscustomobject]@{ via = $l.via; shortcut = $l.path; target = $shell.CreateShortcut($l.path).TargetPath } } })',
  `$installs = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match '^(${PRODUCT_NAMES.join('|')})\\b' } | ForEach-Object { [pscustomobject]@{ displayName = $_.DisplayName; registryVersion = $_.DisplayVersion; uninstallString = $_.UninstallString } })`,
  '[pscustomobject]@{ launchers = $launchers; installs = $installs } | ConvertTo-Json -Depth 4 -Compress',
].join('; ');
const shell = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
let found = { launchers: [], installs: [] };
try { found = JSON.parse(shell.stdout.trim() || '{}'); } catch { found = { launchers: [], installs: [], error: String(shell.stderr || shell.stdout).slice(0, 500) }; }
const list = value => (Array.isArray(value) ? value : value ? [value] : []);
const launchers = list(found.launchers).map(l => ({ via: l.via, shortcut: l.shortcut, target: l.target, ...describeApp(path.dirname(l.target)) }));
const installs = list(found.installs).map(i => {
  const exe = /^"([^"]+)"/.exec(i.uninstallString ?? '')?.[1];
  return { displayName: i.displayName, registryVersion: i.registryVersion, uninstallString: i.uninstallString, ...(exe ? describeApp(path.dirname(exe)) : {}) };
});

const profileDir = path.join(process.env.APPDATA ?? '', 'OpenHours');
const database = path.join(profileDir, 'openhours.db');
const stat = fs.existsSync(database) ? fs.statSync(database) : null;
const pkg = describeApp(packageDir);
const identity = {
  at: new Date().toISOString(),
  scope: 'Build identity and launch facts. The display version is recorded separately because it is reused across builds. Facts are read from files, shortcuts and the per-user uninstall list; the owner\'s database was not opened.',
  source,
  package: pkg,
  released,
  launchers,
  installs,
  shortcutMatchesReleased: !!released?.preserved && launchers.length > 0 && launchers.every(l => l.buildIdentity === released.buildIdentity),
  profile: {
    directory: profileDir,
    lastVersion: readJson(path.join(profileDir, 'desktop-state.json'))?.lastVersion ?? null,
    database: stat ? { path: database, bytes: stat.size, modified: stat.mtime.toISOString() } : null,
  },
  node: { executable: process.execPath, version: process.version },
  ...(found.error ? { launcherLookupError: found.error } : {}),
};
writeEvidence('identity.json', identity);
const problems = [];
if (pkg.buildIdentity !== source.buildIdentity) problems.push(`the package is build ${pkg.buildIdentity}, the source is ${source.buildIdentity}`);
if (!pkg.containsStage1) problems.push('the package does not contain Stage 1 (dist/src/daemon/publish-policy.js)');
if (problems.length) console.error(`Identity check failed: ${problems.join('; ')}.`);
process.exitCode = problems.length ? 1 : 0;
