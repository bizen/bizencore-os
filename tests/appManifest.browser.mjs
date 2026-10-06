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
    const rows = Array.from({ length: 24 }, (_, index) => {
      const item = { id: 'fixture-' + index, text: 'Sample task ' + (index + 1), type: 'task', parentId: null,
        order: index, done: false, createdAt: 1, updatedAt: 1 };
      return { itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) };
    });
    taskStore.mergeRemote(rows);
    createRoot(document.getElementById('root')).render(<MemoryRouter><App /></MemoryRouter>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const source = await readFile('index.html', 'utf8');
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = source.replace('<script type="module" src="/src/main.tsx"></script>', () => `<style>${css}</style><script>${script}</script>`);
const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));
const assets = new Map();
for (const path of ['/manifest.webmanifest', '/apple-touch-icon.png', '/favicon.png', ...manifest.icons.map(icon => icon.src)]) {
  assets.set(path, await readFile(`public${path}`));
}
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Test only synthetic tasks; fonts and all other external requests are blocked.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://home-screen.test') return route.abort();
    if (assets.has(url.pathname)) return route.fulfill({
      contentType: url.pathname.endsWith('.png') ? 'image/png' : 'application/manifest+json', body: assets.get(url.pathname),
    });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://home-screen.test/');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'black', 'fresh sessions default to midnight black');
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/manifest.webmanifest');
  assert.equal(await page.locator('link[rel="apple-touch-icon"]').getAttribute('sizes'), '180x180');
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'bizencore');
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes');
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute('content'), 'default');
  const loaded = await page.evaluate(async () => {
    const response = await fetch(document.querySelector('link[rel="manifest"]').href);
    return { type: response.headers.get('content-type'), manifest: await response.json() };
  });
  assert.equal(loaded.type, 'application/manifest+json');
  assert.deepEqual(loaded.manifest, manifest);
  const pixels = await page.evaluate(async paths => {
    const results = [];
    for (const path of paths) {
      const image = new Image();
      image.src = path;
      await image.decode();
      const size = image.naturalWidth;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, size, size);
      let transparent = 0, ink = 0, outside = 0;
      let left = size, right = 0, top = size, bottom = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const at = (y * size + x) * 4;
        if (data[at + 3] !== 255) transparent++;
        if (data[at] > 50) {
          ink++;
          if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > size * 0.4) outside++;
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      results.push({ path, size, transparent, ink, outside, left, right, top, bottom, corner: Array.from(data.slice(0, 4)) });
    }
    return results;
  }, ['/favicon.png', '/apple-touch-icon.png', ...manifest.icons.map(icon => icon.src)]);
  for (const icon of pixels) {
    assert.equal(icon.transparent, 0, `${icon.path}: solid background`);
    assert.deepEqual(icon.corner, [10, 11, 12, 255]);
    assert.equal(icon.outside, 0, `${icon.path}: artwork survives maskable cropping`);
    assert.ok(icon.ink > icon.size ** 2 * 0.035, `${icon.path}: not blank`);
    assert.ok(icon.right - icon.left > icon.size * 0.45, `${icon.path}: readable glyphs`);
    assert.ok(icon.bottom - icon.top > icon.size * 0.45);
    assert.ok(Math.abs((icon.left + icon.right + 1) / 2 - icon.size / 2) <= 2, 'horizontally centered');
    assert.ok(Math.abs((icon.top + icon.bottom + 1) / 2 - icon.size / 2) <= 2, 'vertically centered');
  }
  for (const [name, color] of [['フロストホワイト', '#f6f8fa'], ['ディープネイビー', '#121620'], ['ミッドナイトブラック', '#0a0b0c']]) {
    await page.locator('.app-settings-btn').click();
    assert.deepEqual(await page.getByRole('radio').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
      ['ミッドナイトブラック', 'ディープネイビー', 'フロストホワイト']);
    await page.getByRole('radio', { name, exact: true }).click();
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), color);
    if (name === 'ディープネイビー') {
      for (const width of [390, 320, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.locator('.theme-option-name').evaluateAll(names => names.every(el => el.scrollWidth <= el.clientWidth + 1)), 'theme names fit');
        await page.screenshot({ path: `/private/tmp/bizencore-theme-settings-${width}.png` });
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByRole('dialog', { name: '設定', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
  }
  await page.reload();
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#0a0b0c');
  for (const width of [390, 320, 844, 1280]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
    await page.locator('.row--task').last().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => scrollY > 0), 'task list still scrolls');
    assert.equal(await page.locator('.app-header').evaluate(el => Math.round(el.getBoundingClientRect().top)), 0, 'header remains sticky');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `/private/tmp/bizencore-home-screen-${width}.png` });
  }
  await page.setContent('<style>body{margin:0;background:#0a0b0c;display:flex;align-items:center;justify-content:center;gap:28px;height:100vh}img{border-radius:22%;width:120px;height:120px}.circle{border-radius:50%}</style><img src="http://home-screen.test/icons/icon-512.png" alt="Rounded icon"><img class="circle" src="http://home-screen.test/icons/icon-512.png" alt="Circular icon">');
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: '/private/tmp/bizencore-app-icon-preview.png' });
  assert.deepEqual(errors, []);
  console.log('Passed: actual index metadata and manifest, opaque readable PNGs, maskable safe area, theme-color switching, persistence and scrolling at 390/320/844/1280px. Native home-screen installation remains a device check.');
} finally { await browser.close(); }
