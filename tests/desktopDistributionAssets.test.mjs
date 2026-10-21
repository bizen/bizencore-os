import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { excludedArtwork, excludeDistributionArtwork, verifyDistributionArtwork } from '../desktop/electron/distribution-assets.mjs';

test('distribution excludes public artwork and rejects renamed copies of unlicensed source images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bizencore-assets-'));
  try {
    for (const [index, file] of excludedArtwork.entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), `unlicensed-${index}`);
    }
    const renderer = path.join(root, 'renderer');
    await mkdir(path.join(renderer, 'quests'), { recursive: true });
    await writeFile(path.join(renderer, 'quests/mainquest.png'), 'unlicensed-1');
    await writeFile(path.join(renderer, 'quests/tanomigoto.png'), 'unlicensed-2');
    await writeFile(path.join(renderer, 'safe.svg'), '<svg/>');
    await writeFile(path.join(renderer, 'cirno-restored.png'), 'restored-mascot');
    await excludeDistributionArtwork(root, renderer);
    assert.equal(await readFile(path.join(renderer, 'cirno-restored.png'), 'utf8'), 'restored-mascot');
    await writeFile(path.join(renderer, 'renamed.png'), 'unlicensed-0');
    await assert.rejects(verifyDistributionArtwork(root, renderer), /Unlicensed artwork/);
    await rm(path.join(renderer, 'renamed.png'));
    await verifyDistributionArtwork(root, renderer);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging preserves Electron and Chromium notices as readable resources', async () => {
  const script = await readFile(new URL('../desktop/electron/package.mjs', import.meta.url), 'utf8');
  for (const name of ['node_modules/electron/dist/LICENSE', 'node_modules/electron/dist/LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.txt', 'INSTALL.ja.md']) {
    assert.ok(script.includes(name), `Missing packaging resource: ${name}`);
  }
});
