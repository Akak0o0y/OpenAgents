/** Convert the checked-in OpenAgents artwork into app and Windows icon sizes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'build');
const source = await loadImage(path.resolve(here, '..', 'assets', 'openhours-logo.png'));

function png(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}

// PNG-compressed ICO entries are supported by every supported Windows version.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map(size => ({ size, png: png(size) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const directory = Buffer.alloc(16 * entries.length);
let offset = header.length + directory.length;
entries.forEach((entry, i) => {
  const at = i * 16;
  directory[at] = entry.size === 256 ? 0 : entry.size;
  directory[at + 1] = directory[at];
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(entry.png.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += entry.png.length;
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, directory, ...entries.map(e => e.png)]));
fs.writeFileSync(path.join(outDir, 'icon.png'), png(256));
const publicDir = path.resolve(here, '../../web/public');
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, 'openhours-icon.png'), png(256));
console.log('OpenAgents icons generated: ' + sizes.join(', ') + ' px; web icon 256 px');
