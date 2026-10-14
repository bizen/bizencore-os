import { readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const excludedArtwork = ['src/assets/cirno.png', 'public/quests/mainquest.png', 'public/quests/tanomigoto.png'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function excludeDistributionArtwork(root, renderer) {
  for (const asset of excludedArtwork.filter(file => file.startsWith('public/'))) {
    await rm(path.join(renderer, asset.slice('public/'.length)), { force: true });
  }
  await verifyDistributionArtwork(root, renderer);
}

export async function verifyDistributionArtwork(root, directory) {
  const forbidden = new Set(await Promise.all(excludedArtwork.map(async file => digest(await readFile(path.join(root, file))))));
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) throw new Error(`Unexpected distribution symlink: ${file}`);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        if (forbidden.has(digest(bytes)) || /^(cirno(?:-[^.]*)?|mainquest|tanomigoto)\.png$/i.test(entry.name)) {
          throw new Error(`Unlicensed artwork in distribution: ${file}`);
        }
      }
    }
  }
  await walk(directory);
}
