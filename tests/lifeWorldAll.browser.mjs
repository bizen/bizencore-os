import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { SettingsPanel } from './src/components/SettingsPanel';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    import { applyTheme } from './src/lib/theme';
    let now = '2026-10-05'; Date.now = () => Date.parse(now + 'T12:00:00Z');
    applyTheme('black'); setUserTimeZone('UTC');
    globalThis.fixtureHideLife = () => lifeWorldStore.setShowInAll(false);
    const items = [
      { id: 'first-label', text: 'ビルド', type: 'section', parentId: null, order: 0 },
      { id: 'ordinary', text: '作業', type: 'task', parentId: 'first-label', order: 0 },
      { id: 'second-label', text: '大学', type: 'section', parentId: null, order: 1 },
    ];
    taskStore.mergeRemote(items.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify({ done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    if (!Object.keys(lifeWorldStore.getSnapshot().data.entries).length) {
      const groceries = lifeWorldStore.add(now); lifeWorldStore.setText(groceries, 'Grocery shopping');
      const habit = lifeWorldStore.add(now); lifeWorldStore.setText(habit, '散歩'); lifeWorldStore.setRepeat(habit, 'daily');
      const weekday = lifeWorldStore.add(now); lifeWorldStore.setText(weekday, '平日の読書'); lifeWorldStore.setRepeat(weekday, 'weekdays');
    }
    function Fixture() {
      const [settings, setSettings] = useState(false), [day, setDay] = useState(now), [theme, setTheme] = useState('black');
      return <div className="app-shell"><header className="app-header"><button onClick={() => setSettings(true)}>設定</button>
        <button onClick={() => { now = '2026-10-06'; setDay(now); }}>翌日</button>
        <button onClick={() => { now = '2026-10-10'; setDay(now); }}>土曜</button></header>
        <main className="app-main"><TasksPage key={day} /></main>
        {settings ? <SettingsPanel onClose={() => setSettings(false)} theme={theme} onThemeChange={value => { setTheme(value); applyTheme(value); }} /> : null}
      </div>;
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
  await page.route('**/*', route => route.request().url() === 'https://life-all.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
  await page.goto('https://life-all.test/');
  const world = page.locator('.life-world');
  assert.equal(await world.count(), 0, 'All defaults to hidden');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const setting = page.getByRole('checkbox', { name: 'Allに表示する', exact: true });
  assert.equal(await setting.isChecked(), false);
  await setting.check();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await world.waitFor();
  assert.equal(await world.getByRole('textbox', { name: '生活タスク', exact: true }).count(), 3);
  const headingOrder = () => page.locator('.tasks-content [data-row-id="first-label"], .tasks-content [data-row-id="second-label"], .tasks-content .life-world')
    .evaluateAll(elements => elements.map(el => el.dataset.rowId ?? 'life'));
  assert.deepEqual(await headingOrder(), ['first-label', 'second-label', 'life']);
  await world.getByRole('button', { name: '生活世界ラベルを上へ移動', exact: true }).click();
  assert.deepEqual(await headingOrder(), ['first-label', 'life', 'second-label']);
  await world.getByRole('button', { name: '生活世界ラベルを上へ移動', exact: true }).click();
  assert.deepEqual(await headingOrder(), ['life', 'first-label', 'second-label']);
  assert.equal(await world.getByRole('button', { name: '生活世界ラベルを上へ移動', exact: true }).isDisabled(), true);
  await world.getByRole('button', { name: '生活世界ラベルを下へ移動', exact: true }).click();
  await page.reload(); await world.waitFor();
  assert.deepEqual(await headingOrder(), ['first-label', 'life', 'second-label'], 'position and visibility survive reload');
  assert.equal(await world.locator('.color-popover, .meta-color').count(), 0, 'no color control');
  const groceries = world.getByRole('textbox', { name: '生活タスク', exact: true }).first();
  await groceries.press('Control+i');
  const panel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  const lock = panel.getByRole('switch', { name: 'タスクロック', exact: true });
  await lock.click(); assert.equal(await lock.getAttribute('aria-checked'), 'true');
  assert.equal(await panel.getByRole('button', { name: /の生活タスクを完了にする/ }).isDisabled(), true);
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  const groceryRow = groceries.locator('..').locator('..');
  assert.equal(await groceryRow.locator('.check').count(), 0);
  assert.equal(await groceryRow.getByRole('img', { name: 'ロック中・完了不可', exact: true }).count(), 1);
  await groceries.press('Control+Enter');
  assert.equal(await groceryRow.locator('.is-checked').count(), 0, 'keyboard cannot complete locked tasks');
  await page.getByRole('button', { name: '翌日', exact: true }).click();
  assert.equal(await groceries.inputValue(), 'Grocery shopping', 'uncompleted task carries into tomorrow');
  await groceries.press('Control+i'); await panel.waitFor();
  await lock.click(); await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await groceries.press('Control+Enter');
  await page.getByRole('button', { name: '土曜', exact: true }).click();
  assert.equal(await world.getByRole('button', { name: 'Grocery shoppingを未完了に戻す', exact: true }).count(), 1, 'single task remains complete');
  assert.equal(await world.getByRole('button', { name: '散歩を完了にする', exact: true }).count(), 1, 'habits are still per-day');
  assert.equal(await world.getByRole('textbox', { name: '生活タスク', exact: true }).count(), 3, 'All also includes off-schedule weekday habits');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('textbox', { name: 'タスクを検索', exact: true }).fill('Grocery');
  await page.getByRole('textbox', { name: 'タスクを検索', exact: true }).press('Enter');
  await panel.waitFor();
  assert.equal(await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).inputValue(), 'Grocery shopping');
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.getByRole('tab', { name: /today/ }).click();
  assert.equal(await world.getByRole('textbox', { name: '生活タスク', exact: true }).count(), 2, 'Today keeps weekday scheduling');
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width}: no horizontal overflow`);
      const bounds = await world.locator('.life-world-heading h2, .life-section-actions, .life-world-heading > button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      for (let a = 0; a < bounds.length; a++) for (let b = a + 1; b < bounds.length; b++) {
        const x = bounds[a], y = bounds[b];
        assert.ok(x.right <= y.left + 1 || y.right <= x.left + 1 || x.bottom <= y.top + 1 || y.bottom <= x.top + 1, `${theme}/${width}: controls do not overlap`);
      }
      await page.screenshot({ path: `/private/tmp/bizencore-life-all-${theme}-${width}.png`, fullPage: true });
    }
  }
  await world.getByRole('button', { name: 'Allで生活世界を非表示にする', exact: true }).click();
  assert.equal(await world.count(), 0);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await setting.check();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await groceries.press('Control+i'); await panel.waitFor();
  // Simulate a visibility update arriving from another device while details are open.
  await page.evaluate(() => globalThis.fixtureHideLife());
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await world.count(), 0);
  await page.getByRole('tab', { name: 'all', exact: true }).press('Alt+3');
  assert.equal(await page.getByRole('tab', { name: /today/ }).getAttribute('aria-selected'), 'true', 'hiding the label closes the inspector and releases keyboard navigation');
  assert.equal(await panel.count(), 0, 'reenabling life display never reopens stale details');
  await page.getByRole('tab', { name: /today/ }).click();
  await world.waitFor();
  await page.getByRole('tab', { name: 'board', exact: true }).click();
  assert.equal(await world.count(), 0, 'Board stays unchanged');
  assert.deepEqual(errors, []);
  console.log('Passed: All opt-in setting, whole-label reorder/persistence, lock/unlock/keyboard guards, persistent single completion, daily and weekday habits, search-to-inspector, 3 themes/desktop/mobile and Today/Board regressions; no real accounts or network.');
} finally { await browser.close(); }
