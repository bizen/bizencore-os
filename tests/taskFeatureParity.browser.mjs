import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    const date = '2026-10-14'; Date.now = () => Date.parse(date + 'T12:00:00Z'); setUserTimeZone('UTC');
    const rows = Array.from({ length: 4 }, (_, group) => [
      { id: 'label-' + group, type: 'section', parentId: null, order: group, text: 'ラベル ' + (group + 1), color: 'blue' },
      ...Array.from({ length: 24 }, (_, i) => ({ id: 'task-' + group + '-' + i, type: 'task', parentId: 'label-' + group,
        order: i, text: '作業 ' + (group + 1) + ' / ' + (i + 1), assignedDate: i === 0 ? date : undefined })),
    ]).flat();
    taskStore.mergeRemote(rows.map(item => ({ itemId: item.id, updatedAt: 1,
      payload: JSON.stringify({ done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    const wish = lifeWorldStore.add(date); lifeWorldStore.setText(wish, '今日の買い物');
    const habit = lifeWorldStore.add(date); lifeWorldStore.setText(habit, '散歩'); lifeWorldStore.setRepeat(habit, 'daily');
    lifeWorldStore.setShowInAll(true);
    globalThis.parityFixture = { calls: [] };
    window.bizencoreDesktop = {
      integratedTitlebar: true, mcpSupported: false,
      agents: async () => [{ id: 'claude', name: 'Claude Code', path: '/fixture/claude' }, { id: 'codex', name: 'Codex', path: '/fixture/codex' }],
      folder: async () => '/fixture/project',
      start: async () => { throw Error('No real agents may start in this fixture'); },
      stop: async () => {}, onEvent: () => () => {},
    };
    (async () => {
      const { AgentWorkspace } = await import('./desktop/workspace');
      const { DesktopFrame } = await import('./desktop/Frame');
      const { DesktopWorkspaceAccount } = await import('./desktop/workspace-account');
      const desktop = location.search.includes('desktop');
      createRoot(document.getElementById('root')).render(<MemoryRouter>{desktop
        ? <DesktopFrame><DesktopWorkspaceAccount.Provider value="parity-test"><AgentWorkspace><App desktop /></AgentWorkspace></DesktopWorkspaceAccount.Provider></DesktopFrame>
        : <App />}</MemoryRouter>);
    })();
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const webCss = await readFile('src/index.css', 'utf8');
const desktopCss = await readFile('desktop/workspace.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  for (const desktop of [false, true]) {
    console.log('Checking shared task features: ' + (desktop ? 'desktop' : 'web'));
    const html = `<!doctype html><style>${webCss}${desktop ? desktopCss : ''}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://parity.test/' + (desktop ? '?desktop' : ''));
    await page.locator('.splash-root').waitFor({ state: 'detached' });
    const index = page.getByRole('navigation', { name: 'ラベルの目次', exact: true });
    const scroller = desktop ? page.locator('.desktop-tasks') : page.locator('html');
    const scrollTop = () => scroller.evaluate(element => element.scrollTop);
    const assertIndex = async (direction) => {
      assert.equal(await index.isVisible(), true);
      assert.equal(await index.locator('.label-index-list').evaluate(element => getComputedStyle(element).flexDirection), direction);
      if (desktop) assert.ok(await index.evaluate(element => {
        const rect = element.getBoundingClientRect(), column = element.closest('.desktop-tasks').getBoundingClientRect();
        return rect.left >= column.left && rect.right <= column.right + 1;
      }), 'index cannot overlay the agents or center detail column');
    };
    await assertIndex('column');
    assert.equal(await index.getByRole('button').count(), 5, 'Life World also appears in the shared index');
    await index.getByRole('button', { name: 'ラベル 3', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.querySelector('[aria-label="ラベルの目次"] button[aria-current]')?.textContent === 'ラベル 3');
    assert.ok(await scrollTop() > 400);
    if (desktop) assert.equal(await page.evaluate(() => scrollY), 0, 'nested scroll never moves the desktop window');
    assert.ok(await page.locator('#label-label-2').evaluate(element => element.getBoundingClientRect().top >= document.querySelector('.tasks-toolbar').getBoundingClientRect().bottom), 'clicked label stays below the toolbar');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[aria-label="ラベルの目次"] button[aria-current]')?.textContent === 'ラベル 1');
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('[aria-label="ラベルの目次"] button[aria-current]')?.textContent === '生活世界');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    if (desktop) {
      await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
      const divider = page.getByRole('separator', { name: 'エージェント選択画面の幅', exact: true });
      const rect = await divider.boundingBox();
      await page.mouse.move(rect.x + 3, rect.y + 120); await page.mouse.down();
      await page.mouse.move(560, rect.y + 120, { steps: 8 }); await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.label-index-list') && getComputedStyle(document.querySelector('.label-index-list')).flexDirection === 'row');
      await assertIndex('row');
      assert.ok(await page.locator('.row--task .row-title').first().evaluate(element => element.getBoundingClientRect().width > 220), 'narrow columns keep usable task width');
      await index.getByRole('button', { name: 'ラベル 3', exact: true }).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => document.querySelector('[aria-label="ラベルの目次"] button[aria-current]')?.textContent === 'ラベル 3');
      assert.ok(await page.locator('#label-label-2').evaluate(element => element.getBoundingClientRect().top >= document.querySelector('.label-index').getBoundingClientRect().bottom), 'horizontal sticky index never covers the target');
      await page.locator('[data-row-id="task-2-0"] .meta-inspect').click();
      const inspector = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
      await inspector.waitFor(); await assertIndex('row');
      assert.ok(await inspector.evaluate(element => element.parentElement.classList.contains('desktop-inspector')));
      await page.screenshot({ path: '/private/tmp/bizencore-parity-desktop-narrow-details.png' });
      await inspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
      await page.getByRole('button', { name: '起動設定を閉じる', exact: true }).click();
    }
    // Shared navigation, focus, search, details and completion controls must survive desktop embedding.
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.locator('#label-label-0').getByRole('button', { name: 'フォーカスに追加', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'all', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Alt+4');
    assert.equal(await page.getByRole('tab', { name: 'ラベル 1', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.row--task').count(), 24);
    await page.keyboard.press('Alt+2');
    assert.equal(await page.getByRole('tab', { name: 'board', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('list', { name: 'ラベルごとの列', exact: true }).count(), 1);
    await page.keyboard.press('Alt+3');
    assert.equal(await page.getByRole('tab', { name: /today/ }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Alt+1');
    await page.getByRole('button', { name: '検索', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'タスクを検索', exact: true });
    await search.fill('作業 2 / 1');
    await page.locator('.task-search-result').first().waitFor();
    await search.press('Enter');
    const found = page.locator('[data-row-id="task-1-0"] .row-title');
    await page.waitForFunction(() => document.activeElement?.closest('[data-row-id]')?.getAttribute('data-row-id') === 'task-1-0');
    await found.press('Control+i');
    const inspector = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
    await inspector.waitFor();
    assert.equal(await inspector.getByRole('textbox', { name: 'タスク', exact: true }).inputValue(), '作業 2 / 1');
    await inspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '完了を削除（⌥⇧C）', exact: true }).isDisabled(), true);
    await page.locator('.life-world').getByRole('button', { name: '今日の買い物を完了にする', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '完了を削除（⌥⇧C）', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '完了を整理（⌥C）', exact: true }).click();
    assert.equal(await page.locator('.done-shelf .life-row').count(), 1);
    await page.getByRole('button', { name: '完了を削除（⌥⇧C）', exact: true }).click();
    assert.equal(await page.locator('.done-shelf .life-row').count(), 0);
    for (const [theme, width] of [['black', 1440], ['white', 900], ['original', 860]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await assertIndex(desktop ? 'column' : width <= 860 ? 'row' : 'column');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.row--task .row-title')).color === getComputedStyle(document.body).color);
      await page.screenshot({ path: '/private/tmp/bizencore-parity-' + (desktop ? 'desktop' : 'web') + '-' + theme + '-' + width + '.png' });
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('Passed: shared Web/desktop label navigation, scroll tracking, nested scrolling, column-width adaptation, non-overlay details, focus shortcuts, All/Board/Today, search and Life World filing/deletion. Mock IPC only, no real accounts or agents.');
} finally { await browser.close(); }
