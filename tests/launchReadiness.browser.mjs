import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import App from './src/App';
    window.__launch = { status: 'missing', starts: 0 };
    const f = window.__launch;
    window.bizencoreDesktop = {
      integratedTitlebar: true,
      agents: async () => [],
      agentDiagnostics: async () => [
        { id: 'claude', name: 'Claude Code', path: f.status === 'missing' ? null : '/fixture/claude',
          version: f.status === 'ready' ? '2.1.0' : null,
          problem: f.status === 'missing' ? '未インストール' : f.status === 'failed' ? '起動できません' : undefined },
        { id: 'codex', name: 'Codex', path: '/fixture/codex', version: '0.1.0' },
      ],
      folder: async () => '/fixture/project',
      conversations: async () => [],
      openExternal: async () => {},
      start: async () => { f.starts++; throw new Error('作業フォルダにアクセスできません。読み書きできるフォルダを選び直してください。'); },
      onEvent: () => () => {},
      stop: async () => {}, resize: async () => {}, write: async () => {},
    };
    (async () => {
      const { AgentWorkspace } = await import('./desktop/workspace');
      const { DesktopFrame } = await import('./desktop/Frame');
      const { DesktopWorkspaceAccount } = await import('./desktop/workspace-account');
      createRoot(document.getElementById('root')).render(<DesktopFrame><MemoryRouter><DesktopWorkspaceAccount.Provider value="launch-fixture"><AgentWorkspace><App desktop /></AgentWorkspace></DesktopWorkspaceAccount.Provider></MemoryRouter></DesktopFrame>);
    })();
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.png': 'dataurl', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_DESKTOP_APP_VERSION: '0.1.9', VITE_DESKTOP_APP_CHANNEL: 'production', VITE_DESKTOP_SAFE_ASSETS: 'true' }) },
});
const css = (await readFile('src/index.css', 'utf8')) + (await readFile('desktop/workspace.css', 'utf8')) + (await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }));
  await page.goto('http://127.0.0.1/');
  await page.locator('.splash-root').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.desktop-header .brand-version').textContent(), 'v0.1.9');
  await page.getByRole('button', { name: 'エージェントを追加', exact: true }).click();
  const launcher = page.getByRole('form', { name: 'エージェントを起動する' });
  await launcher.getByRole('button', { name: '作業フォルダを選択', exact: true }).click();
  await launcher.getByRole('alert').waitFor();
  assert.match(await launcher.getByRole('alert').textContent(), /Claude Codeが見つかりません.*診断を更新/);
  assert.equal(await launcher.getByRole('button', { name: '起動する', exact: true }).isDisabled(), true);
  assert.equal(await launcher.getByRole('link', { name: 'インストール' }).count(), 1);
  await page.evaluate(() => { window.__launch.status = 'failed'; });
  await launcher.getByRole('button', { name: '診断を更新', exact: true }).click();
  await launcher.getByText(/起動できません。インストール先/).waitFor();
  assert.equal(await launcher.getByRole('button', { name: '起動する', exact: true }).isDisabled(), true, 'an executable path alone is not readiness');
  assert.equal(await page.evaluate(() => window.__launch.starts), 0);
  await page.screenshot({ path: '/private/tmp/bizencore-launch-diagnostic.png' });
  await page.evaluate(() => { window.__launch.status = 'ready'; });
  await launcher.getByRole('button', { name: '診断を更新', exact: true }).click();
  await launcher.getByRole('button', { name: '起動する', exact: true }).click();
  const pane = page.locator('.agent-pane');
  await pane.getByRole('alert').waitFor();
  assert.match(await pane.getByRole('alert').textContent(), /アクセスできません.*選び直して/);
  assert.equal(await pane.locator('.agent-status-idle').count(), 1);
  assert.equal(await pane.locator('.agent-status-running').count(), 0);
  assert.equal(await pane.getByRole('button', { name: '作業フォルダを選択' }).count(), 1);
  await page.screenshot({ path: '/private/tmp/bizencore-launch-folder-error.png' });
  for (const width of [900, 1380]) {
    await page.setViewportSize({ width, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('.desktop-header .brand').evaluate(element => {
      const brand = element.getBoundingClientRect();
      const nav = document.querySelector('.app-header-end').getBoundingClientRect();
      return brand.right <= nav.left;
    }), 'version fits without colliding with header controls');
  }
  assert.deepEqual(errors, []);
  console.log('Passed: visible version, missing CLI guidance, retry, failed CLI launch prevention, recoverable folder error and desktop header fit. Mock native IPC; no real CLI or account changed.');
} finally { await browser.close(); }
