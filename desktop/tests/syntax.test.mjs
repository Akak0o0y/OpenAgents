import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('every desktop entry point parses before packaging, including Electron-only modules', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  for (const file of fs.readdirSync(root, { recursive: true })) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    execFileSync(process.execPath, ['--check', path.join(root, file)], { windowsHide: true, stdio: 'pipe' });
  }
});
