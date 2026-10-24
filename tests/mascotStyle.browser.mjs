import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    createRoot(document.getElementById('root')).render(<MemoryRouter><App desktop={location.search.includes('desktop')} /></MemoryRouter>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
const browser = await chromium.launch();
try {
  for (const desktop of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const url = `https://mascot-style.test/${desktop ? '?desktop' : ''}`;
    const open = async () => {
      await page.locator('.app-settings-btn').click();
      await page.getByRole('dialog', { name: '設定', exact: true }).waitFor();
      await page.getByRole('button', { name: '外観', exact: true }).click();
    };
    const close = () => page.getByRole('dialog', { name: '設定', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
    await page.goto(url);
    await page.locator('.splash-root').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.mascot-portrait').getAttribute('data-style'), 'matte');
    await open();
    const select = page.getByLabel('チルノのスタイル', { exact: true });
    assert.equal(await select.inputValue(), 'matte');
    assert.deepEqual(await select.locator('option').allTextContents(), ['マット（標準）', 'フラット']);
    await select.selectOption('flat');
    await page.locator('.mascot-portrait[data-style="flat"] .mascot-face').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => localStorage.getItem('bizencore.mascotStyle')), 'flat');
    await close();
    await page.reload();
    await page.locator('.splash-root').waitFor({ state: 'detached' });
    await page.locator('.mascot-portrait[data-style="flat"] .mascot-face').waitFor({ state: 'visible' });
    await open();
    assert.equal(await select.inputValue(), 'flat');
    await page.screenshot({ path: `/private/tmp/bizencore-mascot-style-${desktop ? 'desktop' : 'web'}-390.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await select.focus();
    assert.ok(await select.evaluate(element => document.activeElement === element), 'native selector can receive keyboard focus');
    await select.selectOption('matte');
    await close();
    await page.reload();
    await page.locator('.mascot-portrait[data-style="matte"] .mascot-face').waitFor({ state: 'visible' });
    await open();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; });
    await select.selectOption('flat');
    await page.locator('.mascot-portrait[data-style="flat"] .mascot-face').waitFor({ state: 'visible' });
    await close();
    await open();
    assert.equal(await select.inputValue(), 'flat', 'unavailable storage still keeps the current window in sync');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Passed: Web/desktop appearance setting, matte default, immediate flat/matte switch, image layer readiness, reload persistence, keyboard focus, 390px layout and blocked-storage fallback.');
} finally { await browser.close(); }
