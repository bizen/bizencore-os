import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    createRoot(document.getElementById('root')).render(<MemoryRouter><App /></MemoryRouter>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const fonts = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap';
const html = `<title>bizencore terminal</title><link rel="stylesheet" href="${fonts}"><style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://brand.test') return route.fulfill({ contentType: 'text/html', body: html });
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  await page.goto('http://brand.test/');
  assert.equal(await page.locator('.splash-wordmark .brand').textContent(), 'bizencoreterminal');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  const loadedFonts = await page.evaluate(async () => {
    const normal = await document.fonts.load('17px "Instrument Serif"');
    const italic = await document.fonts.load('italic 17px "Instrument Serif"');
    return { normal: normal.length, italic: italic.length };
  });
  assert.ok(loadedFonts.normal > 0 && loadedFonts.italic > 0, 'actual regular and italic Instrument Serif fonts load');
  const brand = page.locator('.app-header .brand');
  assert.equal(await brand.getAttribute('aria-label'), 'bizencore terminal');
  const type = await brand.locator('.brand-bizen, i, .brand-product').evaluateAll(elements => elements.map(el => {
    const style = getComputedStyle(el);
    return { family: style.fontFamily, style: style.fontStyle, weight: style.fontWeight, size: style.fontSize };
  }));
  assert.ok(type.every(style => style.family.includes('Instrument Serif') && style.weight === '400' && style.size === '17px'));
  assert.deepEqual(type.map(style => style.style), ['normal', 'italic', 'normal']);
  // Exercise the signed-in header's extra avatar width without authenticating or reading user data.
  await page.locator('.app-header-end').evaluate(el => {
    const avatar = document.createElement('span'); avatar.className = 'app-header-auth';
    avatar.style.cssText = 'width:28px;height:28px;border:1px solid var(--border-color);border-radius:50%';
    el.append(avatar);
  });
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const rectangles = await page.locator('.app-header > .brand, .app-header-end').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      const [left, right] = rectangles;
      assert.ok(left.right <= right.left + 1 || left.bottom <= right.top + 1, `header does not overlap: ${theme}/${width}`);
      assert.ok(left.left >= 0 && right.right <= width + 1 && left.right <= width + 1, 'header fits viewport');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      await page.screenshot({ path: `/private/tmp/bizencore-terminal-brand-${theme}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: real regular/italic Instrument Serif fonts, only core italic, terminal name, shared splash/header, signed-in header width, 3 themes at 1280/390/375/320px.');
} finally { await browser.close(); }
