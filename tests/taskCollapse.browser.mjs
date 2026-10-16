import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    import { applyTheme } from './src/lib/theme';
    const date = '2026-10-14'; Date.now = () => Date.parse(date + 'T12:00:00Z');
    applyTheme('black'); setUserTimeZone('UTC');
    const items = [
      { id: 'label', text: 'ビルド', type: 'section', parentId: null, order: 0 },
      { id: 'parent', text: 'プロジェクト', parentId: 'label', order: 0, locked: true, assignedDate: date },
      { id: 'nested', text: 'サブフォルダ', parentId: 'parent', order: 0, locked: true },
      { id: 'grandchild', text: '通常の孫', parentId: 'nested', order: 0 },
      { id: 'child', text: '直接タスク', parentId: 'parent', order: 1 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: 'extra-' + i, text: '作業 ' + i, parentId: 'parent', order: i + 2 })),
      { id: 'next', text: '次のタスク', parentId: 'label', order: 1, assignedDate: date },
      { id: 'locked-leaf', text: '子なしの見出し', parentId: 'label', order: 2, locked: true },
    ];
    taskStore.mergeRemote(items.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify({ type: 'task', done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    const root = lifeWorldStore.add(date); lifeWorldStore.setText(root, '買い物'); lifeWorldStore.setLocked(root, true, date);
    const nested = lifeWorldStore.add(date, root, true, true); lifeWorldStore.setText(nested, '食料品'); lifeWorldStore.setLocked(nested, true, date);
    const grandchild = lifeWorldStore.add(date, nested, true, true); lifeWorldStore.setText(grandchild, '生活の孫');
    const bread = lifeWorldStore.add(date, nested, true); lifeWorldStore.setText(bread, 'パン');
    for (let i = 0; i < 9; i++) { const id = lifeWorldStore.add(date, root, true, true); lifeWorldStore.setText(id, '買う物 ' + i); }
    lifeWorldStore.setShowInAll(true);
    globalThis.fixtureLifeIds = { root, nested, grandchild, bread };
    globalThis.fixtureData = () => ({ tasks: taskStore.getState().items, life: lifeWorldStore.getSnapshot().data });
    createRoot(document.getElementById('root')).render(<div className="app-shell"><main className="app-main"><TasksPage /></main></div>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://task-collapse.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
  await page.goto('https://task-collapse.test/');
  const life = await page.evaluate(() => globalThis.fixtureLifeIds);
  const row = id => page.locator(`[data-row-id="${id}"]`);
  const lifeRow = id => page.locator(`[data-life-id="${id}"]`);
  const parent = row('parent'), nested = row('nested'), grandchild = row('grandchild');
  const before = await page.evaluate(() => globalThis.fixtureData());
  const remaining = await page.locator('.tasks-count').textContent();
  const lockPath = await parent.locator('.row-lock-mark svg').innerHTML();
  await nested.getByRole('button', { name: 'サブフォルダのサブタスクを収納', exact: true }).click();
  await grandchild.waitFor({ state: 'hidden' });
  assert.equal(await nested.locator('.row-lock-count').textContent(), '1');
  await parent.getByRole('button', { name: 'プロジェクトのサブタスクを収納', exact: true }).click();
  await nested.waitFor({ state: 'hidden' });
  assert.equal(await parent.locator('.row-lock-count').textContent(), '12', 'count includes nested containers and their descendants');
  assert.equal(await parent.locator('.row-lock-mark svg').innerHTML(), lockPath, 'the lock icon is unchanged');
  assert.equal(await parent.locator('.row-lock-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.tasks-count').textContent(), remaining, 'hidden work is still counted');
  assert.deepEqual(await page.evaluate(() => globalThis.fixtureData()), before, 'folding never changes tasks, locks, checks or ordering');
  await parent.locator('.row-title').press('ArrowDown');
  assert.equal(await row('next').locator('.row-title').evaluate(el => el === document.activeElement), true, 'arrow navigation skips folded descendants');
  await parent.locator('.row-lock-toggle').press('Space');
  await nested.waitFor(); assert.equal(await grandchild.count(), 0, 'inner collapse is retained after expanding the parent');
  await nested.locator('.row-lock-toggle').press('Enter'); await grandchild.waitFor();
  await parent.locator('.row-lock-toggle').press('Enter');
  assert.equal(await row('locked-leaf').getByRole('img', { name: 'ロック中・完了不可', exact: true }).count(), 1);
  assert.equal(await row('locked-leaf').locator('.row-lock-toggle').count(), 0, 'a leaf lock has no fake collapse control');
  await page.getByRole('tab', { name: 'board', exact: true }).click();
  const foldedBoardCount = await page.locator('.board-col-count').textContent();
  await parent.locator('.row-lock-toggle').click();
  assert.equal(await page.locator('.board-col-count').textContent(), foldedBoardCount, 'board counts do not shrink on collapse');
  await parent.locator('.row-lock-toggle').click();
  await page.getByRole('tab', { name: /today/ }).click();
  assert.equal(await parent.locator('.row-lock-count').textContent(), '12', 'Today retains the same folding state');
  assert.equal(await grandchild.count(), 0);
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  await row('label').getByRole('button', { name: 'フォーカスに追加', exact: true }).click();
  await page.getByRole('tab', { name: 'ビルド', exact: true }).click();
  assert.equal(await parent.locator('.row-lock-count').textContent(), '12', 'focus view shares the collapse state');
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'タスクを検索', exact: true });
  await search.fill('通常の孫');
  await grandchild.waitFor();
  await search.press('Enter');
  assert.equal(await grandchild.locator('.row-title').evaluate(el => el === document.activeElement), true, 'choosing a search hit expands its locked ancestors');
  await parent.locator('.row-lock-toggle').click();
  await lifeRow(life.nested).locator('.row-lock-toggle').click();
  await lifeRow(life.root).locator('.row-lock-toggle').click();
  assert.equal(await lifeRow(life.root).locator('.row-lock-count').textContent(), '12');
  assert.equal(await lifeRow(life.grandchild).count(), 0);
  await lifeRow(life.root).locator('.row-title').press('ArrowDown');
  assert.equal(await lifeRow(life.root).locator('.row-title').evaluate(el => el === document.activeElement), true, 'last visible life row stays selected');
  await page.getByRole('button', { name: '検索', exact: true }).click(); await search.fill('生活の孫'); await search.press('Enter');
  const lifePanel = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  await lifePanel.waitFor();
  assert.equal(await lifePanel.getByRole('textbox', { name: '生活タスクのタイトル' }).inputValue(), '生活の孫');
  await lifePanel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await lifeRow(life.grandchild).waitFor();
  await lifeRow(life.root).locator('.row-lock-toggle').click();
  await parent.getByRole('button', { name: '詳細を開く', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
  await panel.getByRole('switch', { name: 'タスクロック', exact: true }).click();
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await grandchild.waitFor(); assert.equal(await parent.locator('.row-lock-toggle').count(), 0, 'unlocking exposes its descendants');
  await parent.getByRole('button', { name: '詳細を開く', exact: true }).click();
  await panel.getByRole('switch', { name: 'タスクロック', exact: true }).click();
  await panel.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await parent.locator('.row-lock-count').waitFor();
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width}: no horizontal overflow`);
      for (const container of [parent, lifeRow(life.root)]) {
        const lock = await container.locator('.row-lock-mark').evaluate(el => {
          const box = el.getBoundingClientRect(), icon = el.querySelector('svg').getBoundingClientRect(), style = getComputedStyle(el);
          return { width: box.width, height: box.height, border: parseFloat(style.borderTopWidth), radius: style.borderRadius,
            centered: Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2) < 1 && Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2) < 1 };
        });
        assert.equal(lock.width, 20); assert.equal(lock.height, 20);
        assert.ok(lock.border >= 1); assert.equal(lock.radius, '7px');
        assert.equal(lock.centered, true, `${theme}/${width}: lock is centered inside the checkbox frame`);
        const bounds = await container.evaluate(el => {
          const badge = el.querySelector('.row-lock-count').getBoundingClientRect(), title = el.querySelector('.row-title').getBoundingClientRect();
          return { badgeRight: badge.right, titleLeft: title.left };
        });
        assert.ok(bounds.badgeRight <= bounds.titleLeft + 1, `${theme}/${width}: two-digit badge never overlaps the title`);
        assert.equal(await container.getByRole('img', { name: 'ロック中・完了不可', exact: true }).count(), 1);
      }
      await page.screenshot({ path: `/private/tmp/bizencore-task-collapse-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed: locked task and life subtrees, nested/12-item badges, unchanged locks/data, leaf marks, Enter/Space, arrow navigation, All/Board/Today/focus, board counts, search-to-child expansion, unlock restoration and 3 themes/desktop/mobile. No accounts or external network.');
} finally { await browser.close(); }
