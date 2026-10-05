import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const compiled = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { LabelColorPicker } from './src/components/task/LabelColorPicker';
    import { LABEL_COLORS, LABEL_COLOR_NAMES } from './src/lib/taskModel';
    const colors = Object.keys(LABEL_COLORS);
    function Fixture() {
      const [color, setColor] = useState('blue');
      const [open, setOpen] = useState(false);
      const [bottom, setBottom] = useState(false);
      return <>
        <main style={{ padding: 24 }}>
          <button id="edge" onClick={() => setBottom(!bottom)}>Edge</button>
          <input aria-label="Other input" />
          <section className="board-col" style={{ '--board-color': LABEL_COLORS[color] }}>
            <h2 className="row-title--section" style={{ '--label-color': LABEL_COLORS[color] }}>選んだラベル</h2>
          </section>
          <ul>{colors.map(key => <li key={key}>
            <span className="row-title--section" style={{ '--label-color': LABEL_COLORS[key] }}>{LABEL_COLOR_NAMES[key]}</span>
          </li>)}</ul>
          <output id="selected">{color || 'none'}</output>
        </main>
        <div style={{ position: 'fixed', right: 16, ...(bottom ? { bottom: 16 } : { top: 16 }) }}>
          <LabelColorPicker color={color} isOpen={open} onOpenChange={setOpen} onSelect={setColor} />
        </div>
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
function luminance(rgb) {
  const channels = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const trigger = page.getByRole('button', { name: 'ラベルの色を選ぶ' });
  const palette = page.getByRole('group', { name: 'ラベルの色', exact: true });
  const names = ['青', '紫', 'ピンク', '黄', '緑', '水色', 'ティール', '赤', 'オレンジ', 'ローズ', 'インディゴ', 'グレー'];
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 720 });
      for (const name of names) {
        await trigger.click();
        assert.equal(await palette.locator('button').count(), 13);
        const option = palette.getByRole('button', { name, exact: true });
        assert.equal(await option.getAttribute('title'), name);
        const bounds = await palette.boundingBox();
        assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= width - 7);
        assert.ok(bounds.y >= 8 && bounds.y + bounds.height <= 713);
        await option.click();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        assert.ok(await trigger.evaluate(el => el === document.activeElement));
        await trigger.click();
        assert.equal(await palette.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
      }
      await trigger.click();
      await palette.getByRole('button', { name: '青', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '緑');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '水色');
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '紫');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#selected').innerText(), 'violet');
      await trigger.click();
      await palette.getByRole('button', { name: '色なし', exact: true }).click();
      assert.equal(await page.locator('#selected').innerText(), 'none');
      await trigger.click();
      assert.ok(await palette.getByRole('button', { name: '色なし', exact: true }).evaluate(el => el === document.activeElement));
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'オレンジ');
      await page.keyboard.press('ArrowDown');
      assert.ok(await palette.getByRole('button', { name: '色なし', exact: true }).evaluate(el => el === document.activeElement));
      await page.keyboard.press('Escape');
      await page.locator('#edge').click();
      await trigger.click();
      const bounds = await palette.boundingBox();
      assert.ok(bounds.y + bounds.height < (await trigger.boundingBox()).y);
      await page.getByRole('textbox', { name: 'Other input' }).click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.ok(await page.getByRole('textbox', { name: 'Other input' }).evaluate(el => el === document.activeElement));
      await page.locator('#edge').click();
      await trigger.click();
      await page.screenshot({ path: '/private/tmp/bizencore-label-colors-' + theme + '-' + width + '.png' });
      await page.keyboard.press('Escape');
    }
    const contrasts = await page.locator('li .row-title--section').evaluateAll(elements => elements.map(el => {
      const color = getComputedStyle(el).color;
      const rgb = color.startsWith('color(srgb') ? color.match(/[\d.]+/g).slice(0, 3).map(Number) : color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255);
      const bg = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255);
      return { name: el.textContent, rgb, bg };
    }));
    for (const { name, rgb, bg } of contrasts) {
      const [a, b] = [luminance(rgb), luminance(bg)].sort((a, b) => b - a);
      assert.ok((a + 0.05) / (b + 0.05) >= 4.5, theme + ': ' + name + ' contrast');
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: 12 colors, selection/reset, focus restoration, grid arrow keys, outside click, viewport edges and contrast across 3 themes at 1280/390/320px.');
} finally { await browser.close(); }
