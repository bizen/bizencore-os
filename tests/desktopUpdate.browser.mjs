import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import { createRoot } from 'react-dom/client';
  import { DesktopUpdateButton } from './src/components/DesktopUpdateButton';
  window.fixture = { version: '0.1.8', opens: 0, checks: 0 };
  window.bizencoreDesktop = {
    checkUpdate: async () => { window.fixture.checks++; return window.fixture.version ? { version: window.fixture.version } : null; },
    openUpdate: async () => { window.fixture.opens++; },
  };
  if (location.search.includes('automatic')) Object.assign(window.bizencoreDesktop, {
    downloadUpdate: () => { window.fixture.downloads = (window.fixture.downloads || 0) + 1; return new Promise(resolve => { window.fixture.finish = () => resolve({ version: '0.1.19' }); }); },
    installUpdate: async () => { window.fixture.installs = (window.fixture.installs || 0) + 1; if (window.fixture.installError) throw Error(window.fixture.installError); return window.fixture.installResult || false; },
    onUpdateProgress: callback => { window.fixture.progress = callback; return () => { window.fixture.progress = null; }; },
  });
  createRoot(document.getElementById('root')).render(<header className="app-header">
    <span className="brand">bizen<i>core</i> terminal<sup>2</sup></span>
    <div className="app-header-tools"><DesktopUpdateButton /><button className="app-settings-btn" aria-label="設定">S</button></div>
  </header>);
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } });
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  await page.route('https://update.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }));
  await page.goto('https://update.test/');
  const button = page.getByRole('button', { name: '新版 0.1.8 の配布ページを開く' });
  await button.waitFor();
  await button.click();
  assert.equal(await page.evaluate(() => window.fixture.opens), 1);
  assert.equal(await button.isEnabled(), true);
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-update-desktop.png' });
  await page.setViewportSize({ width: 390, height: 700 });
  const box = await button.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-update-mobile.png' });
  await page.evaluate(() => { window.fixture.version = null; window.dispatchEvent(new Event('focus')); });
  await button.waitFor({ state: 'hidden' });
  await page.evaluate(() => { window.fixture.version = '0.1.9'; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('button', { name: '新版 0.1.9 の配布ページを開く' }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  assert.equal(await page.locator('.app-update-btn').count(), 0);
  await page.goto('https://update.test/?automatic');
  await page.getByRole('button', { name: '新版 0.1.8 をダウンロード', exact: true }).click();
  await page.evaluate(() => window.fixture.progress(42));
  const downloading = page.getByRole('button', { name: '新版 0.1.8 をダウンロード中 42%', exact: true });
  assert.equal(await downloading.isEnabled(), false);
  assert.equal(await downloading.textContent(), '42%');
  assert.equal(await page.evaluate(() => window.fixture.installs || 0), 0, 'download never quits an active app');
  await page.evaluate(() => window.fixture.finish());
  const restart = page.getByRole('button', { name: '再起動して 0.1.19 に更新', exact: true }); await restart.waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await restart.waitFor();
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => { const busy = document.createElement('button'); busy.className = 'context-upload-btn'; busy.setAttribute('aria-busy', 'true'); document.body.append(busy); });
  await restart.click();
  assert.equal(await page.evaluate(() => window.fixture.installs || 0), 0, 'in-flight uploads prevent restart');
  await page.evaluate(() => document.querySelector('.context-upload-btn').remove());
  await page.evaluate(() => {
    window.fixture.prevent = event => event.preventDefault();
    window.addEventListener('bizencore:before-reload', window.fixture.prevent);
  });
  await restart.click();
  assert.equal(await page.evaluate(() => window.fixture.installs || 0), 0, 'failed workspace saves prevent restart');
  await page.evaluate(() => window.removeEventListener('bizencore:before-reload', window.fixture.prevent));
  await restart.click(); await restart.waitFor();
  assert.equal(await page.evaluate(() => window.fixture.installs), 1);
  assert.equal(await page.evaluate(() => window.fixture.opens), 0, 'in-app installation does not open the download page');
  assert.equal(await restart.isEnabled(), true, 'cancelling shutdown retains the downloaded update');
  const messages=[]; page.on('dialog', dialog => { messages.push(dialog.message()); });
  await page.evaluate(() => { window.fixture.installError = 'Error invoking remote method: BIZENCORE_UPDATE:更新の準備状態が失われました。'; });
  await restart.click(); await restart.waitFor();
  assert.equal(messages.at(-1), '更新の準備状態が失われました。');
  await page.evaluate(() => { window.fixture.installError = null; });
  await page.evaluate(() => { window.fixture.installResult = true; });
  const installsBeforeSuccess = await page.evaluate(() => window.fixture.installs);
  await restart.evaluate(el => { el.click(); el.click(); });
  assert.equal(await page.evaluate(() => window.fixture.installs), installsBeforeSuccess + 1, 'rapid repeated clicks launch one install');
  await page.getByRole('button', {name: 'アプリを更新しています', exact:true}).waitFor();
  assert.equal(await page.locator('.app-update-btn').isDisabled(), true, 'approved update stays disabled until process exits');
  console.log('Update UI: legacy fallback, progress, explicit restart, upload guard, cancelled restart, offline readiness and responsive layout passed.');
} finally { await browser.close(); }
