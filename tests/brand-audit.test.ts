import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEPT, brandFiles, unescapeLine } from './helpers/brand-names.js';

// The product is OpenAgents (0.6.0). Any other spelling of the old name in a living file is a missed rename.
test('every remaining OpenHours is a kept identifier or a dated record', () => {
  const found: string[] = [];
  for (const file of brandFiles()) {
    fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).forEach((line, index) => {
      const rest = KEPT.reduce((text, pattern) => text.replace(pattern, ''), unescapeLine(line));
      if (/openhours/i.test(rest)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(found.slice(0, 80), [], `${found.length} occurrences remain`);
});
