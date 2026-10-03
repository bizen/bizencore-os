import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const longTitle = 'MCP Appsで会話の中にtodayリストを出す。クライアント別に選択から実行・完了までの導線を検証し、タスクの最新情報と添付を読み込む。長いタイトルも省略せず全文を表示する。';
const longWord = 'https://example.com/' + 'unbroken-title-'.repeat(12);
const note = 'メモはこれまでどおり三行だけ表示します。\n'.repeat(8).trim();
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskRow } from './src/components/task/TaskRow';
    const noop = () => {};
    function Fixture() {
      const [title, setTitle] = useState(${JSON.stringify(longTitle)});
      const [board, setBoard] = useState(false);
      const common = {
        todayDate: '2026-10-04', todayTime: '12:00', isActive: false,
        noteOpen: true, deadlineOpen: false, colorOpen: false, isFocusedLabel: false,
        registerTitle: noop, registerNote: noop, onKeyDown: noop, onNoteKeyDown: noop,
        onFocusRow: noop, onTextChange: (_, value) => setTitle(value), onNoteChange: noop,
        onToggleDone: noop, onToggleToday: noop, onCycleKind: noop, onSetDeadline: noop,
        onDeadlineOpenChange: noop, onColorOpenChange: noop, onRemove: noop,
        onTitleBlur: noop, onSetLabelColor: noop, onToggleLabelFocus: noop, onInspect: noop,
      };
      const seed = { parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1, type: 'task' };
      const rows = <ul className="row-list">
        <TaskRow {...common} depth={2} item={{ ...seed, id: 'task', text: title, note: ${JSON.stringify(note)} }} />
        <TaskRow {...common} depth={1} item={{ ...seed, id: 'url', text: ${JSON.stringify(longWord)} }} />
        <li className="row row--task" data-row-id="picker"><div className="row-main"><span /><div className="row-text"><button className="row-title picker-title">{title}</button></div><span /></div></li>
      </ul>;
      return <main id="frame" style={{ maxWidth: 840, margin: '16px auto', padding: 16 }}>
        <button id="view" onClick={() => setBoard(!board)}>View</button>
        {board ? <div className="board"><section className="board-col">{rows}</section></div> : rows}
      </main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile('src/index.css', 'utf8');
const pickerCss = await readFile('mcp-app/style.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.setContent(`<style>${css}\n${pickerCss}</style><div id="root"></div>`);
  await page.addScriptTag({ content: outputFiles[0].text });
  const title = page.locator('[data-row-id="task"] .row-title');
  const checkFull = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('textarea.row-title')].every(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
    assert.equal(await title.inputValue(), longTitle);
    const clippedNote = await page.locator('[data-row-id="task"] .row-note').evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    assert.ok(clippedNote.height <= clippedNote.line * 3 + 4);
    const picker = await page.locator('[data-row-id="picker"] .row-title').evaluate(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth, clamp: getComputedStyle(el).webkitLineClamp }));
    assert.ok(picker.scrollHeight <= picker.height + 1);
    assert.ok(picker.scrollWidth <= picker.width + 1);
    assert.equal(picker.clamp, 'none');
  };
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const board of [false, true]) {
      if (board) await page.locator('#view').click();
      // Resize without changing the title or causing a React re-render.
      for (const width of [1280, 390, 320, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        await checkFull();
      }
      await page.locator('#frame').evaluate(el => { el.style.maxWidth = '340px'; });
      await checkFull();
      await page.locator('#frame').evaluate(el => { el.style.maxWidth = '840px'; });
      await checkFull();
      if (board) await page.locator('#view').click();
    }
  }
  await title.evaluate(el => { el.style.fontSize = '23px'; document.fonts.dispatchEvent(new Event('loadingdone')); });
  await checkFull();
  await title.evaluate(el => { el.style.fontSize = ''; document.fonts.dispatchEvent(new Event('loadingdone')); });
  await title.fill(longTitle + '\n追記したタイトルも省略しない。');
  await page.locator('#view').focus();
  await page.waitForFunction(() => { const el = document.querySelector('[data-row-id="task"] .row-title'); return el.scrollHeight <= el.clientHeight + 1; });
  assert.equal(await title.inputValue(), longTitle + '\n追記したタイトルも省略しない。');
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea.row-title')].every(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: '/private/tmp/bizencore-task-title-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Passed: full long titles and long URLs across 3 themes, desktop/mobile, list/board, live resizing, container resizing, font loading and editing; notes remain capped.');
} finally {
  await browser.close();
}
