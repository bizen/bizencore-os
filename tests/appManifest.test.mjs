import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));

test('home-screen identity opens the task app in standalone mode without locking orientation', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.name, 'bizencore terminal');
  assert.equal(manifest.short_name, 'bizencore');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, undefined);
  assert.equal(manifest.background_color, '#0a0b0c');
  assert.equal(manifest.theme_color, '#0a0b0c');
});

test('all declared icons exist with the advertised PNG dimensions', async () => {
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
  for (const icon of [...manifest.icons,
    { src: '/apple-touch-icon.png', sizes: '180x180' }, { src: '/favicon.png', sizes: '32x32' }]) {
    const png = await readFile(`public${new URL(icon.src, 'https://app.test').pathname}`);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    if (icon.purpose) {
      assert.equal(icon.type, 'image/png');
      assert.equal(icon.purpose, 'any');
    }
  }
});

test('desktop icon contains the standard and Retina PNG representations', async () => {
  const png = await readFile('desktop/assets/icon.png');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  const icns = await readFile('desktop/assets/icon.icns');
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const expected = { ic11: 32, ic12: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic13: 256, ic14: 512 };
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString('ascii', offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icns.length);
    assert.equal(icns.readUInt32BE(offset + 24), expected[type]);
    assert.equal(icns.readUInt32BE(offset + 28), expected[type]);
    delete expected[type];
    offset += length;
  }
  assert.deepEqual(expected, {});
});

test('theme-color follows the selected theme and remains optional in MCP Apps', async () => {
  const original = globalThis.document;
  const { outputFiles } = await build({ entryPoints: ['src/lib/theme.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { applyTheme } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  let content;
  try {
    globalThis.document = { documentElement: { dataset: {}, style: {} }, querySelector: selector => {
      assert.equal(selector, 'meta[name="theme-color"]');
      return { setAttribute: (key, value) => { assert.equal(key, 'content'); content = value; } };
    } };
    for (const [theme, color] of [['black', '#0a0b0c'], ['white', '#f6f8fa'], ['original', '#121620']]) {
      applyTheme(theme);
      assert.equal(content, color);
      assert.equal(document.documentElement.dataset.theme, theme);
      assert.equal(document.documentElement.style.colorScheme, theme === 'white' ? 'light' : 'dark');
    }
    document.querySelector = () => null;
    assert.doesNotThrow(() => applyTheme('black'));
  } finally { globalThis.document = original; }
});
