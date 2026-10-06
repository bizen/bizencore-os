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
    import { setUserTimeZone } from './src/lib/userTimeZone';
    Date.now = () => Date.parse('2026-10-05T12:00:00Z');
    setUserTimeZone('UTC');
    const item = { id: 'ordinary', text: 'いつもの作業', type: 'task', parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1, assignedDate: '2026-10-05' };
    taskStore.mergeRemote([{ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) }]);
    function Fixture() {
      const [day, setDay] = useState('2026-10-05');
      const next = (value) => { Date.now = () => Date.parse(value + 'T12:00:00Z'); setDay(value); };
      return <><div id="fixture-controls"><button onClick={() => next('2026-10-06')}>Fixture tomorrow</button><button onClick={() => next('2026-10-05')}>Fixture original day</button></div><TasksPage key={day} /></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}\n#fixture-controls { padding: 12px; } .page { max-width: 840px; margin: auto; padding: 16px; }</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Entirely isolated fixture: storage has an origin, and no network request can leave it.
  await page.route('**/*', route => route.request().url() === 'http://life-world.test/'
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto('http://life-world.test/');
  assert.equal(await page.locator('.life-world').count(), 0);
  assert.equal(await page.getByRole('button', { name: '+ ラベル（⌥S）', exact: true }).count(), 1);
  await page.getByRole('tab', { name: /today/ }).click();
  assert.equal(await page.getByRole('button', { name: '+ ラベル（⌥S）', exact: true }).count(), 0, 'Today does not offer label creation');
  await page.getByRole('textbox', { name: 'タスク', exact: true }).press('Alt+s');
  assert.equal(await page.getByRole('tab', { name: /today/ }).getAttribute('aria-selected'), 'true', 'label shortcut cannot leave Today');
  assert.equal(await page.getByRole('textbox', { name: 'ラベル', exact: true }).count(), 0, 'label shortcut cannot create a label in Today');
  const world = page.locator('.life-world');
  const panel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  await world.getByRole('button', { name: '生活世界に追加', exact: true }).click();
  const titles = world.getByRole('textbox', { name: '生活タスク', exact: true });
  await titles.first().fill('フォーを食べたい');
  await titles.first().press('Enter');
  await titles.nth(1).fill('ストレッチ');
  await world.getByRole('button', { name: '生活タスクの詳細', exact: true }).nth(1).click();
  assert.equal(await panel.getAttribute('class'), 'inspector', 'life tasks share the ordinary inspector shell');
  assert.equal(await world.locator('.life-details').count(), 0, 'no second inline editor');
  assert.equal(await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).evaluate(el => el === document.activeElement), true);
  await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).press('Tab');
  assert.equal(await panel.getByRole('textbox', { name: '生活タスクのメモ' }).evaluate(el => el === document.activeElement), true, 'Tab navigates within details');
  await panel.getByRole('combobox', { name: '繰り返し' }).focus();
  await panel.getByRole('combobox', { name: '繰り返し' }).press('ArrowDown');
  assert.equal(await panel.getByRole('combobox', { name: '繰り返し' }).evaluate(el => el === document.activeElement), true, 'select keeps native arrow navigation');
  await panel.getByRole('combobox', { name: '繰り返し' }).selectOption('daily');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).fill('肩と背中をゆっくり伸ばす。');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '生活タスク');
  assert.equal(await world.getByRole('textbox', { name: '生活タスクのメモ' }).count(), 0);
  await titles.nth(1).press('Control+Enter');
  assert.equal(await world.getByRole('button', { name: 'ストレッチを未完了に戻す', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await world.locator('.life-streak-dot').count(), 7);
  assert.equal(await world.locator('.life-streak-dot.is-today.is-done').count(), 1);
  assert.equal(await world.locator('.life-streak-dot.is-inactive').count(), 6);
  assert.equal(await page.locator('.tasks-count b').first().textContent(), '1');

  await titles.first().evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true })));
  assert.equal(await titles.count(), 2, 'IME confirmation cannot insert another row');
  await page.reload();
  await world.waitFor();
  assert.equal(await titles.first().inputValue(), 'フォーを食べたい');
  assert.equal(await world.getByRole('button', { name: 'ストレッチを未完了に戻す', exact: true }).count(), 1);

  await page.getByRole('button', { name: 'Fixture tomorrow', exact: true }).click();
  assert.equal(await titles.count(), 1);
  assert.equal(await titles.first().inputValue(), 'ストレッチ');
  assert.equal(await world.getByRole('button', { name: 'ストレッチを完了にする', exact: true }).count(), 1);
  assert.equal(await world.locator('.life-streak-dot.is-today.is-done').count(), 0);
  assert.equal(await world.locator('.life-streak-dot.is-done').count(), 1);
  await world.getByRole('button', { name: '生活世界の前日を見る', exact: true }).click();
  assert.equal(await titles.count(), 2);
  assert.equal(await world.getByRole('button', { name: 'ストレッチを未完了に戻す', exact: true }).count(), 1);
  await world.getByRole('button', { name: '今日', exact: true }).click();
  assert.equal(await titles.count(), 1);

  await page.getByRole('button', { name: 'Fixture original day', exact: true }).click();
  await world.getByRole('button', { name: '生活タスクの詳細', exact: true }).first().click();
  await panel.getByRole('button', { name: '生活タスクを下へ移動', exact: true }).click();
  assert.equal(await titles.first().inputValue(), 'ストレッチ');
  await panel.getByRole('button', { name: '生活タスクを削除', exact: true }).click();
  assert.equal(await titles.count(), 1);
  await world.getByRole('button', { name: '生活世界の操作を元に戻す', exact: true }).click();
  assert.equal(await titles.count(), 2);
  const longTitle = '今日はフォーを食べて、帰りに本屋へ寄って、気になる本を少し眺めたい。'.repeat(4);
  await titles.nth(1).fill(longTitle);
  await world.getByRole('button', { name: '生活タスクの詳細', exact: true }).nth(1).click();
  const longNote = '気楽に過ごしたい日のメモ。\n'.repeat(8);
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).fill(longNote);
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForFunction(() => [...document.querySelectorAll('.inspector textarea')].every(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
      await panel.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const rect = await panel.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, top: r.top }; });
      assert.ok(rect.left >= 0 && rect.right <= width + 1 && rect.height <= 961 && rect.top >= 0, `shared inspector fits viewport: ${theme}/${width} ${JSON.stringify(rect)}`);
      assert.equal(await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).inputValue(), longTitle);
      assert.equal(await panel.getByRole('textbox', { name: '生活タスクのメモ' }).inputValue(), longNote);
      assert.equal(await panel.getByRole('textbox', { name: '完了条件', exact: true }).count(), 0);
      assert.equal(await panel.getByRole('textbox', { name: '期限の日付', exact: true }).count(), 0);
    }
  }
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  await titles.nth(1).press('Alt+c');
  assert.equal(await page.locator('[data-row-id="ordinary"]').count(), 1);
  await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
  assert.equal(await titles.count(), 2, 'ordinary completion cleanup leaves life tasks alone');

  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForFunction(() => [...document.querySelectorAll('.life-row .row-title')].every(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} has no horizontal overflow`);
      const rectangles = await world.locator('.life-world-heading h2, .life-date-nav, .life-world-heading > button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
      for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) {
        const x = rectangles[a], y = rectangles[b];
        assert.ok(x.right <= y.x + 1 || y.right <= x.x + 1 || x.bottom <= y.y + 1 || y.bottom <= x.y + 1, 'header controls do not overlap');
      }
      await page.screenshot({ path: `/private/tmp/bizencore-life-world-${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'black'; document.getElementById('fixture-controls').style.display = 'none'; });
  await titles.nth(1).fill('今日の飯はフォーにしたい');
  await world.getByRole('button', { name: '生活タスクの詳細', exact: true }).nth(1).click();
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).fill('帰りに、いつもの店に寄ろう。');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  for (let i = 0; i < 6; i++) await world.getByRole('button', { name: '生活世界の前日を見る', exact: true }).click();
  await world.getByRole('button', { name: '生活世界に追加', exact: true }).click();
  await titles.first().fill('読書');
  const readerId = await titles.first().evaluate(el => el.closest('li').dataset.lifeId);
  await world.getByRole('button', { name: '生活タスクの詳細', exact: true }).first().click();
  await panel.getByRole('combobox', { name: '繰り返し' }).selectOption('daily');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).fill('気になる本を、少しずつ。');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  for (let i = 0; i < 7; i++) {
    if (i % 2 === 0) await world.getByRole('button', { name: '読書を完了にする', exact: true }).click();
    if (i < 6) await world.getByRole('button', { name: '生活世界の翌日を見る', exact: true }).click();
  }
  const reader = world.locator(`[data-life-id="${readerId}"]`);
  assert.equal(await reader.locator('.life-streak-dot').count(), 7);
  assert.equal(await reader.locator('.life-streak-dot.is-done').count(), 4);
  assert.equal(await reader.locator('.life-streak-dot.is-today.is-done').count(), 1);
  assert.equal(await world.locator('.life-streak').count(), 2, 'only habits show a seven-day streak');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.screenshot({ path: `/private/tmp/bizencore-life-world-preview-${width}.png`, fullPage: true });
    await reader.getByRole('button', { name: '生活タスクの詳細', exact: true }).click();
    assert.equal(await panel.locator('.life-streak-dot').count(), 7);
    assert.equal(await panel.locator('.life-streak-dot.is-done').count(), 4);
    await panel.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `/private/tmp/bizencore-life-world-inspector-${width}.png`, fullPage: true });
    await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  }
  await titles.first().press('Control+i');
  await panel.waitFor();
  const ordinary = page.getByRole('textbox', { name: 'タスク', exact: true }).first();
  await ordinary.press('Control+i');
  assert.equal(await panel.count(), 0, 'opening ordinary details closes life details');
  const ordinaryPanel = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
  await ordinaryPanel.waitFor();
  await ordinaryPanel.getByRole('textbox', { name: 'タスク', exact: true }).press('Tab');
  assert.equal(await page.getByRole('switch', { name: 'タスクロック', exact: true }).evaluate(el => el === document.activeElement), true, 'ordinary inspector navigation still works');
  await titles.first().press('Control+i');
  assert.equal(await ordinaryPanel.count(), 0, 'opening life details closes ordinary details');
  await panel.getByRole('textbox', { name: '生活タスクのタイトル' }).press('Escape');
  await titles.first().press('Shift+Enter');
  await panel.waitFor();
  assert.equal(await panel.getByRole('textbox', { name: '生活タスクのメモ' }).evaluate(el => el === document.activeElement), true, 'Shift+Enter opens note in the shared inspector');
  await panel.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  assert.equal(await world.count(), 0);
  assert.equal(await page.getByRole('button', { name: '+ ラベル（⌥S）', exact: true }).count(), 1, 'All still offers label creation');
  assert.equal(await page.getByRole('textbox', { name: 'タスク', exact: true }).count(), 1);
  await page.getByRole('tab', { name: 'board', exact: true }).click();
  assert.equal(await world.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed: Today-only integration, wishes/habits/notes, per-day checks, reload, midnight, date navigation, order/delete/undo, IME, shared inspector navigation/focus/mutual exclusion, full titles, 3 themes at desktop/390/320px; no external network.');
} finally { await browser.close(); }
