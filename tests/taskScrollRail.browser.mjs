import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    import { applyTheme } from './src/lib/theme';
    applyTheme('black');
    createRoot(document.getElementById('root')).render(<MemoryRouter><App /></MemoryRouter>);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const now = Date.now();
    const short = location.search.includes('short');
    localStorage.setItem('chrct.tasks.v2', JSON.stringify([
      { id: 'label', type: 'section', text: 'Scroll test', parentId: null, order: 0, color: 'blue', createdAt: now, updatedAt: now },
      ...Array.from({ length: short ? 1 : 70 }, (_, i) => ({ id: 'task-' + i, type: 'task', text: 'Task ' + (i + 1), parentId: 'label', order: i, done: false, createdAt: now, updatedAt: now }))
    ]));
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  for (const width of [1440, 860, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1/');
    await page.locator('.splash-root').waitFor({ state: 'detached' });
    const rail = page.getByRole('scrollbar', { name: 'タスクリストのスクロール位置' });
    await rail.waitFor();
    assert.equal(await rail.locator('.task-scroll-mark').count(), 8);
    assert.equal(await rail.getAttribute('aria-valuenow'), '0');
    assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    const box = await rail.boundingBox();
    assert.equal(box.x, width <= 640 ? 12 : 38, 'rail has breathing room from the left edge');
    assert.ok(Math.abs(box.y + box.height / 2 - 450) < 1, 'rail is vertically centered');
    await page.locator('.row--task .row-title').first().evaluate(element => {
      const rail = document.querySelector('.task-scroll-rail').getBoundingClientRect();
      if (element.getBoundingClientRect().left <= rail.right) throw new Error('Rail must not cover task text');
    });
    await rail.press('End');
    await page.waitForFunction(() => document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow') === '100');
    assert.equal(await rail.locator('.task-scroll-mark').last().getAttribute('class'), 'task-scroll-mark is-current');
    await rail.press('Home');
    await page.waitForFunction(() => document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow') === '0');
    await rail.press('PageDown');
    await page.waitForFunction(() => scrollY > 100);
    await rail.press('Home');
    await page.waitForFunction(() => scrollY === 0);
    await page.mouse.move(box.x + box.width / 2, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 15, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow') === '100');
    await rail.locator('.task-scroll-mark').nth(3).click();
    await page.waitForFunction(() => Number(document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow')) > 30 && Number(document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow')) < 60);
    const beforeWheel = await page.evaluate(() => scrollY);
    await page.mouse.move(width - 40, 450);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(before => scrollY > before, beforeWheel);
    await rail.press('Home');
    await page.waitForFunction(() => document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow') === '0');
    await page.evaluate(() => document.activeElement?.blur());
    for (const theme of ['black', 'white', 'original']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.row--task .row-title')).color === getComputedStyle(document.body).color);
      assert.equal(await rail.locator('.is-current').evaluate(element => getComputedStyle(element, '::before').backgroundColor), await page.locator('body').evaluate(element => getComputedStyle(element).color));
      await page.screenshot({ path: `/private/tmp/bizencore-scroll-rail-${width}-${theme}.png` });
    }
    await page.getByRole('link', { name: 'count', exact: true }).click();
    await rail.waitFor({ state: 'detached' });
    assert.equal(await rail.count(), 0, 'count keeps its native scrolling behavior');
    assert.notEqual(await page.locator('html').evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    await page.getByRole('link', { name: 'tasks', exact: true }).click();
    await rail.waitFor();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1/?short');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('scrollbar').count(), 0, 'short lists have no unnecessary scroll control');
  assert.deepEqual(errors, []);
  console.log('Passed: web scroll rail at four widths, three themes, click/drag/wheel/keyboard, hidden short list and count isolation.');
} finally { await browser.close(); }
