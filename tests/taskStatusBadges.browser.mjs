import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { TaskRow } from './src/components/task/TaskRow';
    const noop = () => {};
    function Fixture() {
      const [selected, setSelected] = useState(true);
      const [active, setActive] = useState(false);
      const [board, setBoard] = useState(false);
      const common = { todayDate: '2026-10-22', todayTime: '12:00', isActive: active,
        noteOpen: false, deadlineOpen: false, colorOpen: false, isFocusedLabel: false,
        registerTitle: noop, registerNote: noop, onKeyDown: noop, onNoteKeyDown: noop,
        onFocusRow: () => setActive(true), onTextChange: noop, onNoteChange: noop,
        onToggleDone: noop, onToggleToday: () => setSelected(false), onCycleKind: noop,
        onSetDeadline: noop, onDeadlineOpenChange: noop, onColorOpenChange: noop, onRemove: noop,
        onTitleBlur: noop, onSetLabelColor: noop, onToggleLabelFocus: noop,
        onInspect: () => { window.inspected = true; } };
      const seed = { parentId: null, type: 'task', order: 0, done: false, createdAt: 1, updatedAt: 1, text: '肝心のタスク名とコンテンツを読みやすく表示する' };
      return <main style={{ padding: 12 }}><button id="reset" onClick={() => setSelected(true)}>Reset</button><button id="view" onClick={() => setBoard(!board)}>View</button>
        <div className={board ? 'board' : ''}><section className={board ? 'board-col' : ''}><ul className="row-list">
          <TaskRow {...common} depth={0} item={{ ...seed, id: 'plain' }} />
          <TaskRow {...common} depth={0} item={{ ...seed, id: 'selected', kind: selected ? 'main' : undefined, assignedDate: selected ? '2026-10-22' : '2026-10-21' }} />
        </ul></section></div></main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch();
try {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ hasTouch: touch });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: outputFiles[0].text });
    const plain = page.locator('[data-row-id="plain"]');
    const selected = page.locator('[data-row-id="selected"]');
    for (const theme of ['black', 'white', 'original']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 850 });
        await plain.locator('.row-title').focus();
        if (!touch) await plain.hover();
        for (const badge of ['.meta-kind', '.meta-today']) assert.equal(await plain.locator(badge).isVisible(), false, 'inactive badges never occupy space, including focused/hovered rows');
        assert.equal(await selected.locator('.meta-kind').isVisible(), true);
        assert.equal(await selected.locator('.meta-today').isVisible(), true);
        assert.ok((await plain.locator('.row-title').boundingBox()).width > (await selected.locator('.row-title').boundingBox()).width + 40, 'unset statuses release their width to the title');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (width === 390 && touch) await page.screenshot({ path: '/private/tmp/bizencore-status-badges-' + theme + '.png' });
      }
    }
    await selected.locator('.meta-today').click();
    assert.equal(await selected.locator('.meta-today').isVisible(), false, 'removing Today releases the badge width immediately');
    await plain.locator('.meta-inspect').click(); assert.equal(await page.evaluate(() => window.inspected), true, 'details remain available for changing unset properties');
    await page.locator('#reset').click(); await page.locator('#view').click();
    assert.equal(await selected.locator('.meta-kind').isVisible(), true, 'mobile board shows selected status');
    assert.equal(await plain.locator('.meta-today').isVisible(), false);
    await page.close();
  }
  console.log('Passed: inactive badges occupy no space, selected badges remain visible, title width improves, details remain available; mouse/touch, three themes, 1280/390/320px.');
} finally { await browser.close(); }
