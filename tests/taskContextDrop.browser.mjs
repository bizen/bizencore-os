import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import { TasksPage } from './src/pages/TasksPage';
    import { taskStore } from './src/lib/taskStore';
    import { applyTheme } from './src/lib/theme';
    applyTheme('black');
    globalThis.fixtureAuth = { userId: 'account-a', isSignedIn: true, sessionClaims: { aud: 'convex' },
      getToken: async () => globalThis.holdToken ? new Promise(resolve => globalThis.releaseToken = resolve) : 'fixture-token' };
    const rows = [
      { id: 'label', type: 'section', parentId: null, order: 0, text: '資料' },
      { id: 'task-a', type: 'task', parentId: 'label', order: 0, text: 'デザインを確認する' },
      { id: 'child', type: 'task', parentId: 'task-a', order: 0, text: '参考資料を読む' },
      { id: 'task-b', type: 'task', parentId: 'label', order: 1, text: '実装する', locked: true },
    ];
    taskStore.mergeRemote(rows.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify({ done: false, createdAt: 1, updatedAt: 1, ...item }) })));
    globalThis.fixtureStore = taskStore;
    function Fixture() {
      const [, render] = useState(0); const [visible, show] = useState(true);
      globalThis.fixtureAccount = (userId, signedIn = true) => { globalThis.fixtureAuth = { ...globalThis.fixtureAuth, userId, isSignedIn: signedIn }; render(value => value + 1); };
      globalThis.fixtureClose = () => show(false);
      globalThis.fixtureCount = count => { for (let i = 0; i < count; i++) taskStore.addAttachment('task-a', { text: '資料 ' + i }); };
      return visible ? <div className="app-shell"><header className="app-header"><span className="brand">bizen<em>core</em> terminal</span></header>
        <main className="app-main" id="task-scroll-content"><MemoryRouter><TasksPage /></MemoryRouter></main></div> : null;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-auth-storage', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'convex/react'
      ? 'export const useQuery = () => undefined; export const useMutation = () => async () => {}; export const useAction = () => async () => {};'
      : 'export const useAuth = () => globalThis.fixtureAuth; export const SignedIn = ({ children }) => globalThis.fixtureAuth.isSignedIn ? children : null; export const SignedOut = ({ children }) => globalThis.fixtureAuth.isSignedIn ? null : children;', loader: 'js' }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => { if (!location.search.includes('retain')) localStorage.clear(); });
  const errors = [], external = [], requests = [];
  let holdNext = false, release, concurrent = 0, maxConcurrent = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.url() === 'https://fixture.convex.site/files/upload') {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      const name = decodeURIComponent(request.headers()['x-file-name']);
      requests.push({ name, taskId: request.headers()['x-task-id'], type: request.headers()['content-type'] });
      try {
        if (holdNext) { holdNext = false; await new Promise(resolve => release = resolve); }
        if (name === 'network.txt') return await route.abort();
        if (name.startsWith('failed-')) return await route.fulfill({ status: 500, json: { error: 'テスト用の通信エラー' } });
        return await route.fulfill({ json: { id: 'file-' + requests.length, storageId: 'storage-' + requests.length } });
      } finally { concurrent--; }
    }
    if (request.url().startsWith('https://drop.test/')) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` });
    external.push(request.url()); return route.abort();
  });
  const row = (id = 'task-a') => page.locator('[data-row-id="' + id + '"]');
  const snapshot = id => page.evaluate(id => fixtureStore.getState().items[id], id);
  const drop = async (selector, values = {}, files = [], event = 'drop') => {
    const transfer = await page.evaluateHandle(({ values, files }) => {
      const data = new DataTransfer();
      for (const [type, text] of Object.entries(values)) data.setData(type, text);
      for (const file of files) data.items.add(new File([new Uint8Array(file.size ?? 12)], file.name, { type: file.type ?? 'text/plain' }));
      return data;
    }, { values, files });
    await page.dispatchEvent(selector, event, { dataTransfer: transfer }); await transfer.dispose();
  };
  const target = id => '[data-row-id="' + id + '"]';
  const fresh = async () => { assert.equal(concurrent, 0); requests.length = 0; await page.goto('https://drop.test/'); await row().waitFor(); };
  const finished = () => page.waitForFunction(() => document.querySelector('.task-drop-status')?.getAttribute('aria-busy') === 'false');
  const held = async () => { for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(release); };
  const unblock = () => { release(); release = undefined; };

  await fresh();
  await drop(target('task-a') + ' textarea.row-title', { 'text/uri-list': 'https://example.test/design' }, [], 'dragover');
  assert.equal(await row().evaluate(el => el.classList.contains('is-context-drop-target')), true);
  await page.screenshot({ path: '/private/tmp/bizencore-context-drop-hover.png' });
  await drop(target('task-a') + ' textarea.row-title', { 'text/uri-list': 'https://example.test/design' });
  assert.equal(await row().evaluate(el => el.classList.contains('is-context-drop-target')), false);
  assert.equal((await snapshot('task-a')).text, 'デザインを確認する', 'drop over editable title never pastes into its text');
  assert.equal((await snapshot('task-a')).attachments[0].url, 'https://example.test/design');
  assert.ok(!(await snapshot('task-b')).attachments);
  await drop(target('task-a'), { 'text/plain': 'https://example.test/design' });
  assert.equal((await snapshot('task-a')).attachments.length, 1, 'repeated link drops do not duplicate');
  await drop(target('child'), { 'text/plain': 'https://example.test/child' });
  assert.equal((await snapshot('child')).attachments.length, 1);
  await drop(target('label'), { 'text/uri-list': 'https://example.test/not-a-task' });
  assert.ok(!(await snapshot('label')).attachments, 'labels are not attachment targets');
  await drop('body', { 'text/uri-list': 'https://example.test/missed' });
  assert.equal(page.url(), 'https://drop.test/', 'missed link does not navigate');
  const title = await row().locator('.row-title').inputValue();
  await row().locator('.row-title').dispatchEvent('dragstart');
  await drop(target('task-a') + ' textarea.row-title', { 'text/plain': 'https://example.test/internal' });
  await row().locator('.row-title').dispatchEvent('dragend');
  assert.equal((await snapshot('task-a')).attachments.length, 1, 'native text dragging within the app is not hijacked');
  assert.equal(await row().locator('.row-title').inputValue(), title);

  for (const view of ['board', 'today', 'all']) {
    if (view === 'today') await page.evaluate(() => fixtureStore.toggleToday('task-a', new Date().toLocaleDateString('en-CA')));
    await page.getByRole('tab', { name: view === 'today' ? /^today/ : view, exact: view !== 'today' }).click();
    await drop(target('task-a'), { 'text/plain': 'https://example.test/' + view });
    assert.ok((await snapshot('task-a')).attachments.some(att => att.url === 'https://example.test/' + view));
  }
  await page.getByRole('button', { name: 'フォーカスに追加', exact: true }).click();
  await page.getByRole('tab', { name: /^資料/ }).click();
  await drop(target('task-a'), { 'text/plain': 'https://example.test/focus' });
  await row().locator('.meta-inspect').click();
  assert.equal(await page.locator('.context-item--link').count(), 5);
  await page.screenshot({ path: '/private/tmp/bizencore-context-drop-attached.png' });
  await page.getByRole('button', { name: '閉じる（Esc）', exact: true }).click();
  await page.goto('https://drop.test/?retain'); await row().waitFor();
  assert.equal((await snapshot('task-a')).attachments.length, 5, 'attachments survive reload');

  await fresh();
  holdNext = true;
  await drop(target('task-b'), { 'text/uri-list': 'https://example.test/ignored' }, [{ name: 'screen.png', type: 'image/png' }, { name: 'brief.pdf', type: 'application/pdf' }]);
  await held();
  assert.equal(requests.length, 1); assert.match(await page.locator('.task-drop-status').innerText(), /1\/2/);
  await drop(target('task-a'), {}, [{ name: 'competing.txt' }]);
  assert.equal(requests.length, 1, 'another drop cannot launch a competing batch');
  unblock(); await finished();
  assert.deepEqual(requests.map(file => file.name), ['screen.png', 'brief.pdf']);
  assert.equal(maxConcurrent, 1);
  assert.equal((await snapshot('task-b')).attachments.length, 2, 'locked containers can carry context');
  assert.ok((await snapshot('task-b')).attachments.every(file => file.kind === 'file'));

  await fresh();
  const failedName = 'failed-' + 'long-file-name-'.repeat(12) + '.pdf';
  await drop(target('task-a'), {}, [{ name: 'empty.txt', size: 0 }, { name: 'oversized.bin', size: 10 * 1024 * 1024 + 1 }, { name: failedName }, { name: 'network.txt' }, { name: 'valid.txt' }]);
  await finished();
  assert.deepEqual(requests.map(file => file.name), [failedName, 'network.txt', 'valid.txt']);
  const alert = await page.getByRole('alert').innerText();
  for (const name of ['empty.txt', 'oversized.bin', failedName, 'network.txt']) assert.ok(alert.includes(name));
  assert.equal((await snapshot('task-a')).attachments.length, 1);
  for (const theme of ['black', 'white', 'original']) for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.ok(await page.locator('.task-drop-status').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }

  await fresh();
  await page.evaluate(() => fixtureCount(49));
  await drop(target('task-a'), { 'text/uri-list': 'https://example.test/one\nhttps://example.test/two' });
  assert.equal((await snapshot('task-a')).attachments.length, 50);
  assert.match(await page.getByRole('alert').innerText(), /50件/);
  await fresh();
  await page.evaluate(() => fixtureCount(49));
  await drop(target('task-a'), {}, [{ name: 'one.txt' }, { name: 'two.txt' }]); await finished();
  assert.equal(requests.length, 1); assert.match(await page.getByRole('alert').innerText(), /残り1件/);

  await fresh();
  await page.evaluate(() => fixtureAccount(null, false));
  await drop(target('task-a'), {}, [{ name: 'signed-out.txt' }]);
  assert.equal(requests.length, 0); assert.match(await page.getByRole('alert').innerText(), /サインイン/);
  await drop(target('task-a'), { 'text/plain': 'javascript:alert(1)' });
  assert.ok(!(await snapshot('task-a')).attachments);

  await fresh();
  await page.evaluate(() => globalThis.holdToken = true);
  await drop(target('task-a'), {}, [{ name: 'old-account.txt' }]);
  await page.waitForFunction(() => Boolean(globalThis.releaseToken));
  await page.evaluate(() => fixtureAccount('account-b'));
  await page.evaluate(() => releaseToken('fixture-token'));
  await page.waitForTimeout(100);
  assert.equal(requests.length, 0); assert.ok(!(await snapshot('task-a')).attachments);

  await fresh(); holdNext = true;
  await drop(target('task-a'), {}, [{ name: 'removed-task.txt' }, { name: 'queued.txt' }]); await held();
  await page.evaluate(() => fixtureStore.remove('task-a')); unblock();
  await page.waitForTimeout(100);
  assert.equal(requests.length, 1); assert.ok(!(await snapshot('task-a')).attachments);

  await fresh(); holdNext = true;
  await drop(target('task-a'), {}, [{ name: 'closed.txt' }, { name: 'queued.txt' }]); await held();
  await page.evaluate(() => fixtureClose()); unblock(); await page.waitForTimeout(100);
  assert.equal(requests.length, 1); assert.ok(!(await snapshot('task-a')).attachments);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('Passed: task/subtask/locked-container row drops, safe links, no title replacement, duplicate links, All/Board/Today/focus, context panel, sequential multi-files, progress and partial errors, 10 MB / 50 limits, account switch/removal/unmount safety, missed drops, native text drag, three themes and mobile widths; isolated test data only.');
} finally { await browser.close(); }
