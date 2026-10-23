import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    setUserTimeZone('UTC');
    window.bizencoreDesktop = { onOpenTask: callback => { window.notificationOpener = callback; return () => { window.notificationOpener = null; }; } };
    window.readdToToday = () => taskStore.toggleToday('carry', new Date(Date.now()).toISOString().slice(0,10));
    const tasks = ['carry', 'finish'].map((id, order) => ({ id, type: 'task', parentId: null, text: id,
      order, assignedDate: '2026-10-21', done: false, createdAt: 1, updatedAt: 1 }));
    taskStore.mergeRemote(tasks.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) })));
    createRoot(document.getElementById('root')).render(<main className="app-main" style={{ paddingTop: '6rem' }}><TasksPage /></main>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }));
  await page.goto('http://today-carry.test/');
  await page.getByRole('tab', { name: /today/ }).click();
  const carry = page.locator('[data-row-id="carry"]');
  const finish = page.locator('[data-row-id="finish"]');
  assert.equal(await carry.locator('.today-carry').innerText(), '+2');
  await finish.getByRole('button', { name: '完了にする', exact: true }).click();
  assert.equal(await finish.count(), 1, 'completed carried task stays visible for the rest of its completion day');
  await page.clock.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  await page.clock.fastForward(60_001);
  assert.equal(await carry.locator('.today-carry').innerText(), '+3');
  assert.equal(await finish.count(), 0, 'completed task leaves Today on the next account day');
  await page.reload();
  await carry.waitFor();
  assert.equal(await carry.locator('.today-carry').innerText(), '+3', 'reopening retains the original date');
  await carry.locator('.meta-today').click();
  assert.equal(await carry.count(), 0, 'carried task can be removed from Today in one click');
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  assert.equal(await carry.count(), 1, 'removing from Today does not delete the task');
  assert.equal(await finish.count(), 1, 'completed task still exists in all');
  await page.evaluate(() => window.notificationOpener('carry'));
  await page.locator('.inspector').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.readdToToday(); window.notificationOpener(null); });
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('today'));
  assert.equal(await page.getByRole('button', { name: '先頭タスクを読み上げ' }).count(), 0);
  await page.goto('http://today-carry.test/?task=carry');
  await page.locator('.inspector').waitFor();
  assert.equal(new URL(page.url()).searchParams.has('task'), false, 'deep link is consumed after opening the matching task');
  assert.deepEqual(errors, []);
  console.log('Passed: +2 → +3 at midnight, completion retained until next day, reload persistence, removal from Today and original tasks preserved.');
} finally { await browser.close(); }
