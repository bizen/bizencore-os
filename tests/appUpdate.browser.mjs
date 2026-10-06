import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    import { taskStore } from './src/lib/taskStore';
    import { applyTheme, readTheme } from './src/lib/theme';
    applyTheme(readTheme());
    const item = { id: 'update-fixture', text: 'Sample task', type: 'task', parentId: null,
      order: 0, done: false, createdAt: 1, updatedAt: 1 };
    taskStore.mergeRemote([{ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) }]);
    createRoot(document.getElementById('root')).render(<MemoryRouter><App /></MemoryRouter>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}', 'import.meta.env.VITE_APP_BUILD_ID': 'window.__fixtureBuild' },
});
const source = await readFile('index.html', 'utf8');
const css = await readFile('src/index.css', 'utf8');
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let published = 'current', served = 'current', broken = false, checks = 0, navigations = 0;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.continue();
    if (url.origin !== 'http://app-update.test') return route.abort();
    if (url.pathname === '/version.json') {
      checks++;
      return route.fulfill({ status: broken ? 500 : 200, contentType: 'application/json', body: JSON.stringify({ buildId: published }) });
    }
    if (url.pathname !== '/' && url.pathname !== '/count') return route.abort();
    navigations++;
    const html = source.replace('<script type="module" src="/src/main.tsx"></script>', () =>
      `<style>${css}</style><script>window.__fixtureBuild=${JSON.stringify(served)};</script><script>${script}</script>`);
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://app-update.test/');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  await page.evaluate(async () => { await document.fonts.load('17px "Instrument Serif"'); await document.fonts.load('italic 17px "Instrument Serif"'); });
  const update = page.getByRole('button', { name: '新版に更新', exact: true });
  assert.equal(await update.count(), 0, 'current build has no update button');
  assert.equal(checks, 1);
  published = 'next';
  await page.clock.fastForward(180_001);
  await update.waitFor({ state: 'visible' });
  assert.equal(navigations, 1, 'publishing never reloads without user action');
  await page.locator('.app-header-end').evaluate(el => {
    const avatar = document.createElement('span'); avatar.className = 'app-header-auth';
    avatar.style.cssText = 'width:28px;height:28px;border:1px solid var(--border-color);border-radius:50%'; el.append(avatar);
  });
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [390, 375, 320, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const [brand, controls] = await page.locator('.app-header > .brand, .app-header-end').evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }));
      assert.ok(brand.right <= controls.left + 1 || brand.bottom <= controls.top + 1, `header does not overlap: ${theme}/${width}`);
      assert.ok(controls.right <= width + 1 && controls.left >= 0, 'header controls fit');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      await page.screenshot({ path: `/private/tmp/bizencore-update-${theme}-${width}.png` });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'black'; });
  await page.setViewportSize({ width: 1280, height: 844 });
  const title = page.locator('.row--task').getByRole('textbox', { name: 'タスク', exact: true });
  await title.fill('Saved before manual update');
  await title.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const beforeComposing = checks;
  await update.click();
  assert.equal(checks, beforeComposing, 'IME composition blocks update');
  await title.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
  });
  let dialogEvent = page.waitForEvent('dialog');
  await update.click();
  let dialog = await dialogEvent;
  assert.match(dialog.message(), /保存に失敗/);
  await dialog.accept();
  await page.waitForFunction(() => !document.querySelector('.app-update-btn')?.disabled);
  assert.equal(navigations, 1, 'storage failure blocks reload');
  await page.evaluate(() => window.__restoreStorage());

  await page.locator('.meta-inspect').first().click();
  const panel = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
  const draft = panel.getByRole('textbox', { name: 'コンテキストを添える', exact: true });
  await draft.fill('Not attached yet');
  dialogEvent = page.waitForEvent('dialog');
  // Keyboard activation also respects drafts while a side panel is open.
  await update.focus(); await page.keyboard.press('Enter');
  dialog = await dialogEvent; assert.equal(dialog.type(), 'confirm');
  await dialog.dismiss();
  await page.waitForFunction(() => !document.querySelector('.app-update-btn')?.disabled);
  assert.equal(navigations, 1);
  assert.equal(await draft.inputValue(), 'Not attached yet', 'cancel preserves unattached text');
  await draft.fill('');
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();

  // Rollback and failed checks remove the indicator; reconnect discovers the next build.
  published = 'current';
  await page.clock.fastForward(180_001); await update.waitFor({ state: 'hidden' });
  published = 'next'; broken = true;
  await page.clock.fastForward(180_001);
  const afterFailure = checks;
  await page.waitForTimeout(100);
  assert.equal(await update.count(), 0);
  broken = false;
  await page.clock.fastForward(10_001);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await update.waitFor({ state: 'visible' });
  assert.ok(checks > afterFailure);
  served = 'next';
  const navigation = page.waitForEvent('framenavigated');
  await update.click(); await navigation;
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(navigations, 2, 'one explicit click reloads once');
  assert.equal(await title.inputValue(), 'Saved before manual update', 'latest edits survive reload');
  assert.equal(await update.count(), 0, 'new build no longer offers an update');
  assert.deepEqual(errors, []);
  console.log('Passed: current/new builds, polling, no automatic reload, IME protection, save failure and draft cancellation, rollback/failure/reconnect, one manual reload with preserved task text, real fonts and signed-in header width in 3 themes/390/375/320/1280px.');
} finally { await browser.close(); }
