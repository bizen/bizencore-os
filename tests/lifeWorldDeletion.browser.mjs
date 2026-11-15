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
    globalThis.fixtureApplyTheme = applyTheme;
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
  for (const [theme, width] of [['black', 1280], ['white', 390], ['original', 320]]) {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'https://life-deletion.test/'
      ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
    await page.goto('https://life-deletion.test/');
    await page.evaluate(value => globalThis.fixtureApplyTheme(value), theme);
    const clear = page.getByRole('button', { name: '完了を削除（⌥⇧C）', exact: true });
    const world = page.locator('.life-world'), shelf = page.locator('.done-shelf');
    await clear.waitFor(); assert.equal(await clear.isDisabled(), true);
    await world.getByRole('button', { name: 'フォーを食べたいを完了にする', exact: true }).click();
    assert.equal(await clear.isEnabled(), true, 'life completion alone enables the shared delete button');
    await clear.click();
    assert.equal(await world.locator('.row-title').filter({ hasText: 'フォーを食べたい' }).count(), 0, 'unfiled completed wish can be deleted');
    assert.equal(await clear.isDisabled(), true);
    await page.locator('[data-row-id="ordinary"] .row-title').press('Control+Enter');
    for (const text of ['牛乳', '散歩']) await world.getByRole('button', { name: text + 'を完了にする', exact: true }).click();
    await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.done-shelf-count')?.textContent === '3');
    const bread = world.locator('.row-title').filter({ hasText: 'パン' });
    await bread.press('Alt+Shift+c');
    await shelf.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-row-id="ordinary"]').count(), 0);
    assert.equal(await world.locator('.life-row').count(), 2, 'locked parent and unfinished sibling remain');
    assert.equal(await clear.isDisabled(), true);
    await page.reload();
    await world.locator('.life-row').first().waitFor();
    assert.equal(await world.locator('.life-row').count(), 2, 'life deletion survives reload');
    const data = await page.evaluate(() => globalThis.fixtureLifeData());
    const habit = Object.values(data.entries).find(entry => entry.text === '散歩');
    assert.equal(habit.deletedAt, undefined);
    assert.equal(data.checks[habit.id + ':2026-10-05'].done, true);
    assert.equal(data.checks[habit.id + ':2026-10-05'].cleared, true);
    await page.getByRole('tab', { name: /today/ }).click();
    await page.getByRole('button', { name: '翌日', exact: true }).click();
    await world.getByRole('button', { name: '散歩を完了にする', exact: true }).waitFor();
    assert.equal(await world.locator('.life-streak-dot.is-done').count(), 1, 'habit returns with its streak preserved');
    await world.getByRole('button', { name: '散歩を完了にする', exact: true }).click();
    await clear.click();
    assert.equal(await world.getByRole('button', { name: '散歩を未完了に戻す', exact: true }).count(), 0, 'Today deletion uses the same action');
    assert.equal(await clear.isDisabled(), true);
    await page.evaluate(value => globalThis.fixtureApplyTheme(value), theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), theme + '/' + width + ': no horizontal overflow');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.row-title')).color === getComputedStyle(document.body).color);
    await page.screenshot({ path: '/private/tmp/bizencore-life-deletion-' + theme + '-' + width + '.png', fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Passed: completed Life World deletion by button/Alt-Shift-C in All/Today, life-only enabled state, shared ordinary/life deletion, locked/unfinished protection, reload, habit rollover/history and three desktop/mobile themes. No real accounts or external network.');
} finally { await browser.close(); }
