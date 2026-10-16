import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { InspectorDialog } from './src/components/task/InspectorDialog';
    import { DesktopInspectorContext } from './src/lib/desktopInspector';
    const ignore = () => {};
    function Fixture() {
      const [host, setHost] = useState(null);
      const desktop = location.pathname === '/desktop';
      const content = <InspectorDialog label="スクロール確認" onClose={ignore}>
        {Array.from({ length: 40 }, (_, i) => <p key={i}>資料の確認項目 {i + 1}</p>)}
        <button type="button">末尾の操作</button>
      </InspectorDialog>;
      return desktop ? <DesktopInspectorContext.Provider value={{ host, open: true, setOpen: ignore }}>
        <div className="desktop-shell"><div ref={setHost} className="desktop-inspector" style={{ height: '100%', width: 340 }} />{content}</div>
      </DesktopInspectorContext.Provider> : content;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
});
const css = (await readFile('src/index.css', 'utf8')) + (await readFile('desktop/workspace.css', 'utf8'));
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  for (const mode of ['web', 'desktop']) {
    for (const width of mode === 'web' ? [390, 1280] : [900, 1380]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`http://127.0.0.1/${mode}`);
      const inspector = page.getByRole('dialog', { name: 'スクロール確認', exact: true });
      const scroller = mode === 'desktop' ? inspector.locator('.desktop-inspector-content') : inspector;
      for (const theme of ['black', 'white', 'original']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await scroller.waitFor();
        assert.equal(await scroller.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
        assert.equal(await scroller.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').display), 'none');
        assert.ok(await scroller.evaluate(element => getComputedStyle(element).overflowY === 'auto' && element.scrollHeight > element.clientHeight));
        await inspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).focus();
        await scroller.evaluate(element => { element.scrollTop = 0; });
        const bounds = await scroller.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0, mode === 'desktop' ? '.desktop-inspector-content' : '.inspector');
        await inspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.ok(await inspector.getByRole('button', { name: '末尾の操作', exact: true }).evaluate(element => {
          const rect = element.getBoundingClientRect();
          return document.activeElement === element && rect.top >= 0 && rect.bottom <= innerHeight;
        }), 'keyboard navigation reveals the last control with no scrollbar');
        await page.screenshot({ path: `/private/tmp/bizencore-inspector-scroll-${mode}-${width}-${theme}.png` });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: Web/mobile and docked desktop inspectors hide scrollbar chrome in three themes while wheel and keyboard scrolling reach the last control.');
} finally { await browser.close(); }
