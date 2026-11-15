import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('single-file build never supplies untrusted glob patterns', async () => {
  const config = await readFile(new URL('../vite.mcp-app.config.ts', import.meta.url), 'utf8');
  assert.match(config, /viteSingleFile\(\{ inlinePattern: \[\] \}\)/);
  const plugin = await readFile(new URL('../node_modules/vite-plugin-singlefile/dist/esm/index.js', import.meta.url), 'utf8');
  assert.match(plugin, /inlinePattern\.length && !micromatch\.isMatch/g);
});
