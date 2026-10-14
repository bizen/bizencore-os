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
  createRoot(document.getElementById('root')).render(<header className="app-header">
    <span className="brand">bizen<i>core</i> terminal<sup>2</sup></span>
    <div className="app-header-tools"><DesktopUpdateButton /><button className="app-settings-btn" aria-label="設定">S</button></div>
  </header>);
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
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
  console.log('Desktop update header: newer-only visibility, download action, refresh/offline and responsive layout verified without account/network changes.');
} finally { await browser.close(); }
