import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const longTitle = '公開前の画面を確認して、モバイルで長いタイトルやURLが重ならず、すべて読めることを確かめる。'.repeat(3);
const seed = [
  { id: 'label', type: 'section', text: 'OSビルド' },
  { id: 'ordinary', text: '今日の作業', assignedDate: '2026-10-05' },
  { id: 'overdue', text: '返信する', dueDate: '2026-10-04' },
  { id: 'today', text: longTitle, dueDate: '2026-10-05', dueTime: '18:00' },
  { id: 'tomorrow', text: '仕様を確認する', dueDate: '2026-10-06' },
  { id: 'near', text: 'リリースを準備する', dueDate: '2026-10-08' },
  { id: 'done', text: '完了済み', dueDate: '2026-10-01', done: true },
].map((item, order) => ({ type: 'task', parentId: item.id === 'label' ? null : 'label', order, done: false, createdAt: 1, updatedAt: 1, ...item }));
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    Date.now = () => Date.parse('2026-10-05T12:00:00Z');
    setUserTimeZone('UTC');
    taskStore.mergeRemote(${JSON.stringify(seed)}.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) })));
    createRoot(document.getElementById('root')).render(<TasksPage />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}\n.page { max-width: 840px; margin: auto; padding: 16px; }</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://today-recommendations.test/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto('http://today-recommendations.test/');
  const candidates = page.getByRole('region', { name: '今日の候補' });
  assert.equal(await candidates.count(), 0);
  await page.getByRole('tab', { name: 'board', exact: true }).click();
  assert.equal(await candidates.count(), 0);
  await page.getByRole('tab', { name: /today/ }).click();
  await candidates.waitFor();
  assert.equal(await candidates.locator('li').count(), 3);
  assert.deepEqual(await candidates.locator('.today-recommendation-title').allTextContents(), ['返信する', longTitle, '仕様を確認する']);
  assert.ok((await candidates.textContent()).includes('期限超過 · 10/04'));
  assert.equal(await page.getByRole('button', { name: '+ ラベル（⌥S）', exact: true }).count(), 0);

  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} no horizontal overflow`);
      const titles = await candidates.locator('.today-recommendation-title').evaluateAll(elements => elements.map(el => ({ h: el.clientHeight, sh: el.scrollHeight, w: el.clientWidth, sw: el.scrollWidth, right: el.getBoundingClientRect().right, buttonLeft: el.closest('li').querySelector('button').getBoundingClientRect().left })));
      for (const title of titles) assert.ok(title.sh <= title.h + 1 && title.sw <= title.w + 1 && title.right < title.buttonLeft, 'full titles fit without overlapping add buttons');
      await page.screenshot({ path: `/private/tmp/bizencore-today-recommendations-${theme}-${width}.png`, fullPage: true });
    }
  }
  await candidates.getByRole('button', { name: '返信するをTodayに追加', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: /today/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-row-id="overdue"]').count(), 1);
  assert.equal(await candidates.getByRole('button', { name: '返信するをTodayに追加', exact: true }).count(), 0);
  assert.equal(await candidates.getByRole('button', { name: 'リリースを準備するをTodayに追加', exact: true }).count(), 1, 'next candidate replenishes the list');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'today-recommendation-add', 'focus stays on the next add button');
  await page.reload();
  await candidates.waitFor();
  assert.equal(await page.locator('[data-row-id="overdue"]').count(), 1, 'Today assignment persists');
  assert.equal(await candidates.getByRole('button', { name: '返信するをTodayに追加', exact: true }).count(), 0);
  while (await candidates.getByRole('button').count()) {
    const button = candidates.getByRole('button').first();
    await button.focus();
    await button.press('Enter');
  }
  assert.equal(await candidates.getByRole('status').textContent(), '候補をTodayに追加しました。');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'today-recommendations-heading');
  assert.equal(await page.getByRole('tab', { name: /today/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '完了を削除（⌥⇧C）', exact: true }).count(), 1);
  await page.reload();
  await page.getByRole('tab', { name: /today/ }).waitFor();
  assert.equal(await candidates.count(), 0, 'empty recommendations do not occupy the footer on a fresh visit');
  assert.deepEqual(errors, []);
  console.log('Passed: Today-only deadline recommendations, three-item limit, full long titles across 3 themes and desktop/390/320px, add/refill without navigation, keyboard focus, persistence and empty state; no external network.');
} finally { await browser.close(); }
