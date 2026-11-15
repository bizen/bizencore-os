import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    import { applyTheme } from './src/lib/theme';
    let now = '2026-10-05'; Date.now = () => Date.parse(now + 'T12:00:00Z');
    applyTheme('black'); setUserTimeZone('UTC');
    taskStore.mergeRemote([
      { id: 'label', text: '作業', type: 'section', parentId: null, order: 0 },
      { id: 'ordinary', text: '通常タスク', type: 'task', parentId: 'label', order: 0, assignedDate: now },
    ].map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify({ done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    if (!Object.keys(lifeWorldStore.getSnapshot().data.entries).length) {
      const parent = lifeWorldStore.add(now); lifeWorldStore.setText(parent, '買い物'); lifeWorldStore.setLocked(parent, true, now);
      const milk = lifeWorldStore.add(now, parent, true, true); lifeWorldStore.setText(milk, '牛乳');
      const bread = lifeWorldStore.add(now, milk, true); lifeWorldStore.setText(bread, 'パン');
      const wish = lifeWorldStore.add(now); lifeWorldStore.setText(wish, 'フォーを食べたい');
      const habit = lifeWorldStore.add(now); lifeWorldStore.setText(habit, '散歩'); lifeWorldStore.setRepeat(habit, 'daily');
      lifeWorldStore.setShowInAll(true);
    }
    globalThis.fixtureLifeData = () => lifeWorldStore.getSnapshot().data;
    function Fixture() {
      const [day, setDay] = useState(now);
      return <div className="app-shell"><header className="app-header">
        <button onClick={() => { now = '2026-10-06'; setDay(now); }}>翌日</button></header>
        <main className="app-main"><TasksPage key={day} /></main></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://life-filing.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
  await page.goto('https://life-filing.test/');
  const world = page.locator('.life-world'), shelf = page.locator('.done-shelf');
  const ordinary = page.locator('[data-row-id="ordinary"] .row-title');
  await ordinary.press('Control+Enter');
  for (const text of ['牛乳', 'フォーを食べたい', '散歩']) await world.getByRole('button', { name: `${text}を完了にする`, exact: true }).click();
  assert.equal(await shelf.count(), 0, 'checking alone leaves tasks in their original positions');
  await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.done-shelf-count')?.textContent === '4');
  assert.equal(await world.locator('.life-row').count(), 2, 'only the locked parent and unfinished sibling remain');
  await shelf.locator('[data-row-id="ordinary"]').waitFor();
  assert.equal(await shelf.locator('[data-row-id="ordinary"]').count(), 1);
  assert.equal(await shelf.locator('.life-row').count(), 3, 'ordinary and life tasks share one shelf');
  assert.equal(await shelf.locator('.row-context').filter({ hasText: '生活世界 › 買い物' }).count(), 1);
  assert.equal(await page.locator('#life-world-heading').count(), 1, 'no duplicate heading or label anchor');
  const snapshot = await page.evaluate(() => globalThis.fixtureLifeData());
  await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.fixtureLifeData()), snapshot, 'filing again is idempotent');
  const bread = world.locator('.row-title').filter({ hasText: 'パン' });
  await bread.focus(); await bread.press('ArrowDown');
  assert.equal(await ordinary.evaluate(el => el === document.activeElement), true, 'All keyboard navigation continues into the shared shelf');
  await ordinary.press('ArrowDown');
  assert.equal(await shelf.locator('.life-row .row-title').first().evaluate(el => el === document.activeElement), true);
  await shelf.getByRole('button', { name: 'フォーを食べたいを未完了に戻す', exact: true }).click();
  assert.equal(await world.getByRole('button', { name: 'フォーを食べたいを完了にする', exact: true }).count(), 1);
  const wish = world.locator('.row-title').filter({ hasText: 'フォーを食べたい' });
  await wish.press('Control+Enter'); await wish.press('Alt+c');
  assert.equal(await shelf.getByRole('button', { name: 'フォーを食べたいを未完了に戻す', exact: true }).count(), 1, 'Alt-C works from a life task');
  await page.getByRole('button', { name: /完了済み/, exact: false }).click();
  await shelf.locator('.life-row').first().waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('textbox', { name: 'タスクを検索', exact: true }).fill('フォー');
  await page.getByRole('textbox', { name: 'タスクを検索', exact: true }).press('Enter');
  const panel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  await panel.waitFor();
  assert.equal(await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).inputValue(), 'フォーを食べたい');
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.reload(); await shelf.waitFor();
  assert.equal(await shelf.locator('.life-row').count(), 3, 'filed state and open shelf survive reload');
  assert.equal(await world.locator('.life-row').count(), 2);
  await page.getByRole('tab', { name: /today/ }).click();
  assert.equal(await shelf.locator('.life-row').count(), 3, 'Today has the same filing behavior');
  await page.getByRole('button', { name: '翌日', exact: true }).click();
  assert.equal(await world.getByRole('button', { name: '散歩を完了にする', exact: true }).count(), 1, 'daily habit returns on its next day');
  assert.equal(await shelf.locator('.life-row').count(), 2, 'single tasks remain filed on subsequent days');
  assert.equal(await world.locator('.life-streak-dot.is-done').count(), 1, 'yesterday remains completed in the seven-day streak');
  await world.getByRole('button', { name: '散歩を完了にする', exact: true }).click();
  await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
  assert.equal(await shelf.locator('.life-row').count(), 3);
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  for (const [theme, width] of [['black', 1280], ['white', 390], ['original', 320]]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.setViewportSize({ width, height: 960 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width}: no horizontal overflow`);
    await page.screenshot({ path: `/private/tmp/bizencore-life-filing-${theme}-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Passed: shared completed shelf via button/Alt-C, unfinished/locked parent, uncheck restore, idempotency/reload, shared All keyboard navigation, filed-task search/details, Today rollover/streak preservation and desktop/mobile themes. No real accounts or external network.');
} finally { await browser.close(); }
