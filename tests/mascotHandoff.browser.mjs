import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter, useNavigate } from 'react-router-dom';
    import App from './src/App';
    import { taskStore } from './src/lib/taskStore';
    import { applyTheme } from './src/lib/theme';
    import { DesktopHandoffContext } from './src/lib/desktopHandoff';
    const params = new URLSearchParams(location.search);
    applyTheme(params.get('theme') || 'black');
    globalThis.fixtureAuth = { userId: params.has('signedOut') ? null : 'account-a', isLoaded: true,
      isSignedIn: !params.has('signedOut'), getToken: async () => 'fixture-token' };
    const rows = [
      { id: 'label', type: 'section', parentId: null, order: 0, text: 'ハンドオフ' },
      { id: 'task-a', type: 'task', parentId: 'label', order: 0, text: 'チルノの操作を確認する', note: "Private note: user's task" },
      { id: 'child', type: 'task', parentId: 'task-a', order: 0, text: '子タスクを確認する' },
      { id: 'task-b', type: 'task', parentId: 'label', order: 1, text: '長いタスク名'.repeat(35), locked: true },
    ];
    if (!params.has('retain')) taskStore.mergeRemote(rows.map(item => ({ itemId: item.id, updatedAt: 1,
      payload: JSON.stringify({ done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    globalThis.fixtureStore = taskStore;
    globalThis.fixtureAssignments = [];
    function Fixture() {
      const [, render] = useState(0);
      globalThis.fixtureNavigate = useNavigate();
      globalThis.fixtureAccount = userId => { globalThis.fixtureAuth = { ...globalThis.fixtureAuth, userId, isSignedIn: !!userId }; render(value => value + 1); };
      return <DesktopHandoffContext.Provider value={params.has('desktop') ? {
        panes: [], mcpAvailable: !params.has('noMcp'), assign: (paneId, assignment) => {
          globalThis.fixtureAssignments.push({ paneId, ...assignment });
          return globalThis.fixtureAssignmentError || null;
        },
      } : null}><App desktop={params.has('desktop')} /></DesktopHandoffContext.Provider>;
    }
    createRoot(document.getElementById('root')).render(<MemoryRouter><Fixture /></MemoryRouter>);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-services', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: process.cwd(), loader: 'js', contents: args.path === 'convex/react' ? `
      import { getFunctionName } from 'convex/server';
      const mutate = async () => ({});
      mutate.withOptimisticUpdate = () => mutate;
      export const useQuery = query => getFunctionName(query) === 'accountDeletion:status' ? { userId: globalThis.fixtureAuth.userId, phase: 'active' } : undefined;
      export const useMutation = () => mutate;
      export const useAction = () => mutate;
      export const useConvexAuth = () => ({ isAuthenticated: globalThis.fixtureAuth.isSignedIn, isLoading: false });
    ` : `
      export const useAuth = () => globalThis.fixtureAuth;
      export const useClerk = () => ({ signOut: async () => {} });
      export const SignedIn = ({ children }) => globalThis.fixtureAuth.isSignedIn ? children : null;
      export const SignedOut = ({ children }) => globalThis.fixtureAuth.isSignedIn ? null : children;
      export const SignInButton = ({ children }) => children;
      export const UserButton = () => null;
    ` }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!location.search.includes('retain')) localStorage.clear();
    globalThis.fixtureCopies = []; globalThis.fixtureLinks = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => {
      if (globalThis.failCopy) throw new Error('clipboard unavailable');
      if (globalThis.holdCopy) await new Promise(resolve => globalThis.releaseCopy = resolve);
      globalThis.fixtureCopies.push(value);
    } } });
    document.addEventListener('click', event => {
      const link = event.target.closest('a.mascot-handoff-action');
      if (link) { event.preventDefault(); globalThis.fixtureLinks.push(link.href); }
    }, true);
  });
  await page.route('**/*', route => {
    if (route.request().url().startsWith('https://mascot.test/')) return route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` });
    external.push(route.request().url()); return route.abort();
  });
  const mascot = () => page.locator('.mascot-button');
  const settings = () => page.getByRole('dialog', { name: 'チルノのハンドオフ設定', exact: true });
  const handoff = () => page.getByRole('dialog', { name: 'タスクのハンドオフ', exact: true });
  const row = (id = 'task-a') => page.locator('[data-row-id="' + id + '"]');
  const openSettings = async () => { await mascot().click(); await settings().waitFor(); };
  const selectTask = async (id = 'task-a') => { await settings().getByLabel('タスクを選ぶ', { exact: true }).selectOption(id); await handoff().waitFor(); };
  const drag = async (selector, beforeDrop) => {
    const source = await mascot().boundingBox(), destination = await page.locator(selector).boundingBox();
    assert.ok(source && destination);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    assert.equal(await page.locator('.mascot-sweat').count(), 0, 'a simple press does not start sweating');
    await page.mouse.move(source.x + source.width / 2, source.y - 35);
    await page.locator('.mascot-drag-preview .mascot-sweat').first().waitFor();
    await page.mouse.move(destination.x + destination.width / 2, destination.y + Math.min(destination.height / 2, 20), { steps: 12 });
    const offset = await page.locator('.mascot-drag-preview').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - parseFloat(el.style.left), y: rect.top + rect.height / 2 - parseFloat(el.style.top) };
    });
    assert.ok(Math.abs(offset.x) < 1 && Math.abs(offset.y) < 1, `drag preview must center on pointer: ${JSON.stringify(offset)}`);
    if (beforeDrop) await beforeDrop();
    await page.mouse.up();
  };
  const counts = () => page.evaluate(() => [fixtureCopies.length, fixtureLinks.length]);
  const verifyPrompt = (value, intent, mcp) => {
    assert.match(value, intent === 'execute' ? /explicitly selected "実行する"/ : /explicitly selected "検討する"/);
    if (mcp) { assert.match(value, /task_id "task-a"/); assert.doesNotMatch(value, /Private note/); }
    else { assert.match(value, /Private note: user/); assert.match(value, /自動反映はできません/); }
  };

  await page.goto('https://mascot.test/');
  await row().waitFor();
  assert.equal(await page.locator('.mascot').evaluate(el => getComputedStyle(el).scale), 'none', 'provided artwork keeps its original orientation');
  assert.equal(await page.locator('.mascot').evaluate(el => getComputedStyle(el).width), '108px', 'mascot is only ten percent smaller');
  await mascot().hover();
  await page.getByRole('tooltip').filter({ hasText: 'Codex？' }).waitFor();
  assert.equal(await page.locator('.mascot-question').count(), 0, 'thought bubble replaces the isolated question mark');
  await openSettings();
  assert.equal(await settings().getByLabel('エージェント', { exact: true }).inputValue(), 'codex');
  assert.equal(await settings().getByLabel('渡し方', { exact: true }).inputValue(), 'mcp');
  await page.keyboard.press('Escape');
  assert.equal(await settings().count(), 0);
  assert.equal(await mascot().evaluate(el => el === document.activeElement), true);

  await drag('[data-row-id="task-a"] .row-title', async () => {
    assert.equal(await row().evaluate(el => el.classList.contains('is-mascot-drop-target')), true);
    assert.equal(await page.locator('.mascot-drag-preview [data-mood="dragging"]').count(), 1);
    assert.equal(await page.locator('.mascot-sweat').count(), 3, 'sweat continues over tasks');
    assert.equal(await page.locator('.mascot-drag-preview .mascot-sparkle').count(), 0);
    const flight = await page.locator('.mascot-sweat').first().evaluate(el => {
      const animation = el.getAnimations()[0]; animation.pause(); animation.currentTime = 150;
      const start = getComputedStyle(el).transform; animation.currentTime = 750;
      const end = getComputedStyle(el).transform; animation.play(); return { start, end };
    });
    assert.notEqual(flight.start, flight.end, 'sweat droplets fly outward');
    assert.equal(await page.locator('.is-context-drop-target').count(), 0);
    await page.screenshot({ path: '/private/tmp/bizencore-mascot-drag.png' });
  });
  await handoff().waitFor();
  assert.equal(await page.locator('.mascot-button [data-mood="happy"]').count(), 1);
  await page.screenshot({ path: '/private/tmp/bizencore-cirno-joy.png' });
  await page.waitForFunction(() => !document.querySelector('.mascot-button [data-mood="happy"]'));
  assert.equal(await page.locator('.is-mascot-drop-target, .mascot-drag-preview').count(), 0);
  assert.deepEqual(await counts(), [0, 0], 'dropping only proposes a handoff');
  assert.equal(await handoff().locator('.mascot-task-name').innerText(), 'チルノの操作を確認する');
  await handoff().getByRole('button', { name: 'Codexにハンドオフ', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '起動コマンドをコピーしたよ' }).waitFor();
  const command = await page.evaluate(() => fixtureCopies.at(-1));
  assert.ok(command.startsWith('codex ')); verifyPrompt(command, 'consult', true);
  assert.equal(await row().locator('.row-title').inputValue(), 'チルノの操作を確認する');
  assert.equal(await page.evaluate(() => fixtureStore.getState().items['task-a'].attachments?.length ?? 0), 0);

  await page.keyboard.press('Escape');
  await drag('[data-row-id="label"]');
  assert.equal(await handoff().count(), 0, 'labels do not accept the mascot');
  await drag('.app-header');
  assert.equal(await handoff().count(), 0, 'missing a task does nothing');
  await drag('[data-row-id="child"] .row-title', async () => { await page.keyboard.press('Escape'); });
  assert.equal(await handoff().count(), 0, 'Escape cancels a drag');
  assert.equal(await page.locator('.is-mascot-drop-target').count(), 0);
  assert.deepEqual(await counts(), [1, 0]);

  for (const agent of ['claude-code', 'codex', 'claude', 'chatgpt']) {
    await openSettings();
    await settings().getByLabel('エージェント', { exact: true }).selectOption(agent);
    await page.keyboard.press('Escape'); await mascot().hover();
    assert.equal(await page.getByRole('tooltip').innerText(), ({ 'claude-code': 'Claude Code', codex: 'Codex', claude: 'Claude', chatgpt: 'ChatGPT' })[agent] + '？');
    await openSettings();
    await settings().getByRole('button', { name: '実行する', exact: true }).click();
    await selectTask();
    const action = handoff().locator('.mascot-handoff-action');
    await action.click();
    if (agent === 'codex' || agent === 'claude-code') {
      await page.getByRole('status').filter({ hasText: 'コピーしたよ' }).waitFor();
      verifyPrompt(await page.evaluate(() => fixtureCopies.at(-1)), 'execute', true);
    } else {
      const url = new URL(await action.getAttribute('href'));
      assert.equal(url.hostname, agent === 'claude' ? 'claude.ai' : 'chatgpt.com');
      verifyPrompt(url.searchParams.get('q'), 'execute', true);
    }
  }

  await openSettings();
  await settings().getByLabel('エージェント', { exact: true }).selectOption('claude');
  await settings().getByLabel('渡し方', { exact: true }).selectOption('text');
  await selectTask();
  await handoff().locator('.mascot-handoff-action').click();
  await page.getByRole('status').filter({ hasText: '指示文をコピーしたよ' }).waitFor();
  verifyPrompt(await page.evaluate(() => fixtureCopies.at(-1)), 'execute', false);
  assert.equal(new URL(await handoff().locator('a').getAttribute('href')).searchParams.get('q'), '');

  await openSettings();
  await settings().getByLabel('開く先', { exact: true }).selectOption('desktop');
  await selectTask();
  assert.ok((await handoff().locator('a').getAttribute('href')).startsWith('claude://'));
  await openSettings();
  await settings().getByLabel('エージェント', { exact: true }).selectOption('codex');
  await settings().getByLabel('渡し方', { exact: true }).selectOption('mcp');
  await page.goto('https://mascot.test/?retain');
  await openSettings();
  assert.equal(await settings().getByLabel('エージェント', { exact: true }).inputValue(), 'codex');
  assert.equal(await settings().getByRole('button', { name: '検討する', exact: true }).getAttribute('aria-pressed'), 'true', 'execution intent is not saved across reloads');
  await selectTask();
  await page.evaluate(() => { globalThis.failCopy = true; });
  await handoff().locator('.mascot-handoff-action').click();
  const fallback = handoff().getByLabel('手動でコピーする内容');
  await fallback.waitFor(); verifyPrompt(await fallback.inputValue(), 'consult', true);
  await fallback.focus();
  assert.equal(await fallback.evaluate(el => el.selectionEnd - el.selectionStart), (await fallback.inputValue()).length);
  await page.evaluate(() => { globalThis.failCopy = false; globalThis.holdCopy = true; });
  await handoff().locator('.mascot-handoff-action').click();
  await page.waitForFunction(() => !!globalThis.releaseCopy);
  await openSettings(); await selectTask('child');
  await page.evaluate(() => releaseCopy());
  await page.waitForTimeout(50);
  assert.equal(await handoff().getByRole('status').count(), 0, 'an old copy result cannot appear for another task');

  await page.evaluate(() => fixtureStore.remove('child'));
  await handoff().getByRole('status').filter({ hasText: '削除されたよ' }).waitFor();
  assert.equal(await handoff().locator('.mascot-handoff-action').count(), 0);
  await page.evaluate(() => fixtureAccount('account-b'));
  assert.equal(await handoff().count(), 0, 'switching accounts clears the selected task');

  await page.goto('https://mascot.test/?retain&signedOut');
  await openSettings();
  assert.equal(await settings().getByLabel('渡し方', { exact: true }).inputValue(), 'text');
  assert.equal(await settings().locator('option[value="mcp"]').evaluate(el => el.disabled), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bizencore.aiHandoff')).mode), 'mcp', 'sign-out does not overwrite the saved preference');
  await selectTask(); await handoff().locator('.mascot-handoff-action').click();
  await page.getByRole('status').filter({ hasText: '起動コマンドをコピーしたよ' }).waitFor();
  verifyPrompt(await page.evaluate(() => fixtureCopies.at(-1)), 'consult', false);

  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const source = await mascot().boundingBox(), destination = await row().boundingBox();
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const end = { x: destination.x + destination.width / 2, y: destination.y + 20 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 10; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove',
    touchPoints: [{ x: start.x + (end.x - start.x) * step / 10, y: start.y + (end.y - start.y) * step / 10, id: 1 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await handoff().waitFor();
  assert.equal(await handoff().locator('.mascot-task-name').innerText(), 'チルノの操作を確認する');
  await touch.detach();

  for (const theme of ['black', 'white', 'original']) for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await openSettings();
    assert.ok(await settings().evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth));
    if (theme === 'black') await page.screenshot({ path: '/private/tmp/bizencore-mascot-settings-' + width + '.png' });
    await selectTask('task-b');
    assert.ok(await handoff().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: '/private/tmp/bizencore-mascot-' + theme + '-' + width + '.png' });
    await page.keyboard.press('Escape'); await mascot().hover();
    const thought = page.getByRole('tooltip'); await thought.waitFor();
    assert.ok(await thought.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; }), 'thought bubble stays in viewport');
    assert.equal(await thought.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.equal(await mascot().getAttribute('aria-describedby'), await thought.getAttribute('id'));
    if ((theme === 'black' && width === 1280) || (theme === 'white' && width === 320)) await page.screenshot({ path: '/private/tmp/bizencore-mascot-thought-' + theme + '-' + width + '.png' });
  }

  await page.evaluate(() => fixtureNavigate('/count'));
  await page.getByRole('button', { name: 'bizencore について', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /あたいが文字数をかぞえるよ/);
  assert.equal(await page.locator('.mascot-container--handoff').count(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://mascot.test/?desktop');
  await row().waitFor();
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(await mascot().count(), 1, 'desktop also mounts the shared mascot');
  await drag('[data-row-id="task-a"] .row-title');
  assert.deepEqual(await page.evaluate(() => fixtureAssignments), [{ paneId: null, taskId: 'task-a', intent: 'consult', mode: 'mcp' }]);
  assert.equal(await handoff().count(), 0, 'desktop drops go directly to the workspace');
  assert.deepEqual(await counts(), [0, 0], 'desktop never copies commands or opens external AI links');
  await openSettings();
  await settings().getByRole('button', { name: '実行する', exact: true }).click();
  await settings().getByLabel('タスクを選ぶ', { exact: true }).selectOption('task-a');
  assert.equal(await page.evaluate(() => fixtureAssignments.at(-1).intent), 'execute', 'keyboard task selection uses the same assignment');
  await page.evaluate(() => { globalThis.fixtureAssignmentError = 'エージェントは8件まで起動できます'; });
  await drag('[data-row-id="task-a"] .row-title');
  await page.getByRole('alert').getByText('エージェントは8件まで起動できます', { exact: true }).waitFor();
  await page.goto('https://mascot.test/?desktop&noMcp');
  await row().waitFor();
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  await openSettings();
  assert.equal(await settings().getByLabel('渡し方', { exact: true }).inputValue(), 'text');
  assert.equal(await settings().locator('option[value="mcp"]').evaluate(el => el.disabled), true);
  await page.keyboard.press('Escape');
  await drag('[data-row-id="task-a"] .row-title');
  assert.equal(await page.evaluate(() => fixtureAssignments.at(-1).mode), 'text', 'unavailable desktop MCP falls back to text');
  // Advance a real browser clock to exercise idle scheduling without a minute-long test.
  await page.addInitScript(() => { if (location.search.includes('idle')) Math.random = () => 0; });
  const idleNow = new Date('2026-10-23T00:00:00Z');
  await page.clock.install({ time: idleNow });
  await page.clock.pauseAt(idleNow);
  for (const desktop of [false, true]) for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('https://mascot.test/?idle' + (desktop ? '&desktop' : ''));
    await page.clock.runFor(2000);
    await row().waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, width === 390 ? 'white' : 'black');
    await page.mouse.move(width - 10, 10);
    await page.evaluate(() => {
      document.activeElement?.blur();
      fixtureStore.setText('task-a', '長いタスク名とても大事な作業の内容を確認して最後まで進める'.repeat(12));
    });
    assert.equal(await page.locator('.mascot-idle-thought').count(), 0);
    await page.clock.runFor(28_100);
    const idle = page.locator('.mascot-idle-thought');
    await idle.waitFor();
    assert.match(await idle.innerText(), /いつやるのかな/);
    const layout = await idle.evaluate(el => {
      const title = el.querySelector('.mascot-thought-title');
      const r = el.getBoundingClientRect();
      return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0,
        x: r.x, y: r.y, right: r.right, viewport: innerWidth, desktop: true, height: r.height, overflow: el.scrollWidth > el.clientWidth + 1,
        clamped: title.scrollHeight > title.clientHeight, lines: title.clientHeight / 20 };
    });
    assert.ok(layout.inside, JSON.stringify(layout));
    assert.ok(layout.clamped && layout.lines <= 2 && layout.height <= 84, JSON.stringify(layout));
    assert.equal(layout.overflow, false);
    if (width === 1280 || width === 320) await page.screenshot({ path: '/private/tmp/bizencore-idle-' + desktop + '-' + width + '.png' });
    await idle.focus();
    await page.clock.runFor(6000);
    assert.equal(await idle.count(), 1, 'focused bubble stays available for keyboard activation');
    if (width === 390) await idle.click();
    else await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('textbox', { name: 'タスク', exact: true }).inputValue(), '長いタスク名とても大事な作業の内容を確認して最後まで進める'.repeat(12));
    await page.clock.runFor(60_000);
    assert.equal(await idle.count(), 0, 'inspector suppresses idle thoughts');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
    await mascot().hover();
    await page.clock.runFor(60_000);
    assert.equal(await idle.count(), 0, 'agent tooltip takes precedence');
    await page.getByRole('tooltip').waitFor();
    await page.mouse.move(width - 10, 10);
    await row().getByRole('textbox', { name: 'タスク', exact: true }).focus();
    await page.clock.runFor(60_000);
    assert.equal(await idle.count(), 0, 'typing suppresses idle thoughts');
    await page.evaluate(() => document.activeElement?.blur());
    for (let tick = 0; tick < 14 && !await idle.count(); tick++) await page.clock.runFor(2500);
    await idle.waitFor();
    await page.evaluate(() => {
      for (const item of Object.values(fixtureStore.getState().items)) fixtureStore.update(item.id, { deletedAt: Date.now() });
    });
    assert.equal(await idle.count(), 0, 'deleted tasks disappear immediately from a visible thought');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('Passed: shared App mascot, mouse/touch drag/drop/escape/miss, no immediate web handoff or task mutation, agent settings/persistence, consult/execute prompts, four existing targets, Web/app links, clipboard failure and stale results, sign-out/account changes/deleted tasks, count page, three themes and mobile widths. Idle thoughts: Web/desktop, 3-line name clipping, click/keyboard navigation, dark/light mobile widths, hover/inspector/input suppression and deleted tasks. No external services called.');
} finally { await browser.close(); }
