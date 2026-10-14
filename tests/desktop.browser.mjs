import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const mcp = process.env.DESKTOP_MCP_TEST === '1';
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    import { taskStore } from './src/lib/taskStore';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    import { Terminal } from '@xterm/xterm';
    window.__desktopTest = { calls: [], channels: new Map(), folder: '/smoke/project' };
    const fixture = window.__desktopTest;
    fixture.terminals = [];
    const openTerminal = Terminal.prototype.open;
    Terminal.prototype.open = function(host) {
      if (host.closest('.agent-pane')) fixture.terminals.push(this);
      return openTerminal.call(this, host);
    };
    setUserTimeZone('UTC');
    const lifeId = lifeWorldStore.add(new Date().toISOString().slice(0, 10));
    lifeWorldStore.setText(lifeId, 'Desktop life task');
    fixture.progress = () => {
      const now = Date.now() + 10000;
      taskStore.mergeRemote([{
        itemId: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', updatedAt: now,
        payload: JSON.stringify({ id: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', type: 'task', parentId: 'desktop-label', order: 0, text: 'Updated task from sync', done: true, completedBy: 'ai', createdAt: 1, updatedAt: now }),
      }]);
    };
    const handler = (command, args) => {
      fixture.calls.push({ command, id: args?.id, cwd: args?.cwd, data: args?.data, cols: args?.cols, rows: args?.rows, handoff: args?.handoff, resumeSessionId: args?.resumeSessionId, streamId: args?.streamId, sequence: args?.sequence });
      if (command === 'desktop_agents') return [
        { id: 'claude', name: 'Claude Code', path: fixture.missing ? null : '/mock/claude' },
        { id: 'codex', name: 'Codex', path: '/mock/codex' },
      ];
      if (command === 'desktop_start') {
        fixture.channels.set(args.id, args.output);
        const bytes = Array.from(new TextEncoder().encode('日本語ターミナル確認\\r\\n'));
        args.output.onmessage({ kind: 'data', streamId: 'fixture-stream', sequence: 1, bytes: bytes.slice(0, 2) });
        if (fixture.folder === '/smoke/quick-exit') args.output.onmessage({ kind: 'exit', code: 0 });
        return 1234;
      }
      if (command === 'desktop_ack' && args.sequence === 1) {
        fixture.channels.get(args.id)?.onmessage({ kind: 'data', streamId: 'fixture-stream', sequence: 2, bytes: Array.from(new TextEncoder().encode('日本語ターミナル確認\\r\\n')).slice(2) });
      }
      if (command === 'desktop_stop') {
        fixture.channels.get(args.id)?.onmessage({ kind: 'exit', code: null });
        fixture.channels.delete(args.id);
      }
    };
    {
      const listeners = new Set();
      window.bizencoreDesktop = {
        integratedTitlebar: true,
        mcpSupported: ${mcp},
        agents: () => Promise.resolve(handler('desktop_agents')),
        conversations: async () => [{ id: '44444444-4444-4444-8444-444444444444', title: 'Previous CLI session', updatedAt: Date.now() }],
        openExternal: async url => { fixture.calls.push({ command: 'openExternal', url }); },
        notify: async value => { fixture.calls.push({ command: 'notify', ...value }); },
        onFocusPane: callback => { fixture.focusPane = callback; return () => { fixture.focusPane = undefined; }; },
        folder: () => Promise.resolve(fixture.folder),
        start: args => Promise.resolve(handler('desktop_start', { ...args, output: { onmessage: event => listeners.forEach(callback => callback(args.id, event)) } })),
        write: (id, data) => Promise.resolve(handler('desktop_write', { id, data })),
        resize: (id, cols, rows) => Promise.resolve(handler('desktop_resize', { id, cols, rows })),
        acknowledgeOutput: (id, streamId, sequence) => Promise.resolve(handler('desktop_ack', { id, streamId, sequence })),
        stop: id => Promise.resolve(handler('desktop_stop', { id })),
        onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      };
    }
    (async () => {
      const { AgentWorkspace } = await import('./desktop/workspace');
      const { DesktopWorkspaceAccount } = await import('./desktop/workspace-account');
      const { DesktopFrame } = await import('./desktop/Frame');
      createRoot(document.getElementById('root')).render(
        <DesktopFrame><MemoryRouter><DesktopWorkspaceAccount.Provider value="desktop-test"><AgentWorkspace><App desktop /></AgentWorkspace></DesktopWorkspaceAccount.Provider></MemoryRouter></DesktopFrame>
      );
    })();
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify(mcp ? { VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_test_fixture_only' } : {}) },
});
const css = (await readFile('src/index.css', 'utf8')) + (await readFile('desktop/workspace.css', 'utf8')) + (await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8'));
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}), ...(process.env.DESKTOP_GPU_DISABLED === '1' ? { args: ['--disable-webgl'] } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('chrct.tasks.v2', JSON.stringify([
      { id: 'desktop-label', type: 'section', parentId: null, order: 0, text: 'Desktop tasks', color: 'blue', createdAt: now, updatedAt: now },
      { id: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', type: 'task', parentId: 'desktop-label', order: 0, text: 'A task title that needs usable space beside the agent workspace', done: false, createdAt: now, updatedAt: now },
    ]));
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1/');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  {
    assert.equal(await page.locator('.desktop-titlebar').isVisible(), false, 'no extra titlebar row above the shared header');
    assert.equal(await page.locator('.desktop-header .app-header').evaluate(element => getComputedStyle(element).webkitAppRegion), 'drag');
    assert.equal(await page.locator('.app-header-end').evaluate(element => getComputedStyle(element).webkitAppRegion), 'no-drag');
    assert.equal(await page.getByRole('button', { name: '設定', exact: true }).evaluate(element => getComputedStyle(element).webkitAppRegion), 'no-drag');
    assert.ok(await page.locator('.desktop-header .brand').evaluate(element => element.getBoundingClientRect().left >= 96), 'logo leaves room for native traffic-light controls');
    assert.ok(await page.locator('.desktop-workspace').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.top === 56 && Math.abs(rect.bottom - innerHeight) < 1;
    }), 'native controls and global header share one compact row without overflowing the workspace');
    for (const theme of ['white', 'original', 'black']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.locator('.desktop-header .app-header').evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), `combined titlebar/header follows the ${theme} workspace theme`);
    }
  }
  assert.equal(await page.locator('.app-header').count(), 1, 'one shared header instead of a header inside the task column');
  assert.equal(await page.locator('.desktop-tasks .app-header').count(), 0);
  assert.ok(await page.locator('.desktop-header .app-header').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left === 0 && Math.abs(rect.width - innerWidth) < 1 && rect.height === 56;
  }), 'global header spans all workspace columns');
  assert.equal(await page.locator('.agent-pane').count(), 0, 'no empty pane before configuration');
  await page.evaluate(() => { window.__desktopTest.missing = true; });
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  const initialSettings = page.getByRole('region', { name: 'ターミナル設定', exact: true });
  await initialSettings.locator('summary').click();
  await initialSettings.getByRole('button', { name: '診断を更新', exact: true }).click();
  await initialSettings.getByText('見つかりません', { exact: true }).waitFor();
  assert.match(await initialSettings.locator('code').first().textContent(), /curl -fsSL https:\/\/claude.ai\/install.sh/);
  await initialSettings.getByRole('link', { name: '認証', exact: true }).first().click();
  await page.waitForFunction(() => window.__desktopTest.calls.some(call => call.command === 'openExternal' && call.url === 'https://code.claude.com/docs/en/authentication'));
  assert.equal(await page.evaluate(() => window.__desktopTest.calls.some(call => call.command === 'desktop_start')), false, 'setup help never installs or authenticates automatically');
  await page.evaluate(() => { window.__desktopTest.missing = false; });
  await initialSettings.getByRole('button', { name: '診断を更新', exact: true }).click();
  await initialSettings.getByText('/mock/claude', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  await page.locator('.desktop-tasks .app-shell').evaluate(element => {
    const filler = document.createElement('div');
    filler.id = 'scroll-test-filler'; filler.style.height = '4000px'; element.appendChild(filler);
  });
  const scrollRail = page.getByRole('scrollbar', { name: 'タスクリストのスクロール位置' });
  await scrollRail.waitFor();
  assert.equal(await scrollRail.evaluate(element => getComputedStyle(element).left), '20px', 'desktop rail has visible left-edge spacing');
  assert.equal(await page.locator('.desktop-tasks').evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
  await scrollRail.press('End');
  await page.waitForFunction(() => document.querySelector('.task-scroll-rail').getAttribute('aria-valuenow') === '100');
  assert.equal(await page.evaluate(() => scrollY), 0, 'desktop rail scrolls only the task column, not the window');
  await scrollRail.press('Home');
  await page.waitForFunction(() => document.querySelector('.desktop-tasks').scrollTop === 0);
  await page.locator('#scroll-test-filler').evaluate(element => element.remove());
  await scrollRail.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.desktop-agents').evaluate(element => element.getBoundingClientRect().width), 56, 'zero agents collapse to a narrow rail');
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-zero-agents.png' });
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  const setupDivider = page.getByRole('separator', { name: 'エージェント選択画面の幅', exact: true });
  const agentColumnWidth = () => page.locator('.desktop-agents').evaluate(element => element.getBoundingClientRect().width);
  const assertCenteredLauncher = async () => {
    assert.ok(await page.locator('.agent-launcher').evaluate(element => {
      const form = element.getBoundingClientRect();
      const stage = element.parentElement.getBoundingClientRect();
      return Math.abs(form.left + form.width / 2 - stage.left - stage.width / 2) < 1
        && Math.abs(form.top + form.height / 2 - stage.top - stage.height / 2) < 1
        && form.width <= 360
        && form.height <= 280;
    }), 'launcher stays compact and centered in both axes');
  };
  assert.equal(await agentColumnWidth(), 400, 'launcher retains its compact initial width');
  await assertCenteredLauncher();
  await setupDivider.press('ArrowLeft');
  assert.equal(await agentColumnWidth(), 416, 'keyboard resize changes the actual launcher width');
  await setupDivider.press('ArrowRight');
  assert.equal(await agentColumnWidth(), 400);
  const setupBox = await setupDivider.boundingBox();
  await page.mouse.move(setupBox.x + setupBox.width / 2, setupBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(setupBox.x - 120, setupBox.y + 80, { steps: 8 });
  await page.mouse.up();
  assert.ok(await agentColumnWidth() > 500, 'dragging expands the launcher before any pane exists');
  assert.equal(await page.locator('.agent-pane').count(), 0, 'resizing never launches an agent');
  assert.equal(await page.evaluate(() => window.__desktopTest.calls.some(call => call.command === 'desktop_start')), false);
  for (const [targetX, expectedWidth] of [[1370, 280], [0, 1024]]) {
    const box = await setupDivider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(targetX, box.y + 80, { steps: 8 });
    await page.mouse.up();
    assert.equal(await agentColumnWidth(), expectedWidth, 'launcher resize respects both column minimums');
    assert.ok(await page.locator('.agent-launcher').evaluate(element => element.scrollWidth <= element.clientWidth), 'tiles fit at resize limits');
    await assertCenteredLauncher();
  }
  assert.equal(await page.locator('.agent-launcher').evaluate(element => element.getBoundingClientRect().width), 360, 'wide agent columns leave whitespace around a small form');
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-compact-launcher.png' });
  await page.setViewportSize({ width: 1380, height: 320 });
  assert.ok(await page.locator('.agent-launcher-stage').evaluate(element => element.scrollHeight > element.clientHeight), 'short windows scroll the launcher instead of clipping controls');
  await page.getByRole('form', { name: 'エージェントを起動する', exact: true }).getByRole('button', { name: '作業フォルダを選択', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.agent-launcher-stage').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), 'short launcher stays inside the workspace');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => document.querySelector('.desktop-agents').getBoundingClientRect().width === 544);
  assert.equal(await agentColumnWidth(), 544, 'resized launcher fits after narrowing the window');
  await assertCenteredLauncher();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.waitForFunction(() => document.querySelector('.desktop-agents').getBoundingClientRect().width === 1024);
  const restoreBox = await setupDivider.boundingBox();
  await page.mouse.move(restoreBox.x + restoreBox.width / 2, restoreBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(974, restoreBox.y + 80, { steps: 8 });
  await page.mouse.up();
  assert.equal(await agentColumnWidth(), 400);
  assert.equal(await page.locator('.app-header .brand-power').textContent(), '2');
  assert.equal(await page.locator('.app-header .brand').getAttribute('aria-label'), 'bizencore terminal squared');
  assert.equal(await page.locator('.app-header').evaluate(element => getComputedStyle(element).borderBottomWidth), '0px', 'shared desktop app header has no bottom divider');
  const taskLayout = page.locator('.desktop-tasks .tasks-layout.has-index');
  assert.equal(await taskLayout.count(), 1, 'fixture exercises the label index layout');
  assert.equal(await page.locator('.desktop-tasks .label-index').isVisible(), true, 'desktop retains the Web label index');
  assert.ok(await page.locator('.desktop-tasks .label-index').evaluate(element => {
    const index = element.getBoundingClientRect(), column = element.closest('.desktop-tasks').getBoundingClientRect();
    return index.left >= column.left && index.right <= column.right;
  }), 'label index remains inside the resizable task column');
  assert.ok(await page.locator('.desktop-tasks .row--task .row-title').first().evaluate(element => element.getBoundingClientRect().width > 120), 'task titles retain readable width');
  const inspector = page.getByRole('dialog', { name: 'タスクの詳細', exact: true });
  await page.locator('.row--task').first().getByRole('button', { name: '詳細を開く', exact: true }).click();
  await inspector.waitFor();
  assert.ok(await inspector.evaluate(element => element.parentElement.classList.contains('desktop-inspector')), 'details are portaled to the independent center column');
  assert.ok(await inspector.getByRole('textbox', { name: 'タスク', exact: true }).evaluate(element => element === document.activeElement), 'opening details retains title keyboard focus');
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.waitForFunction(() => {
      const color = getComputedStyle(document.body).color;
      return ['.row--task .row-title', '.nav-link.active'].every(selector => getComputedStyle(document.querySelector(selector)).color === color);
    });
    const background = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(await inspector.evaluate(element => getComputedStyle(element).backgroundColor), background, `docked details use the exact ${theme} workspace background`);
    assert.equal(await page.locator('.desktop-header .app-header').evaluate(element => getComputedStyle(element).backgroundColor), background);
    assert.equal(await inspector.evaluate(element => getComputedStyle(element).boxShadow), 'none');
    assert.ok(await page.evaluate(() => {
      const task = document.querySelector('.tasks-toolbar').getBoundingClientRect();
      const details = document.querySelector('.inspector-head').getBoundingClientRect();
      const agents = document.querySelector('.agent-toolbar').getBoundingClientRect();
      return task.top === details.top && details.top === agents.top && task.height === 54 && details.height === 54 && agents.height === 54;
    }), 'local task/detail/agent toolbar rows align below the common header');
    await page.screenshot({ path: `/private/tmp/bizencore-desktop-shared-header-${theme}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'black'; });
  const fixedHeadTop = await inspector.locator('.inspector-head').evaluate(element => element.getBoundingClientRect().top);
  await inspector.locator('.desktop-inspector-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.equal(await inspector.locator('.inspector-head').evaluate(element => element.getBoundingClientRect().top), fixedHeadTop, 'detail controls remain fixed while only their content scrolls');
  await inspector.locator('.desktop-inspector-content').evaluate(element => { element.scrollTop = 0; });
  {
    await inspector.getByRole('button', { name: '起動を設定', exact: true }).click();
    assert.equal(await page.locator('.agent-launcher').getByRole('combobox', { name: '担当タスク', exact: true }).inputValue(), '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', 'new-pane inspector handoff prefills the launcher');
    assert.equal(await page.locator('.agent-pane').count(), 0);
    assert.equal(await page.evaluate(() => window.__desktopTest.calls.some(call => call.command === 'desktop_start')), false);
    await page.getByRole('button', { name: '起動設定を閉じる', exact: true }).click();
    assert.equal(await page.locator('.agent-pane').count(), 0, 'canceling setup does not create a pane');
    await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  }
  const assertSeparateColumns = async () => {
    await page.waitForFunction(() => {
      const title = document.querySelector('.desktop-tasks .row--task .row-title');
      return !title || !title.getClientRects().length || title.getBoundingClientRect().width >= 120;
    });
    assert.ok(await page.evaluate(() => {
      const tasks = document.querySelector('.desktop-tasks').getBoundingClientRect();
      const details = document.querySelector('.desktop-inspector').getBoundingClientRect();
      const agents = document.querySelector('.desktop-agents').getBoundingClientRect();
      return tasks.width >= 250 && details.width >= 280 && agents.width >= 280 && tasks.right <= details.left && details.right <= agents.left && agents.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
    }), 'task list, details and terminals must be separate, non-overlapping columns');
  };
  for (const width of [900, 1380, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('.desktop-header .app-header').evaluate(element => {
      const brand = element.querySelector('.brand').getBoundingClientRect();
      const controls = element.querySelector('.app-header-end').getBoundingClientRect();
      return brand.right <= controls.left && controls.right <= innerWidth;
    }), 'compact titlebar keeps brand and global controls separate at every desktop width');
    await assertSeparateColumns();
    const resizeDetails = page.getByRole('separator', { name: '詳細パネルの幅', exact: true });
    const previous = Number(await resizeDetails.getAttribute('aria-valuenow'));
    await resizeDetails.press('ArrowLeft');
    assert.equal(Number(await resizeDetails.getAttribute('aria-valuenow')), Math.max(280, previous - 16));
    await resizeDetails.press('ArrowRight');
    await assertSeparateColumns();
    assert.ok(await inspector.getByRole('textbox', { name: 'タスク', exact: true }).evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'title grows after column resizing');
    await page.screenshot({ path: `/private/tmp/bizencore-desktop-inspector-${width}.png` });
  }
  await page.setViewportSize({ width: 1380, height: 900 });
  await inspector.getByRole('textbox', { name: 'メモ', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.ok(await inspector.evaluate(element => element.contains(document.activeElement)), 'inspector keyboard navigation stays within its column');
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.desktop-inspector').isVisible(), false);
  assert.equal(await page.locator('.desktop-workspace.has-inspector').count(), 0, 'closing details restores the two-column layout');
  await page.locator('.row--task .row-title').first().press('Alt+e');
  await inspector.waitFor();
  assert.ok(await inspector.getByRole('textbox', { name: '想定時間', exact: true }).evaluate(element => element === document.activeElement), 'estimate shortcut focuses its field after the center column appears');
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /today/ }).click();
  await page.getByRole('textbox', { name: '生活タスク', exact: true }).first().press('Control+i');
  const lifeInspector = page.getByRole('dialog', { name: '生活タスクの詳細', exact: true });
  await lifeInspector.waitFor();
  assert.equal(await lifeInspector.evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'life details inherit the same docked surface');
  assert.ok(await lifeInspector.evaluate(element => element.parentElement.classList.contains('desktop-inspector')), 'life task details use the same center column');
  assert.ok(await lifeInspector.getByRole('textbox', { name: '生活タスクのタイトル', exact: true }).evaluate(element => element === document.activeElement), 'life details retain initial title focus');
  await assertSeparateColumns();
  await lifeInspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.getByRole('tab', { name: 'all', exact: true }).click();
  const launcher = page.getByRole('form', { name: 'エージェントを起動する', exact: true });
  {
    assert.equal(await launcher.locator('.agent-launcher-field').count(), 4);
    for (const width of [900, 1380, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const fields = await launcher.locator('.agent-launcher-field').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      assert.ok(fields.every(field => field.width > field.height && field.height === 88), 'four compact horizontal tiles');
      assert.equal(fields[0].y, fields[1].y);
      assert.equal(fields[2].y, fields[3].y);
      assert.equal(fields[0].x, fields[2].x);
      assert.ok(fields[0].x < fields[1].x && fields[0].y < fields[2].y, 'agent/folder above label/task');
      assert.ok(await launcher.evaluate(element => element.scrollWidth <= element.clientWidth), 'long task values cannot widen the launcher');
      assert.ok(await launcher.locator('.agent-launcher-field select').evaluateAll(elements => elements.every(element => {
        const control = element.getBoundingClientRect(), tile = element.parentElement.getBoundingClientRect();
        return control.x === tile.x && control.y === tile.y && control.width === tile.width && control.height === tile.height && getComputedStyle(element).opacity === '0';
      })), 'the whole tile opens a native selection menu without a visible input frame');
    }
    await page.setViewportSize({ width: 1380, height: 900 });
    assert.equal(await launcher.getByRole('button', { name: '実行する', exact: true }).count(), 0, 'intent stays hidden without a task');
  }
  assert.equal(await launcher.getByRole('button', { name: '起動する', exact: true }).isEnabled(), false);
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('combobox', { name: '起動するエージェント', exact: true }).selectOption('codex');
  {
    await launcher.getByRole('combobox', { name: 'ラベル', exact: true }).selectOption('desktop-label');
    await launcher.getByRole('combobox', { name: '担当タスク', exact: true }).selectOption('370b6a1f-e4be-4e60-8bb8-8295a4f77e04');
    await launcher.getByRole('combobox', { name: 'ラベル', exact: true }).selectOption('');
    assert.equal(await launcher.getByRole('combobox', { name: '担当タスク', exact: true }).inputValue(), '', 'changing labels clears the previous task');
    await launcher.getByRole('combobox', { name: 'ラベル', exact: true }).selectOption('desktop-label');
    await launcher.getByRole('combobox', { name: '担当タスク', exact: true }).selectOption('370b6a1f-e4be-4e60-8bb8-8295a4f77e04');
    await launcher.getByRole('button', { name: '実行する', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__desktopTest.calls.some(call => call.command === 'desktop_start')), false, 'assignment must not start an agent');
  }
  assert.equal(await page.locator('.agent-pane').count(), 0, 'configuration does not allocate a terminal');
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-agent-launcher.png' });
  for (const theme of ['white', 'original', 'black']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok(await launcher.locator('.agent-launcher-field').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth)), 'tile values stay contained in every theme');
    await launcher.screenshot({ path: `/private/tmp/bizencore-desktop-launcher-tiles-${theme}.png` });
  }
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  const pane = page.locator('.agent-pane').first();
  await pane.locator('.agent-status-running').waitFor();
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  const settings = page.getByRole('region', { name: 'ターミナル設定', exact: true });
  assert.equal(await settings.getByText('ターミナルの文字サイズ', { exact: true }).isVisible(), true);
  assert.equal(await settings.getByLabel('ターミナル文字サイズ', { exact: true }).textContent(), '13 px');
  assert.equal(await settings.getByRole('checkbox').isChecked(), false, 'notifications default off');
  const fontLifecycle = await page.evaluate(() => window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length);
  await settings.getByRole('button', { name: '文字を大きく', exact: true }).click();
  await page.waitForFunction(() => window.__desktopTest.terminals[0].options.fontSize === 14);
  assert.equal(await settings.getByLabel('ターミナル文字サイズ', { exact: true }).textContent(), '14 px');
  assert.equal(await page.evaluate(() => window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length), fontLifecycle, 'font changes preserve the PTY');
  await settings.getByRole('button', { name: '文字を小さく', exact: true }).click();
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  const terminalSearch = pane.locator('.xterm-helper-textarea');
  await terminalSearch.press('Meta+f');
  const searchInput = pane.getByRole('textbox', { name: 'ターミナル出力を検索', exact: true });
  await searchInput.fill('日本語');
  await page.waitForFunction(() => window.__desktopTest.terminals[0].getSelection() === '日本語');
  await searchInput.fill('no-such-terminal-output');
  await pane.locator('.agent-terminal-search [role="status"]').getByText('0/0', { exact: true }).waitFor();
  await searchInput.press('Escape');
  assert.equal(await searchInput.count(), 0);
  assert.ok(await terminalSearch.evaluate(element => element === document.activeElement), 'Escape restores terminal focus');
  const checkTerminalThemes = async renderer => {
    const before = await page.evaluate(() => ({
      lifecycle: window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length,
      text: window.__desktopTest.terminals[0].buffer.active.getLine(0)?.translateToString(true),
    })).then(({ lifecycle, text }) => ({ lifecycle, text }));
    for (const theme of ['white', 'original', 'black']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForFunction(() => {
        const root = getComputedStyle(document.documentElement);
        return window.__desktopTest.terminals[0].options.theme.background === root.getPropertyValue('--bg-color').trim()
          && getComputedStyle(document.querySelector('.row--task .row-title')).color === getComputedStyle(document.body).color;
      });
      const palette = await page.evaluate(() => {
        const term = window.__desktopTest.terminals[0];
        const style = getComputedStyle(document.documentElement);
        term.select(0, 0, 5);
        return {
          theme: term.options.theme,
          foreground: style.getPropertyValue('--text-primary').trim(),
          cursor: style.getPropertyValue('--accent-color').trim(),
          contrast: term.options.minimumContrastRatio,
          text: term.buffer.active.getLine(0)?.translateToString(true),
          lifecycle: window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length,
        };
      });
      assert.equal(palette.theme.foreground, palette.foreground);
      assert.equal(palette.theme.cursor, palette.cursor);
      assert.equal(palette.contrast, 4.5, 'truecolor CLI output also gets readable contrast');
      assert.equal(palette.text, before.text, 'theme changes preserve terminal output');
      assert.equal(palette.lifecycle, before.lifecycle, 'theme changes never restart the PTY');
      const background = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
      assert.equal(await page.locator('.desktop-agents').evaluate(element => getComputedStyle(element).backgroundColor), background);
      assert.equal(await pane.locator('.xterm-scrollable-element').evaluate(element => getComputedStyle(element).backgroundColor), background, `${renderer} terminal background follows ${theme}`);
      await page.screenshot({ path: `/private/tmp/bizencore-terminal-theme-${renderer}-${theme}.png` });
      await page.evaluate(() => window.__desktopTest.terminals[0].clearSelection());
    }
  };
  assert.equal(await pane.getByRole('combobox', { name: 'エージェント', exact: true }).isEnabled(), false);
  {
    await page.waitForFunction(() => window.__desktopTest.calls.some(call => call.command === 'desktop_ack' && call.streamId === 'fixture-stream' && call.sequence === 2));
    await page.evaluate(() => new Promise(resolve => window.__desktopTest.terminals[0].write('\r\n\x1b[31mRed \x1b[32mGreen \x1b[33mYellow \x1b[34mBlue \x1b[35mMagenta \x1b[36mCyan\x1b[0m\r\n\x1b[38;2;220;220;220mTruecolor contrast\x1b[0m\r\n', resolve)));
    await checkTerminalThemes('gpu');
    assert.ok(await pane.locator('.xterm-screen canvas, .xterm-rows').count() > 0, 'terminal renderer remains mounted after split Japanese output');
    if (await pane.locator('.xterm-screen canvas').count() > 0) {
      const gpu = await pane.locator('.xterm-screen canvas').evaluateAll(canvases => {
        const context = canvases.map(canvas => canvas.getContext('webgl2')).find(Boolean);
        const extension = context?.getExtension('WEBGL_lose_context');
        extension?.loseContext();
        return { available: Boolean(context), lost: Boolean(extension) };
      });
      if (gpu.available) assert.ok(gpu.lost, 'GPU renderer must expose the context-loss test extension');
    }
    await page.waitForFunction(() => document.querySelector('.agent-pane .xterm-rows')?.textContent.includes('日本語ターミナル確認'));
    await checkTerminalThemes('dom');
    await page.evaluate(() => new Promise(resolve => window.__desktopTest.terminals[0].write('\r\nhttps://example.com\r\n', resolve)));
    const linkPosition = await page.evaluate(() => {
      const term = window.__desktopTest.terminals[0];
      const rect = document.querySelector('.agent-pane .xterm-screen').getBoundingClientRect();
      const buffer = term.buffer.active;
      let row = 0;
      for (let index = 0; index < buffer.length; index++) if (buffer.getLine(index)?.translateToString().includes('https://example.com')) row = index - buffer.viewportY;
      return { x: rect.x + rect.width / term.cols * 5, y: rect.y + rect.height / term.rows * (row + 0.5) };
    });
    await page.mouse.move(linkPosition.x, linkPosition.y);
    await pane.locator('.xterm-cursor-pointer').waitFor();
    await page.mouse.click(linkPosition.x, linkPosition.y);
    await page.waitForFunction(() => window.__desktopTest.calls.some(call => call.command === 'openExternal' && call.url === 'https://example.com'));
    const handoff = await page.evaluate(() => window.__desktopTest.calls.find(call => call.command === 'desktop_start').handoff);
    assert.equal(handoff.taskId, '370b6a1f-e4be-4e60-8bb8-8295a4f77e04');
    assert.equal(handoff.intent, 'execute');
    assert.match(handoff.prompt, mcp ? /work_on_task.*task_id/ : /次のタスクを実行/);
    assert.match(handoff.prompt, mcp ? /record_task_progress/ : /進捗の自動反映はできません/);
    assert.equal(await pane.getByRole('button', { name: '担当タスクを外す' }).isEnabled(), false);
    assert.equal(await pane.getByRole('button', { name: '担当タスクを選択' }).isEnabled(), false);
    assert.match(await pane.locator('.agent-assignment').textContent(), /送信済み/);
    await page.screenshot({ path: '/private/tmp/bizencore-desktop-task-handoff.png' });
    await pane.getByRole('button', { name: '担当タスクの詳細を開く', exact: true }).click();
    await inspector.waitFor();
    await page.keyboard.press('Escape');
    await inspector.waitFor({ state: 'detached' });
    assert.ok(await pane.getByRole('button', { name: '担当タスクの詳細を開く', exact: true }).evaluate(element => element === document.activeElement), 'closing details restores the agent-side origin');
  }
  const firstId = await pane.getAttribute('id');
  await page.evaluate(() => { window.__firstPaneNode = document.querySelector('.agent-pane'); });
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  assert.equal(await launcher.locator('.agent-launcher-folder').getAttribute('title'), '/smoke/project', 'next launcher inherits the last started folder');
  await page.evaluate(() => { window.__desktopTest.folder = '/smoke/cancelled'; });
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('button', { name: '起動設定を閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  assert.equal(await launcher.locator('.agent-launcher-folder').getAttribute('title'), '/smoke/project', 'cancelled folder choices do not replace the launch default');
  assert.equal(await launcher.getByRole('button', { name: '起動する', exact: true }).isEnabled(), true, 'a folder default and optional task allow direct launch');
  await page.evaluate(() => { window.__desktopTest.folder = '/smoke/second-project'; });
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  await page.locator('.agent-status-running').nth(1).waitFor();
  const lifecycleCalls = await page.evaluate(() => window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length);
  await page.getByRole('button', { name: 'タブ表示', exact: true }).click();
  assert.equal(await page.locator('.agent-pane:visible').count(), 1);
  await page.evaluate(id => window.__desktopTest.focusPane(id.replace('pane-', '')), firstId);
  await page.waitForFunction(id => document.querySelector('.agent-pane:not([hidden])')?.id === id, firstId);
  await page.waitForFunction(id => document.activeElement === document.getElementById(id)?.querySelector('.xterm-helper-textarea'), firstId);
  assert.ok(await pane.locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement), 'notification clicks reveal and focus the requested pane');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'white'; });
  await page.waitForFunction(() => window.__desktopTest.terminals.slice(0, 2).every(term => term.options.theme.background === '#f6f8fa'));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'black'; });
  await page.waitForFunction(() => window.__desktopTest.terminals.slice(0, 2).every(term => term.options.theme.background === '#0a0b0c'));
  await page.getByRole('tablist', { name: 'エージェントペイン', exact: true }).getByRole('tab').last().press('ArrowLeft');
  assert.equal(await page.locator('.agent-pane:visible').getAttribute('id'), firstId);
  await page.getByRole('button', { name: '選択ペインを後ろへ', exact: true }).click();
  assert.equal(await page.locator('.agent-pane').last().getAttribute('id'), firstId);
  await page.getByRole('button', { name: '選択ペインを前へ', exact: true }).click();
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  assert.equal(await launcher.locator('.agent-launcher-folder').getAttribute('title'), '/smoke/second-project', 'reordering panes does not change the most recently used folder');
  await launcher.getByRole('button', { name: '起動設定を閉じる', exact: true }).click();
  await page.getByRole('button', { name: '並列表示', exact: true }).click();
  await pane.getByRole('button', { name: 'ペインを拡大・縮小', exact: true }).click();
  assert.equal(await page.locator('.agent-pane:visible').count(), 1);
  await pane.getByRole('button', { name: 'ペインを拡大・縮小', exact: true }).click();
  assert.equal(await page.locator('.agent-pane:visible').count(), 2);
  assert.equal(await page.evaluate(() => window.__firstPaneNode === document.querySelector('.agent-pane')), true, 'layout changes preserve the actual terminal node');
  assert.equal(await page.evaluate(() => window.__desktopTest.calls.filter(call => ['desktop_start', 'desktop_stop'].includes(call.command)).length), lifecycleCalls, 'switching, ordering and zoom never restart agents');
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-agent-layout.png' });
  await page.locator('.agent-pane').last().getByRole('button', { name: 'ペインを閉じる', exact: true }).click();
  const terminal = pane.locator('.xterm-helper-textarea');
  await terminal.press('ArrowDown');
  await terminal.press('Alt+3');
  await terminal.press('Control+k');
  assert.equal(await page.getByRole('tab', { name: 'all', exact: true }).getAttribute('aria-selected'), 'true', 'terminal keys must not switch the task view');
  assert.equal(await page.locator('.app-nav .active').textContent(), 'tasks', 'terminal Control+K must not change pages');
  await terminal.press('a');
  await page.waitForFunction(() => window.__desktopTest.calls.some(call => call.command === 'desktop_write' && call.data === 'a'));
  await page.locator('.row--task').first().getByRole('button', { name: '詳細を開く', exact: true }).click();
  await inspector.waitFor();
  await assertSeparateColumns();
  assert.equal(await pane.locator('.agent-status-running').count(), 1, 'opening details does not remount or stop the running terminal');
  await page.getByRole('button', { name: 'エージェント画面を拡大・縮小', exact: true }).click();
  assert.equal(await page.locator('.desktop-tasks').isVisible(), false);
  assert.equal(await page.locator('.desktop-header .app-header').isVisible(), true, 'global controls remain visible in expanded agent mode');
  assert.ok(await inspector.isVisible(), 'agent expansion preserves the independent details column');
  assert.ok(await page.evaluate(() => document.querySelector('.desktop-inspector').getBoundingClientRect().right <= document.querySelector('.desktop-agents').getBoundingClientRect().left));
  await inspector.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.getByRole('button', { name: 'エージェント画面を拡大・縮小', exact: true }).click();
  await pane.getByRole('button', { name: 'エージェントを停止', exact: true }).click();
  await pane.locator('.agent-status-exited').waitFor();
  assert.equal(await page.evaluate(() => window.__desktopTest.calls.filter(call => call.command === 'notify').length), 0, 'CLI exit never indicates completion');
  await pane.getByRole('button', { name: '担当タスクを選択', exact: true }).click();
  const assignmentPicker = pane.getByRole('region', { name: '担当タスクを選択', exact: true });
  assert.equal(await assignmentPicker.getByRole('combobox', { name: 'ラベル', exact: true }).inputValue(), 'desktop-label');
  assert.equal(await assignmentPicker.getByRole('combobox', { name: '担当タスク', exact: true }).inputValue(), '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', 'reopening the picker preserves label and task selection');
  await assignmentPicker.getByRole('button', { name: 'タスク選択を閉じる', exact: true }).click();
  const sessionPicker = pane.getByRole('combobox', { name: 'CLIセッション', exact: true });
  assert.equal(await sessionPicker.inputValue(), '', 'stopped panes default to a new session');
  await sessionPicker.selectOption('44444444-4444-4444-8444-444444444444');
  await pane.getByRole('button', { name: '担当タスクを選択', exact: true }).click();
  await assignmentPicker.getByRole('button', { name: '割り当て', exact: true }).click();
  assert.equal(await sessionPicker.inputValue(), '', 'a fresh task handoff clears the previous conversation selection');
  await sessionPicker.selectOption('44444444-4444-4444-8444-444444444444');
  await page.waitForFunction(() => !document.querySelector('.agent-pane-head [aria-label="エージェントを起動"]').disabled);
  assert.equal(await pane.locator('.xterm-screen canvas').count(), 0, 'stopped panes release GPU renderers');
  await page.waitForFunction(() => document.querySelector('.agent-pane .xterm-rows')?.textContent.includes('日本語ターミナル確認'));
  await pane.getByRole('button', { name: 'エージェントを起動', exact: true }).click();
  await pane.locator('.agent-status-running').waitFor();
  const resumedStart = await page.evaluate(() => window.__desktopTest.calls.filter(call => call.command === 'desktop_start').at(-1));
  assert.equal(resumedStart.resumeSessionId, '44444444-4444-4444-8444-444444444444');
  assert.equal(resumedStart.handoff, undefined, 'resume never repeats the task handoff');
  {
    await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
    await settings.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
    await page.evaluate(() => window.__desktopTest.progress());
    await pane.getByText('Updated task from sync', { exact: true }).waitFor();
    assert.match(await pane.locator('.agent-assignment').textContent(), /完了/);
    await page.waitForFunction(() => window.__desktopTest.calls.filter(call => call.command === 'notify').length === 1);
    assert.equal(await page.evaluate(() => window.__desktopTest.calls.find(call => call.command === 'notify').paneId), firstId.replace('pane-', ''));
    await pane.getByRole('button', { name: 'エージェントを停止', exact: true }).click();
    await pane.locator('.agent-status-exited').waitFor();
    await sessionPicker.selectOption('');
    assert.equal(await pane.getByRole('button', { name: 'エージェントを起動', exact: true }).isEnabled(), false, 'completed assignment must not be launched again');
    assert.equal(await page.evaluate(() => window.__desktopTest.calls.filter(call => call.command === 'notify').length), 1, 'exit does not repeat the verified completion notification');
  }
  await pane.getByRole('button', { name: 'ペインを閉じる' }).click();
  assert.equal(await page.locator('.agent-pane').count(), 0);
  await page.evaluate(() => { window.__desktopTest.folder = '/smoke/quick-exit'; });
  assert.equal(await page.locator('.desktop-agents').evaluate(element => element.getBoundingClientRect().width), 56, 'closing the last agent collapses its entire region');
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  assert.equal(await launcher.locator('.agent-launcher-folder').getAttribute('title'), '/smoke/project', 'last started folder remains after all panes close');
  await launcher.locator('.agent-folder-select').click();
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  const quick = page.locator('.agent-pane').first();
  await quick.locator('.agent-status-exited').waitFor();
  for (let i = 1; i < 8; i++) {
    await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
    assert.equal(await launcher.locator('.agent-launcher-folder').getAttribute('title'), '/smoke/quick-exit');
    await launcher.getByRole('button', { name: '起動する', exact: true }).click();
    await page.locator('.agent-pane').last().locator('.agent-status-exited').waitFor();
  }
  assert.equal(await page.locator('.agent-pane').count(), 8);
  assert.equal(await page.locator('.agent-pane .xterm-screen canvas').count(), 0, 'resting eight-pane layout keeps GPU renderers unallocated');
  assert.equal(await page.getByRole('button', { name: 'エージェントを追加', exact: true }).isEnabled(), false);
  for (const width of [900, 1380]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop layout has no horizontal page overflow');
    const headers = await page.locator('.agent-pane-head').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return [...element.children].every(child => child.getBoundingClientRect().right <= rect.right + 1);
    }));
    assert.ok(headers.every(Boolean), 'pane header controls fit');
    await page.screenshot({ path: `/private/tmp/bizencore-desktop-eight-${width}.png` });
  }
  const splitter = page.getByRole('separator', { name: 'タスク画面の幅' });
  await splitter.press('ArrowRight');
  assert.equal(await splitter.getAttribute('aria-valuenow'), '48');
  for (let i = 0; i < 9; i++) await splitter.press('ArrowRight');
  assert.equal(await splitter.getAttribute('aria-valuenow'), '65');
  assert.ok(await page.locator('.agent-pane-head').evaluateAll(elements => elements.every(element => {
    const right = element.getBoundingClientRect().right;
    return [...element.children].every(child => child.getBoundingClientRect().right <= right + 1);
  })), 'narrow agent region switches to one column');
  await page.getByRole('button', { name: 'エージェント画面を拡大・縮小' }).click();
  assert.equal(await page.locator('.desktop-tasks').isVisible(), false);
  await page.locator('.desktop-header').getByRole('link', { name: 'tasks', exact: true }).click();
  assert.equal(await page.locator('.desktop-tasks').isVisible(), true, 'global navigation restores the task column after agent expansion');
  assert.deepEqual(errors, []);
  console.log('Passed: Electron workspace layout, centered 2x2 launcher, setup help, font/search/web links, specific session resume without handoff, verified completion notification and pane focus, terminal continuity and eight-pane limit (mock native IPC).');
} finally { await browser.close(); }
