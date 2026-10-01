/**
 * The bot's desktop must be able to read and write the languages its owner uses.
 *
 * As built, it could do neither: no UTF-8 locale, so xdotool rejected every multi-byte
 * character with "Invalid multi-byte sequence encountered", and sixteen fonts with zero
 * covering Arabic or CJK, so those pages rendered as empty boxes in every screenshot the
 * vision model was then asked to read.
 *
 * These are container facts that no Windows host can exercise, so they are guarded by
 * reading the recipe. The behaviour itself was verified in a running container.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'bot-desktop');
const dockerfile = await fs.readFile(path.join(recipe, 'Dockerfile'), 'utf8');
const computer = await fs.readFile(path.join(recipe, 'computer.mjs'), 'utf8');

test('the image sets a UTF-8 locale, without which no non-Latin text can be typed', () => {
  assert.match(dockerfile, /LANG=C\.UTF-8/, 'xdotool refuses multi-byte input without it');
  assert.match(dockerfile, /LC_ALL=C\.UTF-8/);
});

test('the keyboard path names the locale itself, so the image alone cannot silently drop it', () => {
  assert.match(computer, /LANG: process\.env\.LANG \?\? 'C\.UTF-8'/);
  assert.match(computer, /LC_ALL: process\.env\.LC_ALL \?\? 'C\.UTF-8'/);
});

test('fonts cover the scripts the owner actually reads', () => {
  for (const font of ['fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji']) {
    assert.match(dockerfile, new RegExp(font.replace(/-/g, '\-')), `${font} must be installed or those pages render as boxes`);
  }
  // Latin-only coverage was the original state and is not enough on its own.
  assert.match(dockerfile, /fonts-liberation/);
});

test('the container carries time zone data so it can be given the owner’s zone', () => {
  assert.match(dockerfile, /tzdata/);
});

test('the desktop is started in the owner’s time zone, not UTC', async () => {
  const botDesktop = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon', 'bot-desktop.ts'), 'utf8');
  assert.match(botDesktop, /'--env', `TZ=\$\{timezone\}`/);
  // The zone becomes a container argument, so it is validated rather than trusted.
  assert.match(botDesktop, /test\(zone\) \? zone : 'UTC'/);
});
