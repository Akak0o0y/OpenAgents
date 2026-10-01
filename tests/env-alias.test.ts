import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aliasOpenAgentsEnv } from '../src/kernel/env-alias.js';

test('OPENAGENTS_ settings reach every OPENHOURS_ reader, and the new name wins', () => {
  const env: NodeJS.ProcessEnv = { OPENAGENTS_PORT: '43190', OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04',
    OPENAGENTS_DATA_DIR: 'C:\\new', OPENHOURS_DATA_DIR: 'C:\\old', PATH: 'unchanged' };
  aliasOpenAgentsEnv(env);
  assert.equal(env.OPENHOURS_PORT, '43190');
  assert.equal(env.OPENHOURS_WSL_DISTRO, 'Ubuntu-22.04');
  assert.equal(env.OPENHOURS_DATA_DIR, 'C:\\new');
  assert.equal(env.PATH, 'unchanged');
  // A setting given under neither name is not invented.
  assert.deepEqual(Object.keys(env).sort(), ['OPENAGENTS_DATA_DIR', 'OPENAGENTS_PORT', 'OPENHOURS_DATA_DIR', 'OPENHOURS_PORT', 'OPENHOURS_WSL_DISTRO', 'PATH']);
});

test('an OPENAGENTS_ setting in a .env file reaches its OPENHOURS_ reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-alias-'));
  try {
    const file = path.join(dir, 'settings.env');
    fs.writeFileSync(file, 'OPENAGENTS_ALIAS_PROBE=from-file\n');
    const client = pathToFileURL(path.resolve('dist/src/evals/llm-client.js')).href;
    const script = `import(${JSON.stringify(client)}).then((m) => { m.loadEnvFiles(); process.stdout.write(String(process.env.OPENHOURS_ALIAS_PROBE)); });`;
    // cwd and home point at the empty folder, so no real .env on this machine is read.
    const run = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENHOURS_ENV_FILE: file, USERPROFILE: dir, HOME: dir } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'from-file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the daemon and the desktop shell alias before any module reads a setting', () => {
  assert.equal(fs.readFileSync(path.resolve('src/daemon/index.ts'), 'utf8').split(/\r?\n/)[0], "import './env-bootstrap.js';");
  const main = fs.readFileSync(path.resolve('desktop/src/main.mjs'), 'utf8');
  assert.equal(main.split(/\r?\n/).find((line) => line.startsWith('import ')), "import './env-bootstrap.mjs';");
});
