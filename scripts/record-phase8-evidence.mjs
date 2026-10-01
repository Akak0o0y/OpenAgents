import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = 'docs/validation/2026-09-14-codex-continuation';
const hash = value => createHash('sha256').update(value).digest('hex');
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const record = file => { const bytes = fs.readFileSync(file); return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }; };
const selected = [...['src', 'tests', 'web/src', 'desktop/src', 'dist/src', 'dist/tests', 'web/dist', '.github/workflows'].flatMap(files),
  'package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json', 'desktop/package.json', 'desktop/electron-builder.yml', 'README.md',
  'scripts/verify-live-research.mjs', 'scripts/verify-live-browser.mjs', 'scripts/verify-packaged-browser.mjs', 'scripts/record-phase8-evidence.mjs',
  'docs/phase-8-codex-continuation-2026-09-14.md', 'docs/opus-phase-8-progress.md'];
fs.writeFileSync(path.join(directory, 'source-manifest.json'), JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Current workspace source, compiled runtime, UI and validation scripts. This does not claim earlier Opus artifacts were retained.', files: selected.sort().map(record) }, null, 2));
const evidence = files(directory).filter(file => !file.endsWith('evidence-manifest.json'));
fs.writeFileSync(path.join(directory, 'evidence-manifest.json'), JSON.stringify({ recordedAt: new Date().toISOString(), files: evidence.sort().map(record) }, null, 2));
for (const manifest of ['source-manifest.json', 'evidence-manifest.json']) {
  const rows = JSON.parse(fs.readFileSync(path.join(directory, manifest), 'utf8')).files;
  for (const row of rows) if (record(row.path).sha256 !== row.sha256) throw new Error(`Manifest mismatch: ${row.path}`);
  console.log(`${manifest}: ${rows.length} hashes verified`);
}
