import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    Date.now = () => Date.parse('2026-10-09T12:00:00Z'); setUserTimeZone('UTC');
    const items = [
      { id: 'label', text: '仕事', type: 'section', parentId: null, order: 0 },
      { id: 'ordinary', text: 'いつものタスク', type: 'task', parentId: 'label', order: 0 },
    ];
    taskStore.mergeRemote(items.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify({ ...item, done: false, createdAt: 1, updatedAt: 1 }) })));
    globalThis.showLife = () => lifeWorldStore.setShowInAll(true);
    createRoot(document.getElementById('root')).render(<TasksPage />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}\n.page { max-width: 840px; margin: auto; padding: 16px; }</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://life-tree.test/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto('http://life-tree.test/');
  await page.getByRole('tab', { name: /today/ }).click();
  const world = page.locator('.life-world');
  const titles = world.getByRole('textbox', { name: '生活タスク', exact: true });
  const panel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  const getRow = async text => {
    for (const item of await world.locator('.life-row').all()) if (await item.getByRole('textbox', { name: '生活タスク', exact: true }).inputValue() === text) return item;
    throw new Error('Row not found: ' + text);
  };
  const values = async () => titles.evaluateAll(elements => elements.map(el => el.value));
  await world.getByRole('button', { name: '今日やりたいこと', exact: true }).click();
  await titles.first().fill('Grocery shopping'); await titles.first().press('Enter');
  await titles.nth(1).fill('Milk'); await titles.nth(1).press('Tab');
  assert.equal(await (await getRow('Milk')).evaluate(el => el.style.getPropertyValue('--depth')), '1');
  await titles.nth(1).press('Enter'); await titles.nth(2).fill('Eggs');
  assert.equal(await (await getRow('Eggs')).evaluate(el => el.style.getPropertyValue('--depth')), '1');
  await titles.nth(2).press('Tab');
  assert.equal(await (await getRow('Eggs')).evaluate(el => el.style.getPropertyValue('--depth')), '2');
  await titles.nth(2).press('Control+ArrowLeft'); await titles.nth(2).press('Shift+Tab');
  assert.equal(await (await getRow('Eggs')).evaluate(el => el.style.getPropertyValue('--depth')), '0');
  await titles.nth(2).press('Control+ArrowRight');
  await titles.nth(2).press('Control+ArrowUp');
  assert.deepEqual(await values(), ['Grocery shopping', 'Eggs', 'Milk']);
  await titles.nth(1).press('Control+ArrowDown');
  assert.deepEqual(await values(), ['Grocery shopping', 'Milk', 'Eggs']);
  await titles.nth(1).press('Shift+Enter');
  const note = world.getByRole('textbox', { name: '生活タスクのメモ', exact: true });
  await note.fill('牛乳を一本\nいつもの種類'); await note.press('Control+Enter');
  assert.equal(await titles.nth(1).evaluate(el => el === document.activeElement), true);
  await titles.nth(1).evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 229, isComposing: true, bubbles: true })));
  assert.equal(await (await getRow('Milk')).evaluate(el => el.style.getPropertyValue('--depth')), '1');
  await titles.nth(1).press('Control+i');
  await panel.getByRole('switch', { name: 'タスクロック', exact: true }).click();
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  assert.equal(await world.getByRole('button', { name: 'Grocery shoppingを完了にする', exact: true }).isEnabled(), false);
  await world.getByRole('button', { name: 'Eggsを完了にする', exact: true }).click();
  await titles.first().press('Control+i');
  await panel.getByRole('switch', { name: 'タスクロック', exact: true }).click();
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await titles.first().press('Control+i');
  await panel.getByRole('button', { name: '生活タスクにサブタスクを追加', exact: true }).click();
  await panel.getByRole('textbox', { name: '生活タスクのタイトル', exact: true }).fill('パン');
  await panel.getByRole('textbox', { name: '生活タスクのメモ', exact: true }).fill('長くても全文が残るメモ。'.repeat(30));
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.value === 'パン');
  assert.equal(await (await getRow('パン')).getByRole('textbox', { name: '生活タスク', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.equal(await (await getRow('パン')).evaluate(el => el.style.getPropertyValue('--depth')), '1');
  assert.equal(await (await getRow('パン')).getByRole('button', { name: '生活タスクを削除', exact: true }).isVisible(), false, 'mobile shows only detail action');
  await titles.nth(1).press('Control+i');
  await panel.getByRole('switch', { name: 'タスクロック', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '生活タスクをサブタスクにする', exact: true }).isEnabled(), false);
  await panel.getByRole('button', { name: '生活タスクの階層を戻す', exact: true }).click();
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  assert.equal(await (await getRow('Milk')).evaluate(el => el.style.getPropertyValue('--depth')), '0');
  await (await getRow('Milk')).getByRole('textbox', { name: '生活タスク', exact: true }).press('Tab');

  await page.evaluate(() => globalThis.showLife());
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  assert.deepEqual(await values(), ['Grocery shopping', 'Eggs', 'パン', 'Milk']);
  await page.reload();
  await world.waitFor();
  assert.deepEqual(await values(), ['Grocery shopping', 'Eggs', 'パン', 'Milk']);
  await titles.first().press('Control+Backspace');
  await world.getByRole('button', { name: '今日やりたいこと', exact: true }).waitFor();
  assert.equal(await titles.count(), 0, 'deletion removes the entire subtree');
  await world.getByRole('button', { name: '生活世界の操作を元に戻す', exact: true }).click();
  assert.equal(await titles.count(), 4);
  await (await getRow('パン')).getByRole('textbox', { name: '生活タスク', exact: true }).fill('買い物の帰りに寄るいつものパン屋で、明日の朝ごはんを買って帰る。'.repeat(3));
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForFunction(() => [...document.querySelectorAll('.life-row .row-title')].every(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} fits`);
      const overlap = await world.locator('.life-row').evaluateAll(elements => elements.some(row => {
        const text = row.querySelector('.row-text').getBoundingClientRect(), meta = row.querySelector('.row-meta').getBoundingClientRect();
        return text.right > meta.left + 1;
      }));
      assert.equal(overlap, false, 'titles and actions do not overlap');
      assert.equal(await world.locator('.row-tree-guide').count() > 0, true);
      await page.screenshot({ path: `/private/tmp/bizencore-life-tree-${theme}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: nested creation, sibling insertion, Tab/Shift+Tab, Ctrl arrows, inline notes, IME, subtree lock/delete/undo, mobile inspector add/outdent, All/reload persistence, hierarchy rails, 3 themes at desktop/390/320px. Isolated storage; no external network.');
} finally { await browser.close(); }
