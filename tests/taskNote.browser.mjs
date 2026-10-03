import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Run with Playwright installed, or point PLAYWRIGHT_MODULE_PATH at a shared runtime.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const longNote = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: メモの全文は保持し、一覧だけを短く表示します。`).join('\n');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskRow } from './src/components/task/TaskRow';
    const noop = () => {};
    function Fixture() {
      const [note, setNote] = useState(${JSON.stringify(longNote)});
      const [board, setBoard] = useState(false);
      const common = {
        depth: 0, todayDate: '2026-10-03', todayTime: '12:00', isActive: false,
        noteOpen: true, deadlineOpen: false, colorOpen: false, isFocusedLabel: false,
        registerTitle: noop, registerNote: noop, onKeyDown: noop, onNoteKeyDown: noop,
        onFocusRow: noop, onTextChange: noop, onNoteChange: (_, value) => setNote(value),
        onToggleDone: noop, onToggleToday: noop, onCycleKind: noop, onSetDeadline: noop,
        onDeadlineOpenChange: noop, onColorOpenChange: noop, onRemove: noop,
        onTitleBlur: noop, onSetLabelColor: noop, onToggleLabelFocus: noop, onInspect: noop,
      };
      const seed = { parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1 };
      const rows = <ul className="row-list">
        <TaskRow {...common} item={{ ...seed, id: 'label', type: 'section', text: 'Label', note: ${JSON.stringify(longNote)} }} />
        <TaskRow {...common} item={{ ...seed, id: 'task', type: 'task', text: 'Task note', note }} />
        <li className="row row--task" data-row-id="picker"><p className="row-note">{note}</p></li>
      </ul>;
      return <main style={{ maxWidth: 840, margin: '16px auto', padding: 16 }}>
        <button id="view" onClick={() => setBoard(!board)}>View</button>
        {board ? <div className="board"><section className="board-col">{rows}</section></div> : rows}
        <textarea className="inspector-note" aria-label="Detail note" rows={10} value={note} readOnly />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: outputFiles[0].text });
  const note = page.locator('[data-row-id="task"] .row-note');
  const metrics = (locator) => locator.evaluate((el) => ({
    height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight),
    max: getComputedStyle(el).maxHeight, scroll: el.scrollTop, value: el.value, clamp: getComputedStyle(el).webkitLineClamp,
  }));
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const board of [false, true]) {
        if (board) await page.locator('#view').click();
        const compact = await metrics(note);
        assert.ok(compact.height <= compact.line * 3 + 4, JSON.stringify({ theme, width, board, compact }));
        assert.equal(compact.value, longNote);
        assert.equal((await metrics(page.locator('[data-row-id="picker"] .row-note'))).clamp, '3');
        assert.equal((await metrics(page.locator('[data-row-id="label"] .row-note'))).max, 'none');
        assert.equal((await metrics(page.getByLabel('Detail note'))).max, 'none');
        await note.focus();
        const expanded = await metrics(note);
        assert.ok(expanded.height > expanded.line * 3 + 4);
        assert.equal(expanded.max, 'none');
        const edited = `${longNote}\nEdited last line`;
        await note.fill(edited);
        await page.getByLabel('Detail note').focus();
        const collapsed = await metrics(note);
        assert.ok(collapsed.height <= collapsed.line * 3 + 4);
        assert.equal(collapsed.scroll, 0);
        assert.equal(collapsed.value, edited);
        assert.equal(await page.getByLabel('Detail note').inputValue(), edited);
        await note.focus();
        await note.fill(longNote);
        await page.getByLabel('Detail note').focus();
        if (board) await page.locator('#view').click();
      }
    }
  }
  await page.screenshot({ path: '/private/tmp/bizencore-task-note-mobile.png', fullPage: true });
  console.log('Passed: 3 themes, desktop/mobile and list/board; 3-line preview, full editing, blur reset, full detail, unchanged label notes.');
} finally {
  await browser.close();
}
