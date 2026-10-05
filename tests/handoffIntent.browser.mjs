import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskInspector } from './src/components/task/TaskInspector';
    import { Picker } from './mcp-app/Picker';
    const noop = () => {};
    const seed = { order: 0, done: false, createdAt: 1, updatedAt: 1 };
    const label = { ...seed, id: 'label', type: 'section', parentId: null, text: 'OSビルド' };
    const task = { ...seed, id: 'task-a', type: 'task', parentId: 'label', text: 'ハンドオフ機能の改善', note: 'Private snapshot note' };
    const child = { ...seed, id: 'task-b', type: 'task', parentId: 'task-a', text: '子タスクの確認' };
    const longTask = { ...task, id: 'task-long', text: '長いメモ', note: 'Private snapshot note ' + '日本語'.repeat(5000) };
    const items = { label, 'task-a': task, 'task-b': child, 'task-long': longTask };
    const detail = id => ({ ...items[id], completion_criteria: '選んだ意図をAIに渡せる', subtasks: id === 'task-a' ? [child] : [] });
    const client = {
      connect: async () => {},
      page: async () => ({ items: Object.values(items), today_date: '2026-10-05' }),
      detail: async id => { if (globalThis.failDetail) throw new Error('読み取り失敗'); return detail(id); },
      send: async text => { if (globalThis.failSend) throw new Error('送信失敗'); globalThis.fixtureSent.push(text); },
      open: async url => { globalThis.fixtureLinks.push(url); },
    };
    globalThis.fixtureSent = [];
    globalThis.fixtureLinks = [];
    function WebFixture() {
      const [id, setId] = useState('task-a');
      globalThis.fixtureSelectTask = setId;
      return <TaskInspector item={items[id]} items={items} initialFocus="title" todayDate="2026-10-05"
        onClose={() => { globalThis.fixtureCloseCount = (globalThis.fixtureCloseCount || 0) + 1; }} onTextChange={noop} onNoteChange={noop} onCompletionCriteriaChange={noop}
        onSetDeadline={noop} onToggleToday={noop} onSetLocked={noop} onSetEstimate={noop} onSetKind={noop}
        onRemove={noop} onAddAttachment={() => true} onRemoveAttachment={noop} />;
    }
    createRoot(document.getElementById('root')).render(location.pathname === '/app' ? <Picker client={client} /> : <WebFixture />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-auth', setup(builder) {
    builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      const signedOut = new URLSearchParams(location.search).has('signedOut');
      export const SignedIn = ({ children }) => signedOut ? null : children;
      export const SignedOut = ({ children }) => signedOut ? children : null;
      export const useAuth = () => ({ isSignedIn: !signedOut, getToken: async () => null });
    `, loader: 'js' }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const pickerCss = await readFile('mcp-app/style.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('bizencore.theme', new URLSearchParams(location.search).get('theme') || 'black');
    if (new URLSearchParams(location.search).has('resetPreferences')) localStorage.removeItem('bizencore.aiHandoff');
    globalThis.fixtureCopies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { globalThis.fixtureCopies.push(value); } } });
    window.open = url => { globalThis.fixtureLinks.push(url); return null; };
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (link && /^(claude|codex):/.test(link.href)) {
        event.preventDefault();
        globalThis.fixtureLinks.push(link.href);
      }
    });
  });
  await page.route('**/*', route => route.request().url().startsWith('https://bizencore.test/')
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}\n${pickerCss}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` })
    : route.abort());
  const verifyPrompt = (prompt, intent, mcp) => {
    assert.match(prompt, intent === 'consult' ? /explicitly selected "検討する"/ : /explicitly selected "実行する"/);
    assert.match(prompt, /Do not ask whether they want consultation or execution again/);
    assert.doesNotMatch(prompt, /Then ask one focused question/);
    if (mcp) { assert.match(prompt, /task_id "task-a"/); assert.doesNotMatch(prompt, /Private snapshot note/); }
    else { assert.match(prompt, /Private snapshot note/); assert.match(prompt, /自動反映はできません/); }
  };
  const copyCommand = async (target, intent, mcp) => {
    const count = await page.evaluate(() => globalThis.fixtureCopies.length);
    await page.getByRole('button', { name: target, exact: true }).click();
    await page.waitForFunction(count => globalThis.fixtureCopies.length === count + 1, count);
    const command = await page.evaluate(() => globalThis.fixtureCopies.at(-1));
    assert.ok(command.startsWith(target === 'Codex' ? 'codex ' : 'claude '));
    verifyPrompt(command, intent, mcp);
  };
  const settings = () => page.getByRole('button', { name: 'AIハンドオフの接続設定', exact: true });
  const openSettings = async () => {
    if (await settings().getAttribute('aria-expanded') === 'false') await settings().click();
  };
  const closeSettings = async () => {
    if (await settings().getAttribute('aria-expanded') === 'true') await settings().click();
  };
  const chooseConnection = async (name) => {
    await openSettings();
    await page.getByRole('button', { name, exact: true }).click();
    await checkFits();
    await closeSettings();
  };
  const checkFits = async () => {
    const fits = await page.locator('.inspector-handoff-mode').evaluateAll(elements => elements.every(el => {
      const rect = el.getBoundingClientRect();
      return rect.x >= 0 && rect.right <= innerWidth + 1 && [...el.querySelectorAll('button')].every(button => button.scrollWidth <= button.clientWidth + 1);
    }));
    assert.equal(fits, true);
  };
  for (const theme of ['black', 'white', 'original']) {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('https://bizencore.test/web?resetPreferences');
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.getByRole('button', { name: '検討する', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await settings().getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('group', { name: 'AIへの渡し方' }).count(), 0);
      assert.equal(await page.getByRole('group', { name: 'Claude・ChatGPTの開く先' }).count(), 0);
      assert.equal(await page.locator('.inspector-handoff .inspector-hint').count(), 0);
      assert.equal(await page.locator('.inspector-handoff .inspector-ai-btn').count(), 4);
      assert.match(await page.getByLabel('現在のハンドオフ設定').innerText(), /MCPで引き継ぎ.*Web/s);
      for (const mcp of [true, false]) {
        await chooseConnection(mcp ? 'MCPで進める' : '内容だけ渡す');
        for (const intent of ['consult', 'execute']) {
          await page.getByRole('button', { name: intent === 'consult' ? '検討する' : '実行する', exact: true }).click();
          await checkFits();
          await copyCommand('Codex', intent, mcp);
          await copyCommand('Claude Code', intent, mcp);
          if (mcp) {
            for (const target of ['Claude', 'ChatGPT']) {
              const url = await page.getByRole('link', { name: target, exact: true }).getAttribute('href');
              verifyPrompt(new URL(url).searchParams.get('q'), intent, true);
            }
          } else {
            const count = await page.evaluate(() => globalThis.fixtureCopies.length);
            await page.getByRole('button', { name: 'ChatGPT', exact: true }).click();
            await page.waitForFunction(count => globalThis.fixtureCopies.length === count + 1, count);
            verifyPrompt(await page.evaluate(() => globalThis.fixtureCopies.at(-1)), intent, false);
            assert.match(await page.evaluate(() => globalThis.fixtureLinks.at(-1)), /chatgpt\.com/);
          }
          await chooseConnection('アプリ');
          await checkFits();
          for (const target of ['Claude', 'ChatGPT']) {
            const link = page.getByRole('link', { name: target, exact: true });
            const url = new URL(await link.getAttribute('href'));
            assert.equal(url.protocol, target === 'Claude' ? 'claude:' : 'codex:');
            verifyPrompt(url.searchParams.get(target === 'Claude' ? 'q' : 'prompt'), intent, mcp);
            assert.equal(await link.getAttribute('target'), null);
            const count = await page.evaluate(() => globalThis.fixtureLinks.length);
            await link.click();
            await page.waitForFunction(count => globalThis.fixtureLinks.length === count + 1, count);
            const opened = new URL(await page.evaluate(() => globalThis.fixtureLinks.at(-1)));
            assert.equal(opened.protocol, url.protocol);
            assert.equal(opened.searchParams.get(target === 'Claude' ? 'q' : 'prompt'), url.searchParams.get(target === 'Claude' ? 'q' : 'prompt'));
          }
          await copyCommand('Codex', intent, mcp);
          await copyCommand('Claude Code', intent, mcp);
          await chooseConnection('Web');
        }
      }
      if (theme === 'black' && width === 390) {
        await chooseConnection('MCPで進める');
        await chooseConnection('アプリ');
        await page.screenshot({ path: '/private/tmp/bizencore-handoff-web-mobile.png', fullPage: true, animations: 'disabled' });
        await page.locator('.inspector-handoff').screenshot({ path: '/private/tmp/bizencore-handoff-compact.png', animations: 'disabled' });
        await openSettings();
        await page.locator('.inspector-handoff').screenshot({ path: '/private/tmp/bizencore-handoff-settings.png', animations: 'disabled' });
        await closeSettings();
      }
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bizencore.aiHandoff')));
      await page.evaluate(() => globalThis.fixtureSelectTask('task-b'));
      await page.waitForFunction(() => document.querySelector('.inspector-title').value === '子タスクの確認');
      assert.equal(await page.getByRole('button', { name: '検討する', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await settings().getAttribute('aria-expanded'), 'false');
      await openSettings();
      assert.equal(await page.getByRole('button', { name: saved.destination === 'desktop' ? 'アプリ' : 'Web', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('button', { name: saved.mode === 'mcp' ? 'MCPで進める' : '内容だけ渡す', exact: true }).getAttribute('aria-pressed'), 'true');
      await closeSettings();

      await page.goto('https://bizencore.test/app?theme=' + theme);
      await page.getByRole('button', { name: 'ハンドオフ機能の改善', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      for (const intent of ['consult', 'execute']) {
        await page.getByRole('button', { name: 'ハンドオフ機能の改善', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '検討する', exact: true }).getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: intent === 'consult' ? '検討する' : '実行する', exact: true }).click();
        await checkFits();
        if (theme === 'black' && width === 390 && intent === 'execute') await page.screenshot({ path: '/private/tmp/bizencore-handoff-app-mobile.png', fullPage: true, animations: 'disabled' });
        const count = await page.evaluate(() => globalThis.fixtureSent.length);
        await page.getByRole('button', { name: intent === 'consult' ? '検討を始める' : '実行を始める', exact: true }).click();
        await page.waitForFunction(count => globalThis.fixtureSent.length === count + 1, count);
        verifyPrompt(await page.evaluate(() => globalThis.fixtureSent.at(-1)), intent, true);
      }
    }
  }
  await page.goto('https://bizencore.test/web?signedOut');
  await openSettings();
  assert.equal(await page.getByRole('button', { name: 'MCPで進める', exact: true }).isDisabled(), true);
  assert.match(await page.getByRole('status').innerText(), /サインインが必要/);
  await closeSettings();
  await copyCommand('Codex', 'consult', false);
  await page.evaluate(() => globalThis.fixtureSelectTask('task-long'));
  await chooseConnection('アプリ');
  for (const target of ['Claude', 'ChatGPT']) {
    const link = page.getByRole('link', { name: target, exact: true });
    assert.equal(new URL(await link.getAttribute('href')).searchParams.get(target === 'Claude' ? 'q' : 'prompt'), '');
    const count = await page.evaluate(() => globalThis.fixtureCopies.length);
    await link.click();
    await page.waitForFunction(count => globalThis.fixtureCopies.length === count + 1, count);
    const prompt = await page.evaluate(() => globalThis.fixtureCopies.at(-1));
    assert.ok(prompt.includes('日本語'.repeat(5000)));
    assert.match(prompt, /explicitly selected "検討する"/);
  }

  await page.goto('https://bizencore.test/web');
  assert.equal(await settings().getAttribute('aria-expanded'), 'false');
  await openSettings();
  assert.equal(await page.getByRole('button', { name: 'アプリ', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '内容だけ渡す', exact: true }).click();
  await page.getByRole('button', { name: 'アプリ', exact: true }).press('Escape');
  assert.equal(await settings().getAttribute('aria-expanded'), 'false');
  assert.equal(await settings().evaluate(button => document.activeElement === button), true);
  assert.equal(await page.evaluate(() => globalThis.fixtureCloseCount || 0), 0);
  await page.getByRole('button', { name: '実行する', exact: true }).click();
  await page.reload();
  assert.equal(await page.getByRole('button', { name: '検討する', exact: true }).getAttribute('aria-pressed'), 'true');
  await openSettings();
  assert.equal(await page.getByRole('button', { name: '内容だけ渡す', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'アプリ', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'MCPで進める', exact: true }).click();
  await page.goto('https://bizencore.test/web?signedOut');
  assert.match(await page.getByLabel('現在のハンドオフ設定').innerText(), /内容のみ/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bizencore.aiHandoff')).mode), 'mcp');
  await page.goto('https://bizencore.test/web');
  assert.match(await page.getByLabel('現在のハンドオフ設定').innerText(), /MCPで引き継ぎ/);

  await page.goto('https://bizencore.test/app');
  await page.evaluate(() => { globalThis.failDetail = true; });
  await page.getByRole('button', { name: 'ハンドオフ機能の改善', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '読み取り失敗' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '検討を始める', exact: true }).isDisabled(), true);
  await page.evaluate(() => { globalThis.failDetail = false; });
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await page.getByRole('button', { name: '実行する', exact: true }).click();
  await page.evaluate(() => { globalThis.failSend = true; });
  await page.getByRole('button', { name: '実行を始める', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '送信失敗' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '実行する', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => globalThis.fixtureSent.length), 0);
  await page.evaluate(() => { globalThis.failSend = false; });
  await page.getByRole('button', { name: '実行を始める', exact: true }).click();
  await page.waitForFunction(() => globalThis.fixtureSent.length === 1);
  verifyPrompt(await page.evaluate(() => globalThis.fixtureSent[0]), 'execute', true);
  assert.deepEqual(errors, []);
  console.log('Passed: compact inspector and MCP Apps picker, 3 themes at 1280/390/320, all handoff combinations, settings disclosure/Escape/focus, preferences across tasks/reload/sign-in, commands/links/copy, long-prompt fallback, Apps messages, failed reads/sends and retry.');
} finally {
  await browser.close();
}
