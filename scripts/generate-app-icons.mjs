import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the macOS resizer; the desktop packager currently supports macOS only.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src/assets/app-icon.png');
const sizes = {
  'public/favicon.png': 32,
  'public/apple-touch-icon.png': 180,
  'public/icons/icon-192.png': 192,
  'public/icons/icon-512.png': 512,
  'desktop/assets/icon.png': 1024,
};
async function resize(destination, size) {
  await mkdir(path.dirname(destination), { recursive: true });
  execFileSync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', destination], { stdio: 'pipe' });
  const png = await readFile(destination);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
for (const [name, size] of Object.entries(sizes)) {
  await resize(path.join(root, name), size);
  console.log(`${name}: ${size}px`);
}
const chunks = [];
// PNG representations used by the existing ICNS, including Retina sizes.
for (const [type, size] of Object.entries({ ic11: 32, ic12: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic13: 256, ic14: 512 })) {
  const destination = path.join(root, 'desktop/assets/icon.png');
  await resize(destination, size);
  const png = await readFile(destination);
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
await resize(path.join(root, 'desktop/assets/icon.png'), 1024);
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(path.join(root, 'desktop/assets/icon.icns'), Buffer.concat([header, ...chunks]));
console.log('desktop/assets/icon.icns: generated');
