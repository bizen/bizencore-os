import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { Picker } from './mcp-app/Picker';
    const base = { createdAt: 1, updatedAt: 1, parentId: 'label', type: 'task', done: true };
    const items = [
      { ...base, id: 'label', type: 'section', parentId: null, order: 0, text: 'Build', done: false },
      { ...base, id: 'ai', order: 0, text: 'Agent finished', completedBy: 'ai' },
      { ...base, id: 'human', order: 1, text: 'Human finished', completedBy: 'user' },
      { ...base, id: 'pending', order: 2, text: 'Pending', done: false },
    ];
    taskStore.mergeRemote(items.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) })));
    const client = {
      connect: async () => {}, page: async () => ({ items, today_date: '2026-10-09' }),
      detail: async id => items.find(item => item.id === id), send: async () => {}, open: async () => {},
    };
    createRoot(document.getElementById('root')).render(location.pathname === '/picker/' ? <Picker client={client} /> : <TasksPage />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8') + await readFile('mcp-app/style.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  for (const surface of ['terminal', 'picker']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `https://completion-color.test/${surface}/`;
    await page.route('**/*', route => route.request().url() === url
      ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` }) : route.abort());
    await page.goto(url);
    const row = id => page.locator(surface === 'terminal' ? `[data-row-id="${id}"]` : `#item-${id}`);
    await row('ai').locator('.check').waitFor();
    for (const theme of ['black', 'white', 'original']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const colors = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const toRgb = token => {
            const el = document.createElement('span');
            el.style.color = root.getPropertyValue(token); document.body.append(el);
            const color = getComputedStyle(el).color; el.remove(); return color;
          };
          return { done: toRgb('--done-color'), ai: toRgb('--ai-done-color'), ink: toRgb('--check-ink'), border: toRgb('--border-color') };
        });
        await page.waitForFunction(({ surface, colors }) => {
          const check = id => document.querySelector(surface === 'terminal' ? `[data-row-id="${id}"] .check` : `#item-${id} .check`);
          return getComputedStyle(check('ai')).borderTopColor === colors.ai
            && getComputedStyle(check('human')).borderTopColor === colors.done
            && getComputedStyle(check('pending')).borderTopColor === colors.border;
        }, { surface, colors });
        const readCheck = id => row(id).locator('.check').evaluate(el => ({
          border: getComputedStyle(el).borderTopColor,
          fill: getComputedStyle(el.querySelector('.check-fill')).backgroundColor,
          ring: getComputedStyle(el, '::after').borderTopColor,
          tick: el.querySelector('.check-mark path') ? getComputedStyle(el.querySelector('.check-mark path')).stroke : getComputedStyle(el.querySelector('.picker-check')).color,
        }));
        const ai = await readCheck('ai'), human = await readCheck('human');
        assert.equal(ai.border, colors.ai, `${surface}/${theme}/${width}: agent outer border stays orange`);
        assert.equal(ai.ring, colors.ai, 'agent completion ring stays orange');
        assert.equal(ai.fill, colors.done, 'agent center uses ordinary completion color');
        assert.equal(ai.fill, human.fill, 'agent and human centers match');
        assert.equal(ai.tick, colors.ink, 'tick retains normal theme contrast');
        assert.equal(human.border, colors.done, 'human border is unchanged');
        assert.equal(await row('pending').locator('.check').evaluate(el => getComputedStyle(el).borderTopColor), colors.border);
        await page.screenshot({ path: `/private/tmp/bizencore-completion-${surface}-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
    }
    if (surface === 'terminal') {
      await row('ai').locator('.check').click();
      assert.equal(await row('ai').locator('.is-ai-checked').count(), 0, 'reopening removes AI styling');
      await row('ai').locator('.check').click();
      assert.equal(await row('ai').locator('.is-ai-checked').count(), 0, 'manual recompletion remains human');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Passed: two-tone agent check in terminal and MCP Apps, 3 themes, desktop/mobile, ordinary and pending checks, reopen and human recompletion; no real network or accounts.');
} finally { await browser.close(); }
