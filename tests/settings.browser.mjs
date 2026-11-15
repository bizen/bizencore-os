import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const directory = await mkdtemp(path.join(tmpdir(), 'bizencore-settings-test-'));
execFileSync(process.execPath, ['tests/settings.fixture.mjs', directory]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (!['index.html', 'app.js', 'app.css'].includes(name)) return route.abort();
    return route.fulfill({ body: await readFile(path.join(directory, name)), contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('https://settings.test/');
  const open = page.getByRole('button', { name: '設定を開く', exact: true });
  const close = page.getByRole('button', { name: '閉じる', exact: true });
  const category = name => page.getByRole('button', { name, exact: true }).click();
  await open.click();
  assert.equal(await page.locator('.settings-page:not([hidden])').getAttribute('id'), 'settings-page-general');
  await close.press('Shift+Tab');
  assert.equal(await page.getByRole('button', { name: 'この端末に合わせる' }).evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await close.evaluate(e => e === document.activeElement), true);
  await page.getByRole('checkbox', { name: 'Allに表示する', exact: true }).check();
  await category('外観');
  await page.getByRole('radio', { name: 'フロストホワイト' }).click();
  assert.equal(await page.getByRole('radio', { name: 'フロストホワイト' }).evaluate(e => e === document.activeElement), true);
  await page.getByLabel('チルノのスタイル', { exact: true }).selectOption('flat');
  await category('通知');
  const morning = page.getByRole('checkbox', { name: '朝のTodayまとめ（先頭タスク名も表示）' });
  await morning.check();
  await category('一般');
  assert.equal(await page.getByRole('checkbox', { name: 'Allに表示する', exact: true }).isChecked(), true);
  await category('通知'); assert.equal(await morning.isChecked(), true, 'unsaved notification choices survive navigation');
  await page.getByRole('button', { name: 'この端末に保存' }).click();
  await page.getByText('この端末の通知設定を保存しました。').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await open.evaluate(e => e === document.activeElement), true, 'save disabling its button does not break Escape or return focus');
  await open.click();
  const search = page.getByRole('searchbox', { name: '設定を検索' });
  await search.fill('ＭＣＰ');
  await page.getByText('MCP接続履歴', { exact: true }).waitFor();
  assert.equal(await page.locator('.settings-page:not([hidden])').getAttribute('id'), 'settings-page-connections');
  await search.fill('no matching setting'); await page.getByText('一致する設定がありません。').waitFor();
  await page.locator('.settings-search button').click();
  await category('アカウント');
  await page.getByRole('button', { name: 'アカウントを削除', exact: true }).click();
  const confirmation = page.getByLabel('確認のため「削除」と入力してください。');
  await confirmation.fill('削除');
  await category('接続'); await category('アカウント');
  assert.equal(await confirmation.inputValue(), '削除', 'switching categories retains the confirmation without submitting it');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  for (const [name, theme] of [['ミッドナイトブラック', 'black'], ['ディープネイビー', 'original'], ['フロストホワイト', 'white']]) {
    await category('外観'); await page.getByRole('radio', { name }).click();
    for (const width of [1280, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator('.settings-panel').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, `${theme}/${width}: panel overflow`);
      assert.equal(await page.locator('.settings-content').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, `${theme}/${width}: content overflow`);
    }
  }
  await close.click(); assert.equal(await open.evaluate(e => e === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('Settings: navigation, search, draft retention, focus/Tab/Escape, themes, responsive layout, safe account confirmation and mocked notification save passed.');
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
