import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore, flushPersist } from './src/lib/taskStore';
    import { localDateString } from './src/lib/taskDates';
    import { Picker } from './mcp-app/Picker';
    const today = localDateString(new Date());
    if (!Object.keys(taskStore.getState().items).length) {
      const label = taskStore.addSection();
      taskStore.setText(label, 'OSビルド');
      const add = (parent, title, note) => {
        const id = taskStore.insertAfter(parent, { asChild: true });
        taskStore.setText(id, title);
        if (note) taskStore.setNote(id, note);
        return id;
      };
      const root = add(label, 'bizencore', '目的を整理するメモ。\\n'.repeat(8));
      const branch = add(root, 'UIの見直し', '常設の見出し');
      taskStore.setLocked(branch, true);
      const nested = add(branch, 'タスク表示');
      const deeper = add(nested, '階層ガイド');
      add(deeper, '接続を確認する');
      add(deeper, '長いタイトルでも省略せず表示する。深い階層でも親子の関係を見失わないように確認する。', '長いメモも三行プレビューのまま。\\n'.repeat(8));
      add(branch, '表示幅を確認する');
      add(root, '検索を調整する');
      add(label, '公開を確認する');
      const filed = add(root, '以前の調整');
      add(filed, '以前の確認');
      taskStore.toggleDone(filed);
      taskStore.fileCompleted();
      taskStore.toggleToday(root, today);
      const standalone = taskStore.insertAfter(null);
      taskStore.setText(standalone, 'ラベルなし');
      add(standalone, '単独リストの子');
      flushPersist();
    }
    const items = taskStore.getState().items;
    globalThis.fixtureIds = Object.fromEntries(Object.values(items).map(item => [item.text, item.id]));
    const client = {
      connect: async () => {}, page: async () => ({ items: Object.values(items), today_date: today }),
      detail: async id => items[id], send: async () => {}, open: async () => {},
    };
    createRoot(document.getElementById('root')).render(location.pathname === '/app' ? <Picker client={client} /> : <TasksPage />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const pickerCss = await readFile('mcp-app/style.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('https://bizencore.test/')
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}\n${pickerCss}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` })
    : route.abort());
  const validate = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('textarea.row-title')].every(el => el.scrollHeight <= el.clientHeight + 1));
    const problems = await page.locator('ul.row-list').evaluateAll(lists => {
      const problems = [];
      for (const list of lists) {
        const rows = [...list.children].filter(el => el.matches('.row'));
        rows.forEach((row, index) => {
          const depth = Number(row.style.getPropertyValue('--depth'));
          const nextDepth = Number(rows[index + 1]?.style.getPropertyValue('--depth') || 0);
          const childStem = nextDepth > depth && !row.matches('.row--section');
          const main = row.querySelector('.row-main');
          const rect = main.getBoundingClientRect();
          const mark = row.querySelector('.row-mark').getBoundingClientRect();
          const guides = [...row.querySelectorAll('.row-tree-guide:not(.row-tree-stem)')];
          const stem = row.querySelector('.row-tree-stem');
          if (guides.length !== depth) problems.push('missing ancestor rails at depth ' + depth);
          if (!!stem !== childStem) problems.push('incorrect visible-child stem');
          const step = parseFloat(getComputedStyle(row).getPropertyValue('--tree-step')) * parseFloat(getComputedStyle(row).fontSize);
          for (const guide of [...guides, ...(stem ? [stem] : [])]) {
            const level = Number(guide.style.getPropertyValue('--tree-level'));
            const box = guide.getBoundingClientRect();
            const expected = mark.x + mark.width / 2 - (depth - level) * step;
            if (Math.abs(box.x + box.width / 2 - expected) > 1) problems.push('rail not centered on ancestor checkbox');
            if (box.width !== 1 || box.height <= 0) problems.push('rail is blank or incorrectly sized');
            if (getComputedStyle(guide).pointerEvents !== 'none') problems.push('rail intercepts clicks');
            if (guide === stem) {
              const check = row.querySelector('.check, .row-lock-mark').getBoundingClientRect();
              if (box.y < check.bottom - 1) problems.push('stem overlaps checkbox');
            } else if (Math.abs(box.y - rect.y) > 1 || Math.abs(box.bottom - rect.bottom) > 1) problems.push('rail does not span full row');
          }
          const title = row.querySelector('.row-title');
          if (title.scrollWidth > title.clientWidth + 1 || title.scrollHeight > title.clientHeight + 1) problems.push('title clipped');
        });
      }
      return problems;
    });
    assert.deepEqual(problems, []);
  };
  for (const host of ['web', 'app']) {
    for (const theme of ['black', 'white', 'original']) {
      await page.goto('https://bizencore.test/' + host);
      await page.waitForFunction(() => !!globalThis.fixtureIds && document.querySelectorAll('.row').length > 0);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const ids = await page.evaluate(() => globalThis.fixtureIds);
      const row = title => page.locator(host === 'web' ? '[data-row-id="' + ids[title] + '"]' : '#item-' + ids[title]);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const view of ['all', 'board', 'today']) {
          await page.getByRole('tab', { name: new RegExp('^' + view) }).click();
          await validate();
          assert.equal(await row('公開を確認する').count(), view === 'today' ? 0 : 1);
          if (theme === 'black' && (width === 390 || width === 1280) && view === 'all') {
            await row('UIの見直し').scrollIntoViewIfNeeded();
            await page.screenshot({ path: '/private/tmp/bizencore-tree-' + host + (width === 390 ? '-mobile' : '-desktop') + '.png', fullPage: true, animations: 'disabled' });
          }
        }
        await page.getByRole('tab', { name: 'all', exact: true }).click();
        if (host === 'web') {
          const focus = row('OSビルド').getByRole('button', { name: 'フォーカスに追加' });
          if (await focus.count()) await focus.click();
        } else {
          const focus = page.getByRole('button', { name: 'OSビルドをフォーカスに追加', exact: true });
          if (await focus.count()) await focus.click();
        }
        await page.getByRole('tab', { name: 'OSビルド', exact: true }).click();
        await validate();
        assert.equal(await row('ラベルなし').count(), 0);
        if (host === 'web') {
          const note = row('bizencore').getByRole('textbox', { name: 'メモ', exact: true });
          await note.focus();
          await validate();
          await page.getByRole('tab', { name: 'all', exact: true }).click();
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: Web and MCP Apps ancestor rails and parent stems; All/Board/Today/Focus, 3 themes at 1280/390/320, locked containers, full long titles, expanded notes, filed subtree and standalone tasks.');
} finally {
  await browser.close();
}
