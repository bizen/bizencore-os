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
    import { applyTheme } from './src/lib/theme';
    const today = '2026-10-07'; Date.now = () => Date.parse(today + 'T12:00:00Z');
    applyTheme('black'); setUserTimeZone('UTC');
    const item = { id: 'ordinary', text: '作業', type: 'task', parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1 };
    taskStore.mergeRemote([{ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) }]);
    if (!Object.keys(lifeWorldStore.getSnapshot().data.entries).length) {
      const add = (text, date, repeat) => { const id = lifeWorldStore.add(date); lifeWorldStore.setText(id, text); lifeWorldStore.setRepeat(id, repeat); return id; };
      const daily = add('毎日の運動', '2026-10-01', 'daily');
      const child = lifeWorldStore.add('2026-10-01', daily, true, true); lifeWorldStore.setText(child, '子タスク'); lifeWorldStore.setRepeat(child, 'once');
      add('最近始めた習慣', '2026-10-05', 'daily'); add('平日の読書', '2026-10-01', 'weekdays');
      const locked = add('ロック中の習慣', '2026-10-01', 'daily'); lifeWorldStore.setLocked(locked, true, today);
      add('単発の予定', '2026-10-01', 'once');
      lifeWorldStore.setHabitDayDone(daily, today, true, today); lifeWorldStore.fileCompleted(today);
      lifeWorldStore.setShowInAll(true);
    }
    globalThis.fixtureLifeData = () => lifeWorldStore.getSnapshot().data;
    createRoot(document.getElementById('root')).render(<div className="app-shell"><main className="app-main"><TasksPage /></main></div>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://life-history.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
  await page.goto('https://life-history.test/');
  const world = page.locator('.life-world');
  const panel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  const entry = async text => page.evaluate(text => Object.values(globalThis.fixtureLifeData().entries).find(entry => entry.text === text), text);
  const open = async text => {
    const value = await entry(text);
    await world.locator(`[data-life-id="${value.id}"] .meta-inspect`).click(); await panel.waitFor();
    return value.id;
  };
  const close = () => panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  const day = date => panel.locator('.life-inspector-week').getByRole('button', { name: new RegExp(`^${date}`) });
  const daily = await open('毎日の運動');
  assert.equal(await panel.locator('.life-streak-day').count(), 7);
  assert.deepEqual(await panel.locator('.life-streak-day time').evaluateAll(elements => elements.map(el => el.dateTime)),
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(await world.locator('.life-streak-day').count(), 0, 'list streaks remain read-only');
  const before = await page.evaluate(() => globalThis.fixtureLifeData());
  await day('2026-10-01').click();
  assert.equal(await day('2026-10-01').getAttribute('aria-pressed'), 'true');
  assert.equal(await day('2026-10-01').evaluate(el => el === document.activeElement), true, 'editing retains the selected day focus');
  const after = await page.evaluate(() => globalThis.fixtureLifeData());
  assert.deepEqual(after.checks[`${daily}:2026-10-07`], before.checks[`${daily}:2026-10-07`], 'today keeps its done and filed state');
  const child = await entry('子タスク');
  assert.equal(Object.values(after.checks).some(check => check.entryId === child.id), false, 'history never completes descendants');
  assert.equal(await world.locator(`[data-life-id="${daily}"] .life-streak-dot.is-done`).count(), 2, 'list circles update immediately');
  await day('2026-10-01').press('Enter'); assert.equal(await day('2026-10-01').getAttribute('aria-pressed'), 'false');
  await day('2026-10-01').press('Space'); assert.equal(await day('2026-10-01').getAttribute('aria-pressed'), 'true');
  await day('2026-10-01').press('Tab'); assert.equal(await day('2026-10-02').evaluate(el => el === document.activeElement), true);
  await day('2026-10-02').click();
  await panel.getByRole('button', { name: '生活世界の操作を元に戻す', exact: true }).click();
  assert.equal(await day('2026-10-02').getAttribute('aria-pressed'), 'false');
  assert.equal(await day('2026-10-01').getAttribute('aria-pressed'), 'true', 'undo changes only the last edited day');
  await close(); await page.reload(); await open('毎日の運動');
  assert.equal(await day('2026-10-01').getAttribute('aria-pressed'), 'true', 'history edits survive reload');
  await day('2026-10-07').click();
  assert.equal((await page.evaluate(() => globalThis.fixtureLifeData())).checks[`${daily}:2026-10-07`].filed, undefined);
  await day('2026-10-07').click();
  assert.equal(await day('2026-10-07').getAttribute('aria-pressed'), 'true');
  await close(); await open('最近始めた習慣');
  assert.equal(await panel.locator('.life-streak-day:disabled').count(), 4, 'pre-creation days are unavailable');
  await close(); await open('平日の読書');
  assert.equal(await day('2026-10-03').isDisabled(), true); assert.equal(await day('2026-10-04').isDisabled(), true);
  assert.equal(await panel.locator('.life-streak-day:disabled').count(), 2);
  await day('2026-10-02').click(); assert.equal(await day('2026-10-02').getAttribute('aria-pressed'), 'true');
  await close(); await open('ロック中の習慣');
  assert.equal(await panel.locator('.life-streak-day:disabled').count(), 7, 'locks cannot be bypassed with historical edits');
  await close(); await open('単発の予定');
  assert.equal(await panel.locator('.life-inspector-week').count(), 0, 'one-off tasks have no history editor');
  await close(); await open('毎日の運動');
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await panel.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width}: no horizontal overflow`);
      const bounds = await panel.locator('.life-streak-day').evaluateAll(elements => elements.map(el => {
        const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, height: box.height, scroll: el.scrollWidth };
      }));
      const box = await panel.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      for (let index = 0; index < bounds.length; index++) {
        const day = bounds[index];
        assert.ok(day.left >= box.left && day.right <= box.right && day.height >= 44 && day.scroll <= day.width + 1, `${theme}/${width}: date control fits`);
        if (index) assert.ok(bounds[index - 1].right <= day.left, `${theme}/${width}: dates do not overlap`);
      }
      await page.screenshot({ path: `/private/tmp/bizencore-life-history-${theme}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: editable last-seven-day habit dates, click/Enter/Space/Tab, immediate list streaks, one-day-only updates, filed-state isolation, undo/reload, pre-start/weekend/lock guards, one-off exclusion and 3 themes/desktop/mobile. No accounts or external network.');
} finally { await browser.close(); }
