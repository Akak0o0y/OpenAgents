// Read-only package/source comparison; useful when rebuilding the same version.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.argv[2];
assert.ok(directory && path.isAbsolute(directory), 'Pass an absolute unpacked app directory.');
const app = path.join(directory, 'resources', 'app');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = relative => fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(relative, entry.name)) : [path.join(relative, entry.name)]);
const files = [...walk('dist/src').filter(file => file.endsWith('.js')), ...walk('web/dist'),
  ...walk('desktop/src'), 'desktop/build/icon.ico', 'desktop/build/icon.png',
  'docker/bot-desktop/Dockerfile', 'docker/bot-desktop/start.sh', 'docker/bot-desktop/gateway.mjs',
  'docker/bot-desktop/computer.mjs', 'docker/bot-desktop/seccomp.json'];
// electron-builder removes development-only package metadata by design.
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const builtPackage = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'releaseVersion', 'main', 'type', 'dependencies']) {
  assert.deepEqual(builtPackage[field], sourcePackage[field], `Packaged metadata differs: ${field}`);
}
const manifest = files.sort().map(file => {
  const expected = hash(path.join(root, file));
  assert.equal(hash(path.join(app, file)), expected, `Packaged file differs: ${file}`);
  return `${file.replaceAll('\\', '/')}:${expected}`;
});
console.log(JSON.stringify({ passed: true, directory, checkedFiles: files.length,
  implementationSha256: createHash('sha256').update(manifest.join('\n')).digest('hex') }));
