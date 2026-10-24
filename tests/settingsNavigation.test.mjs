import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/lib/settingsNavigation.ts'], bundle: true, write: false, format: 'esm' });
const { SETTINGS_PAGES, findSettingsPages } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('settings search finds categories by setting names, descriptions and normalized keywords', () => {
  assert.equal(findSettingsPages('  ').length, SETTINGS_PAGES.length);
  for (const [query, id] of [['朝', 'notifications'], ['チルノ', 'appearance'], ['タイムゾーン', 'general'], ['招待 リンク', 'partner'], ['ＭＣＰ', 'connections'], ['削除', 'account']]) {
    assert.deepEqual(findSettingsPages(query).map(page => page.id), [id]);
  }
  assert.deepEqual(findSettingsPages('not-a-setting'), []);
  assert.deepEqual(findSettingsPages('朝 削除'), []);
  assert.equal(new Set(SETTINGS_PAGES.map(page => page.id)).size, SETTINGS_PAGES.length);
});
