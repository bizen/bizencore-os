import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskInspector } from './src/components/task/TaskInspector';
    import { applyTheme } from './src/lib/theme';
    applyTheme('black');
    globalThis.fixtureAuth = { isSignedIn: true, userId: 'user-a', sessionClaims: { aud: 'convex' },
      getToken: async () => globalThis.holdToken ? new Promise(resolve => { globalThis.releaseToken = resolve; }) : 'fixture-token' };
    globalThis.uploaded = [];
    function Fixture() {
      const [taskId, setTaskId] = useState('task-a');
      const [attachments, setAttachments] = useState([]);
      const [visible, setVisible] = useState(true);
      const [, render] = useState(0);
      globalThis.fixtureCount = count => setAttachments(Array.from({ length: count }, (_, index) => ({
        id: 'seed-' + index, kind: 'link', url: 'https://example.test/' + index, by: 'human', createdAt: 1 })));
      globalThis.fixtureSyncFile = id => setAttachments(previous => [...previous, {
        id, kind: 'file', title: 'first.txt', storageId: 'storage-1', by: 'human', createdAt: 2 }]);
      globalThis.fixtureTask = id => { setTaskId(id); setAttachments([]); };
      globalThis.fixtureAccount = (userId, isSignedIn = true) => {
        globalThis.fixtureAuth = { ...globalThis.fixtureAuth, userId, isSignedIn }; render(value => value + 1);
      };
      globalThis.fixtureClose = () => setVisible(false);
      const item = { id: taskId, type: 'task', text: '複数の資料を添付する', done: false, order: 0,
        parentId: null, createdAt: 1, updatedAt: 1, attachments };
      const noop = () => {};
      return visible ? <TaskInspector item={item} items={{ [taskId]: item }} initialFocus="title" todayDate="2026-10-07"
        onClose={() => setVisible(false)} onTextChange={noop} onNoteChange={noop} onCompletionCriteriaChange={noop}
        onSetDeadline={noop} onToggleToday={noop} onSetLocked={noop} onSetEstimate={noop} onSetKind={noop}
        onRemove={noop} onRemoveAttachment={noop} onAddAttachment={(id, input) => {
          if (input.title === 'local-only.txt') return false;
          if (attachments.some(attachment => attachment.id === input.id)) return true;
          if (attachments.length >= 50) return false;
          globalThis.uploaded.push({ taskId: id, ...input });
          setAttachments(previous => [...previous, { ...input, kind: 'file', by: 'human', createdAt: 2 }]);
          return true;
        }} /> : null;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({
    VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture',
  }) },
  plugins: [{ name: 'isolated-auth-and-storage', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'convex/react'
      ? 'export const useQuery = () => undefined;'
      : 'export const useAuth = () => globalThis.fixtureAuth; export const SignedIn = ({ children }) => globalThis.fixtureAuth.isSignedIn ? children : null; export const SignedOut = ({ children }) => globalThis.fixtureAuth.isSignedIn ? null : children;',
    loader: 'js' }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const script = outputFiles[0].text.replaceAll('</script', '<\\/script');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const requests = [];
  const external = [];
  let holdNext = false, release, concurrent = 0, maxConcurrent = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.url() === 'https://fixture.convex.site/files/upload') {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const name = decodeURIComponent(request.headers()['x-file-name']);
      requests.push({ name, taskId: request.headers()['x-task-id'], type: request.headers()['content-type'], size: request.postDataBuffer()?.length });
      try {
        if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
        if (name === 'network.txt') return await route.abort();
        if (name.startsWith('failed-')) return await route.fulfill({ status: 500, json: { error: 'テスト用の通信エラー' } });
        if (name === 'malformed.txt') return await route.fulfill({ json: { id: 123 } });
        return await route.fulfill({ json: { id: 'file-' + requests.length, storageId: 'storage-' + requests.length } });
      } finally { concurrent--; }
    }
    if (request.url().startsWith('https://files.test/')) return route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${script}</script>` });
    external.push(request.url()); return route.abort();
  });
  const input = () => page.getByLabel('ファイルを選ぶ', { exact: true });
  const button = () => page.locator('.context-upload-btn');
  const file = (name, mimeType = 'text/plain', buffer = Buffer.from('synthetic file')) => ({ name, mimeType, buffer });
  const fresh = async () => {
    assert.equal(concurrent, 0);
    requests.length = 0;
    await page.goto('https://files.test/');
    await input().waitFor({ state: 'attached' });
  };
  const finished = () => page.waitForFunction(() => document.querySelector('.context-upload-btn')?.getAttribute('aria-busy') === 'false');
  const waitForHeld = async () => {
    for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(release, 'request reached the isolated upload fixture');
  };
  const releaseRequest = () => { release(); release = undefined; };

  await fresh();
  const chooserPromise = page.waitForEvent('filechooser');
  await button().click();
  const chooser = await chooserPromise;
  assert.equal(chooser.isMultiple(), true);
  holdNext = true;
  await chooser.setFiles([file('one.txt'), file('two.pdf', 'application/pdf'), file('three.png', 'image/png')]);
  await waitForHeld();
  assert.equal(await button().getAttribute('aria-busy'), 'true');
  assert.equal(await button().isDisabled(), true);
  assert.equal(await input().isDisabled(), true);
  assert.match(await button().innerText(), /1\/3/);
  assert.equal(requests.length, 1, 'only one file in flight');
  releaseRequest();
  await finished();
  assert.deepEqual(requests.map(request => request.name), ['one.txt', 'two.pdf', 'three.png']);
  assert.equal(maxConcurrent, 1);
  assert.equal(await page.locator('.context-item--file').count(), 3);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(requests.map(request => request.type), ['text/plain', 'application/pdf', 'image/png']);
  assert.equal(await input().inputValue(), '');
  await input().setInputFiles([file('one.txt')]);
  await finished();
  assert.equal(requests.length, 4, 'the same file can be selected again after the batch');

  await fresh();
  const failedName = 'failed-' + 'long-file-name-'.repeat(10) + '.pdf';
  await input().setInputFiles([file('empty.txt', 'text/plain', Buffer.alloc(0)),
    file('oversized.bin', 'application/octet-stream', Buffer.alloc(10 * 1024 * 1024 + 1)),
    file(failedName), file('network.txt'), file('malformed.txt'), file('local-only.txt'), file('last.txt')]);
  await finished();
  assert.deepEqual(requests.map(request => request.name), [failedName, 'network.txt', 'malformed.txt', 'local-only.txt', 'last.txt']);
  const failureText = await page.getByRole('alert').innerText();
  for (const name of ['empty.txt', 'oversized.bin', failedName, 'network.txt', 'malformed.txt', 'local-only.txt']) assert.ok(failureText.includes(name));
  assert.match(failureText, /アップロード済み/);
  assert.ok(!failureText.includes('last.txt'));
  assert.deepEqual(await page.evaluate(() => uploaded.map(file => file.title)), ['last.txt']);
  for (const theme of ['black', 'white', 'original']) for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByRole('alert').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.context-upload').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long filenames wrap');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
    if (theme === 'black') await page.screenshot({ path: `/private/tmp/bizencore-multi-files-${width}.png` });
  }

  await fresh();
  await input().setInputFiles([file('boundary.bin', '', Buffer.alloc(10 * 1024 * 1024))]);
  await finished();
  assert.equal(requests[0].size, 10 * 1024 * 1024);
  assert.equal(requests[0].type, 'application/octet-stream');
  assert.equal(await page.getByRole('alert').count(), 0);

  await fresh();
  await page.evaluate(() => fixtureCount(49));
  await input().setInputFiles([file('fiftieth.txt'), file('extra-one.txt'), file('extra-two.txt')]);
  await finished();
  assert.deepEqual(requests.map(request => request.name), ['fiftieth.txt']);
  assert.match(await page.getByRole('alert').innerText(), /残り2件.*50件/);
  assert.equal(await button().isDisabled(), true);

  await fresh();
  await page.evaluate(() => fixtureCount(48));
  holdNext = true;
  await input().setInputFiles([file('first.txt'), file('second.txt'), file('third.txt')]);
  await waitForHeld();
  await page.evaluate(() => fixtureCount(49));
  releaseRequest();
  await finished();
  assert.equal(requests.length, 1, 'account sync adding another attachment reduces the remaining capacity');

  await fresh();
  await page.evaluate(() => fixtureCount(48));
  holdNext = true;
  await input().setInputFiles([file('first.txt'), file('second.txt'), file('third.txt')]);
  await waitForHeld();
  await page.evaluate(() => fixtureSyncFile('file-1'));
  releaseRequest();
  await finished();
  assert.deepEqual(requests.map(request => request.name), ['first.txt', 'second.txt'], 'early sync delivery counts the same file only once');
  assert.match(await page.getByRole('alert').innerText(), /残り1件/);
  assert.ok(!(await page.getByRole('alert').innerText()).includes('端末に反映できません'));

  await fresh();
  holdNext = true;
  await input().setInputFiles([file('old-task.txt'), file('must-not-upload.txt')]);
  await waitForHeld();
  await page.evaluate(() => fixtureTask('task-b'));
  releaseRequest();
  await finished();
  await page.waitForTimeout(100);
  assert.equal(requests.length, 1);
  assert.deepEqual(await page.evaluate(() => uploaded), []);
  await input().setInputFiles([file('new-task.txt')]);
  await finished();
  assert.equal(requests[1].taskId, 'task-b');
  assert.deepEqual(await page.evaluate(() => uploaded.map(file => file.taskId)), ['task-b']);

  await fresh();
  await page.evaluate(() => { globalThis.holdToken = true; });
  await input().setInputFiles([file('account-a.txt'), file('account-b.txt')]);
  await page.waitForFunction(() => Boolean(globalThis.releaseToken));
  await page.evaluate(() => fixtureAccount('user-b'));
  await page.evaluate(() => releaseToken('fixture-token'));
  await finished();
  assert.equal(requests.length, 0, 'account change during auth cannot start an upload');
  assert.deepEqual(await page.evaluate(() => uploaded), []);
  await page.evaluate(() => fixtureAccount(null, false));
  assert.equal(await button().isDisabled(), true);

  await fresh();
  holdNext = true;
  await input().setInputFiles([file('account-a.txt'), file('must-not-upload.txt')]);
  await waitForHeld();
  await page.evaluate(() => fixtureAccount('user-b'));
  releaseRequest();
  await finished();
  assert.equal(requests.length, 1, 'account change during a request stops the rest of the batch');
  assert.deepEqual(await page.evaluate(() => uploaded), []);

  await fresh();
  holdNext = true;
  await input().setInputFiles([file('closed-panel.txt'), file('queued.txt')]);
  await waitForHeld();
  await page.evaluate(() => fixtureClose());
  releaseRequest();
  await page.waitForTimeout(100);
  assert.equal(requests.length, 1, 'closing the panel stops queued uploads');
  assert.deepEqual(await page.evaluate(() => uploaded), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Passed: native multi-file chooser, sequential uploads, progress, same-file reselection, partial failures, empty/10 MB limits, attachment cap and live sync capacity, task/account switch and unmount safety, error wrapping in 3 themes at 390/320/1280px; isolated auth and upload endpoints only.');
} finally { await browser.close(); }
