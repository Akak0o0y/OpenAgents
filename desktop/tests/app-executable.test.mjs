import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appExecutable } from '../../scripts/lib/app-executable.mjs';

test('release scripts find the OpenAgents executable, and a pre-0.6.0 build by its old name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-executable-'));
  try {
    const current = path.join(root, 'current'), previous = path.join(root, 'previous'), empty = path.join(root, 'empty');
    for (const dir of [current, previous, empty]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(current, 'OpenAgents.exe'), '');
    fs.writeFileSync(path.join(previous, 'OpenHours.exe'), '');
    assert.equal(appExecutable(current), path.join(current, 'OpenAgents.exe'));
    assert.equal(appExecutable(previous), path.join(previous, 'OpenHours.exe'));
    assert.equal(appExecutable(empty), path.join(empty, 'OpenAgents.exe'), 'a missing executable is reported under the current name');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
