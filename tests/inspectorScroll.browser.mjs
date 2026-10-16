import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { InspectorDialog } from './src/components/task/InspectorDialog';
    createRoot(document.getElementById('root')).render(
      <InspectorDialog label="Scroll check" onClose={() => {}}>
        {Array.from({ length: 40 }, (_, i) => <p key={i}>Context item {i + 1}</p>)}
        <button type="button">Last action</button>
      </InspectorDialog>
    );
  ` },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
});
const css = await readFile('src/index.css', 'utf8');
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('http://127.0.0.1/inspector');
    const inspector = page.getByRole('dialog', { name: 'Scroll check', exact: true });
    for (const theme of ['black', 'white', 'original']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await inspector.waitFor();
      assert.equal(await inspector.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
      assert.equal(await inspector.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').display), 'none');
      assert.ok(await inspector.evaluate(element => getComputedStyle(element).overflowY === 'auto' && element.scrollHeight > element.clientHeight));
      const close = inspector.locator('.inspector-head button');
      await close.focus();
      await inspector.evaluate(element => { element.scrollTop = 0; });
      const bounds = await inspector.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('.inspector').scrollTop > 0);
      await close.focus();
      await page.keyboard.press('Tab');
      assert.ok(await inspector.getByRole('button', { name: 'Last action', exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.activeElement === element && rect.top >= 0 && rect.bottom <= innerHeight;
      }), 'keyboard navigation reveals the last control without a scrollbar');
      await page.screenshot({ path: `/private/tmp/bizencore-web-inspector-scroll-${width}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: Web/mobile inspectors hide scrollbar chrome in three themes while wheel and keyboard scrolling reach the last control.');
} finally { await browser.close(); }
