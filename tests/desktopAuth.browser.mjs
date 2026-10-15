import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    const fixture = window.__authTest = {
      state: { isLoaded: false, isSignedIn: false, userId: null, sessionId: null },
      listeners: new Set(), calls: [], channels: new Map(), mode: 'success',
      update(next) { this.state = { ...this.state, ...next }; this.listeners.forEach(listener => listener()); },
    };
    const invoke = (command, args) => {
      fixture.calls.push({ command, id: args?.id });
      if (command === 'desktop_authorize') {
        if (fixture.mode === 'reject') throw new Error('Mock rejected auth');
        if (fixture.mode === 'pending') return new Promise(resolve => { fixture.resolve = resolve; });
        return { userId: fixture.state.userId, expiresAt: Math.floor(Date.now() / 1000) + 60 };
      }
      if (command === 'desktop_agents') return [{ id: 'claude', name: 'Claude Code', path: '/mock/claude' }];
      if (command === 'desktop_folder') return '/smoke/project';
      if (command === 'desktop_start') { fixture.channels.set(args.id, args.output); return 1234; }
      if (command === 'desktop_stop') {
        fixture.channels.get(args.id)?.onmessage({ kind: 'exit', code: null });
        fixture.channels.delete(args.id);
      }
      if (command === 'desktop_lock') {
        fixture.channels.forEach(channel => channel.onmessage({ kind: 'exit', code: null }));
        fixture.channels.clear();
      }
    };
    {
      const events = new Set();
      const expiry = new Set();
      fixture.expire = () => expiry.forEach(callback => callback());
      window.bizencoreDesktop = {
        integratedTitlebar: true,
        authorize: async token => invoke('desktop_authorize', { token }),
        lock: async () => invoke('desktop_lock'),
        agents: async () => invoke('desktop_agents'),
        conversations: async () => [{ id: '55555555-5555-4555-8555-555555555555', title: 'Saved CLI session', updatedAt: Date.now() }],
        notify: async value => { fixture.calls.push({ command: 'notify', ...value }); },
        onFocusPane: callback => { fixture.focusPane = callback; return () => { fixture.focusPane = undefined; }; },
        folder: async () => invoke('desktop_folder'),
        start: async args => invoke('desktop_start', { ...args, output: { onmessage: event => events.forEach(callback => callback(args.id, event)) } }),
        stop: async id => invoke('desktop_stop', { id }),
        write: async (id, data) => invoke('desktop_write', { id, data }),
        resize: async (id, cols, rows) => invoke('desktop_resize', { id, cols, rows }),
        onEvent: callback => { events.add(callback); return () => events.delete(callback); },
        onExpired: callback => { expiry.add(callback); return () => expiry.delete(callback); },
      };
    }
    (async () => {
      const { DesktopAuthentication } = await import('./desktop/auth');
      const { DesktopFrame } = await import('./desktop/Frame');
      const { AgentWorkspace } = await import('./desktop/workspace');
      const { useClerk } = await import('@clerk/clerk-react');
      function TaskView() {
        const { signOut } = useClerk();
        return <div><h1>Task workspace</h1><button onClick={() => signOut()}>ログアウト</button></div>;
      }
      createRoot(document.getElementById('root')).render(
        <DesktopFrame><MemoryRouter><DesktopAuthentication><AgentWorkspace><TaskView /></AgentWorkspace></DesktopAuthentication></MemoryRouter></DesktopFrame>
      );
    })();
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [{ name: 'mock-auth-providers', setup(builder) {
    builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'mock-auth' }));
    builder.onResolve({ filter: /\/ConvexClientProvider$/ }, () => ({ path: 'provider', namespace: 'mock-auth' }));
    builder.onResolve({ filter: /\/cloudConfig$/ }, () => ({ path: 'config', namespace: 'mock-auth' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock-auth' }, ({ path }) => ({ resolveDir: process.cwd(), loader: 'tsx', contents:
      path === 'config' ? `export const isCloudConfigured = location.search !== '?missing';` :
      path === 'provider' ? `export function ConvexClientProvider({ children }) { return children; }` : `
        import { useSyncExternalStore } from 'react';
        const getToken = async () => { window.__authTest.calls.push({ command: 'getToken' }); return 'mock-token'; };
        const signOut = async () => window.__authTest.update({ isSignedIn: false, userId: null, sessionId: null });
        export function useAuth() {
          const fixture = window.__authTest;
          const state = useSyncExternalStore(listener => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); }, () => fixture.state);
          return { ...state, getToken };
        }
        export function useClerk() { return { signOut }; }
        export function SignIn() { return <section aria-label="サインイン"><h1>Sign in to bizencore</h1><button onClick={() => window.__authTest.update({ isSignedIn: true, userId: 'first', sessionId: 'session-a' })}>サインイン</button></section>; }
      `,
    }));
  } }],
});
const css = (await readFile('src/index.css', 'utf8')) + (await readFile('desktop/workspace.css', 'utf8')) + (await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8'));
const html = `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const noWorkspace = async () => {
    assert.equal(await page.locator('.desktop-workspace').count(), 0);
    assert.equal(await page.locator('.xterm').count(), 0);
  };
  await page.goto('http://127.0.0.1/?missing');
  await page.getByRole('alert').waitFor();
  await noWorkspace();
  assert.deepEqual(await page.evaluate(() => window.__authTest.calls), []);
  await page.clock.install();
  await page.goto('http://127.0.0.1/');
  await page.getByRole('status').waitFor();
  assert.equal(await page.locator('.desktop-auth .brand-power').textContent(), '2');
  await noWorkspace();
  assert.deepEqual(await page.evaluate(() => window.__authTest.calls), []);
  await page.clock.fastForward(16000);
  await page.getByText('ログインの確認に時間がかかっています。', { exact: false }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'a pending Keychain approval is not falsely declared a failed login');
  await noWorkspace();
  await page.evaluate(() => window.__authTest.update({ isLoaded: true }));
  await page.getByRole('heading', { name: 'Sign in to bizencore' }).waitFor();
  {
    assert.equal(await page.locator('.desktop-titlebar').isVisible(), false);
    assert.equal(await page.locator('.desktop-auth > header').evaluate(element => getComputedStyle(element).webkitAppRegion), 'drag');
    assert.ok(await page.locator('.desktop-auth .brand').evaluate(element => element.getBoundingClientRect().left >= 96));
    assert.ok(await page.locator('.desktop-auth').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.top === 0 && Math.abs(rect.bottom - innerHeight) < 1;
    }), 'signed-out authentication also uses a single header row');
    assert.equal(await page.locator('.desktop-auth > header').evaluate(element => element.getBoundingClientRect().height), 56);
    for (const theme of ['white', 'original', 'black']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.locator('.desktop-auth').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(10, 11, 12)', `signed-out auth remains black with ${theme} preference`);
    }
  }
  assert.equal(await page.locator('.desktop-auth .brand-power').textContent(), '2');
  await noWorkspace();
  assert.equal(await page.locator('.desktop-auth > header').evaluate(element => getComputedStyle(element).borderBottomWidth), '0px', 'signed-out desktop header has no bottom divider');
  await page.screenshot({ path: '/private/tmp/bizencore-desktop-sign-in-mock.png' });
  await page.evaluate(() => { window.__authTest.mode = 'pending'; });
  await page.getByRole('button', { name: 'サインイン', exact: true }).click();
  await page.waitForFunction(() => window.__authTest.calls.some(call => call.command === 'desktop_authorize'));
  await noWorkspace();
  await page.evaluate(() => window.__authTest.resolve({ userId: 'first', expiresAt: Math.floor(Date.now() / 1000) + 60 }));
  await page.getByRole('heading', { name: 'Task workspace' }).waitFor();
  assert.equal(await page.locator('.agent-pane').count(), 0);
  const launcher = page.getByRole('form', { name: 'エージェントを起動する', exact: true });
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  const pane = page.locator('.agent-pane');
  await pane.locator('.agent-status-running').waitFor();
  await page.getByRole('separator', { name: 'タスク画面の幅', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  assert.equal(await page.locator('.agent-pane').count(), 2);
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  const settings = page.getByRole('region', { name: 'ターミナル設定', exact: true });
  await settings.getByRole('button', { name: '文字を大きく', exact: true }).click();
  await settings.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  await pane.first().getByRole('button', { name: 'エージェントを停止', exact: true }).click();
  await pane.first().locator('.agent-status-exited').waitFor();
  await pane.first().getByRole('combobox', { name: 'CLIセッション', exact: true }).selectOption('55555555-5555-4555-8555-555555555555');
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await page.getByRole('heading', { name: 'Sign in to bizencore' }).waitFor();
  await noWorkspace();
  assert.ok(await page.evaluate(() => window.__authTest.calls.some(call => call.command === 'desktop_lock')));
  assert.equal(await page.evaluate(() => window.__authTest.channels.size), 0, 'logout clears native sessions');
  // An auth result arriving after logout cannot restore the workspace.
  await page.getByRole('button', { name: 'サインイン', exact: true }).click();
  await page.waitForFunction(() => window.__authTest.calls.filter(call => call.command === 'desktop_authorize').length === 2);
  await page.evaluate(() => window.__authTest.update({ isSignedIn: false, userId: null, sessionId: null }));
  await page.getByRole('heading', { name: 'Sign in to bizencore' }).waitFor();
  await page.evaluate(() => window.__authTest.resolve({ userId: 'first', expiresAt: Math.floor(Date.now() / 1000) + 60 }));
  await noWorkspace();
  await page.evaluate(() => { window.__authTest.mode = 'reject'; });
  await page.getByRole('button', { name: 'サインイン', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await noWorkspace();
  await page.evaluate(() => { window.__authTest.mode = 'success'; window.__authTest.update({ sessionId: 'session-b', userId: 'second' }); });
  await page.getByRole('heading', { name: 'Task workspace' }).waitFor();
  assert.equal(await page.locator('.agent-pane').count(), 0, 'account change gets a fresh compact workspace');
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  assert.equal(await settings.getByRole('checkbox').isChecked(), false, 'notification opt-in is account scoped');
  assert.equal(await settings.locator('output').textContent(), '13 px', 'font size is account scoped');
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  await page.evaluate(() => window.__authTest.expire());
  await page.getByRole('alert').waitFor();
  await noWorkspace();
  await page.evaluate(() => window.__authTest.update({ sessionId: 'session-c', userId: 'first' }));
  await page.getByRole('heading', { name: 'Task workspace' }).waitFor();
  assert.equal(await page.locator('.agent-pane').count(), 2, 'the original account gets its own saved panes');
  assert.equal(await page.locator('.agent-cwd').first().textContent(), 'project');
  assert.equal(await page.getByRole('separator', { name: 'タスク画面の幅', exact: true }).getAttribute('aria-valuenow'), '48');
  assert.equal(await page.locator('.agent-status-running').count(), 0, 'restoring panes never starts agents');
  assert.equal(await page.locator('.agent-pane').first().getByRole('combobox', { name: 'CLIセッション', exact: true }).inputValue(), '55555555-5555-4555-8555-555555555555');
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  assert.equal(await settings.getByRole('checkbox').isChecked(), true);
  assert.equal(await settings.locator('output').textContent(), '14 px');
  await page.getByRole('button', { name: 'ターミナル設定', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__authTest.calls.filter(call => call.command === 'desktop_start').length), 2);
  assert.equal(await page.locator('.agent-terminal:visible').count(), 0, 'restored unstarted agents do not show blank terminals');
  await page.reload();
  await page.evaluate(() => window.__authTest.update({ isLoaded: true, isSignedIn: true, sessionId: 'session-d', userId: 'first' }));
  await page.getByRole('heading', { name: 'Task workspace' }).waitFor();
  assert.equal(await page.locator('.agent-pane').count(), 2, 'full renderer reload restores saved pane count');
  assert.equal(await page.locator('.agent-cwd').first().textContent(), 'project');
  assert.equal(await page.locator('.agent-status-running').count(), 0);
  assert.equal(await page.locator('.agent-pane').first().getByRole('combobox', { name: 'CLIセッション', exact: true }).inputValue(), '55555555-5555-4555-8555-555555555555', 'specific resume selection survives reload without auto-launch');
  assert.equal(await page.evaluate(() => window.__authTest.calls.some(call => call.command === 'desktop_start')), false);
  await page.screenshot({ path: '/private/tmp/bizencore-workspace-restored-mock.png' });
  assert.deepEqual(errors, []);
  console.log('Passed: Electron authentication boundary, logout cleanup, late auth, account-scoped font/notification preferences, expiry and reload/layout/specific session restoration without auto-start (mock auth/IPC).');
} finally { await browser.close(); }
