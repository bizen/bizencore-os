import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore, flushPersist } from './src/lib/taskStore';
    if (!Object.keys(taskStore.getState().items).length) {
      const label = taskStore.addSection();
      taskStore.setText(label, '生活');
      const parent = taskStore.insertAfter(label, { asChild: true });
      taskStore.setText(parent, '暮らしのリスト');
      const container = taskStore.insertAfter(parent, { asChild: true });
      taskStore.setText(container, '読書リスト');
      const child = taskStore.insertAfter(container, { asChild: true });
      taskStore.setText(child, '本を一冊読む');
      flushPersist();
    }
    const items = Object.values(taskStore.getState().items);
    globalThis.fixtureIds = Object.fromEntries(['生活', '暮らしのリスト', '読書リスト', '本を一冊読む'].map(name => [name, items.find(item => item.text === name).id]));
    createRoot(document.getElementById('root')).render(<TasksPage />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url() === 'https://bizencore.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` })
    : route.abort());
  await page.goto('https://bizencore.test/');
  const ids = await page.evaluate(() => globalThis.fixtureIds);
  const container = page.locator('[data-row-id="' + ids['読書リスト'] + '"]');
  const child = page.locator('[data-row-id="' + ids['本を一冊読む'] + '"]');
  const parent = page.locator('[data-row-id="' + ids['暮らしのリスト'] + '"]');
  const lock = page.getByRole('switch', { name: 'タスクロック' });
  const close = () => page.getByRole('button', { name: '閉じる（Esc）' }).click();
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['all', 'board']) {
        await page.getByRole('tab', { name: view, exact: true }).click();
        await container.getByRole('button', { name: '詳細を開く', exact: true }).click();
        await lock.click();
        assert.equal(await lock.getAttribute('aria-checked'), 'true');
        await close();
        assert.equal(await container.locator('button.check').count(), 0);
        assert.equal(await container.locator('.row-mark').textContent(), '');
        assert.equal(await container.locator('.row-mark svg').count(), 0);
        assert.equal(await parent.locator('button.check').isDisabled(), true);
        await container.getByRole('textbox', { name: 'タスク', exact: true }).press('Meta+Enter');
        assert.equal((await container.getAttribute('class')).includes('is-done'), false);
        await child.getByRole('button', { name: '完了にする', exact: true }).click();
        assert.equal(await child.locator('.check').getAttribute('aria-pressed'), 'true');
        assert.equal((await container.getAttribute('class')).includes('is-done'), false);
        await child.getByRole('button', { name: '未完了に戻す', exact: true }).click();
        await container.getByRole('button', { name: '詳細を開く', exact: true }).click();
        await lock.click();
        assert.equal(await lock.getAttribute('aria-checked'), 'false');
        await close();
        assert.equal(await container.locator('button.check').count(), 1);
        assert.equal(await parent.locator('button.check').isDisabled(), false);
      }
    }
  }
  await container.getByRole('button', { name: '詳細を開く', exact: true }).click();
  await lock.focus();
  await lock.press('Space');
  assert.equal(await lock.getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: '/private/tmp/bizencore-task-lock-mobile.png', fullPage: true, animations: 'disabled' });
  await close();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem('chrct.tasks.v2') || '[]').some(item => item.id === id && item.locked), ids['読書リスト']);
  await page.reload();
  await page.locator('[data-row-id="' + ids['読書リスト'] + '"].row--locked').waitFor();
  assert.equal(await container.locator('button.check').count(), 0);
  assert.equal(await container.locator('.row-mark').textContent(), '');
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  const focusButton = page.locator('[data-row-id="' + ids['生活'] + '"]').getByRole('button', { name: 'フォーカスに追加' });
  await focusButton.focus();
  await focusButton.press('Enter');
  await page.getByRole('tab', { name: '生活', exact: true }).click();
  assert.equal(await container.locator('button.check').count(), 0);
  await page.screenshot({ path: '/private/tmp/bizencore-task-lock-mobile.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Passed: actual TasksPage and inspector; 3 themes, desktop/mobile, All/Board, keyboard lock/completion, unlocked children, parent protection, persisted reload, focus view.');
} finally {
  await browser.close();
}
