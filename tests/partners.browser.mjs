import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const longTitle = '相手のタスクも途中で切り取らず、親子関係と締め切りがわかるように表示する。'.repeat(3);
const own = [
  { id: 'own-label', type: 'section', text: '自分のビルド', parentId: null, color: 'purple' },
  { id: 'own-task', text: '自分の作業', parentId: 'own-label', note: '自分だけのメモ' },
].map((item, order) => ({ type: 'task', order, done: false, createdAt: 1, updatedAt: 1, ...item }));
const peer = [
  { id: 'peer-label', type: 'section', text: '相手のビルド', parentId: null, color: 'green' },
  { id: 'peer-task', text: longTitle, parentId: 'peer-label', dueDate: '2026-10-09', dueTime: '18:00' },
  { id: 'peer-child', text: '子タスク', parentId: 'peer-task' },
  { id: 'peer-done', text: '完了した作業', parentId: 'peer-label', done: true },
  { id: 'peer-filed', text: '整理済みの作業', parentId: 'peer-label', done: true, filed: true },
  { id: 'peer-locked', text: 'ロックした箱', parentId: 'peer-label', locked: true },
].map((item, order) => ({ type: 'task', order, done: false, ...item }));
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TasksPage } from './src/pages/TasksPage';
    import { SettingsPanel } from './src/components/SettingsPanel';
    import { Brand } from './src/components/Brand';
    import { Settings2 } from 'lucide-react';
    import { taskStore } from './src/lib/taskStore';
    import { applyTheme } from './src/lib/theme';
    import { setUserTimeZone } from './src/lib/userTimeZone';
    import { initialPartnerInvite } from './src/lib/partnerModel';
    applyTheme('black'); setUserTimeZone('UTC');
    taskStore.mergeRemote(${JSON.stringify(own)}.map(item => ({ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) })));
    globalThis.fixtureAuth = { isSignedIn: true, userId: 'alice' };
    globalThis.fixtureListeners = new Set(); globalThis.fixtureRevision = 0;
    globalThis.fixtureNotify = () => { globalThis.fixtureRevision++; for (const listener of globalThis.fixtureListeners) listener(); };
    globalThis.fixture = { state: { accountId: 'alice', partner: null, labels: [{ id: 'own-label', text: '自分のビルド', color: 'purple' }], sharedLabelIds: [], invite: null }, list: null, preview: null };
    globalThis.fixturePatch = patch => { Object.assign(globalThis.fixture, patch); globalThis.fixtureNotify(); };
    globalThis.fixtureConnect = () => globalThis.fixturePatch({ state: { ...globalThis.fixture.state, partner: { name: 'パートナー' }, invite: null, sharedLabelIds: [] }, list: { accountId: 'alice', name: 'パートナー', items: ${JSON.stringify(peer)} } });
    globalThis.fixtureAccount = value => { globalThis.fixtureAuth = value; globalThis.fixtureNotify(); };
    globalThis.fixtureCalls = [];
    function Fixture() {
      const [settings, setSettings] = useState(() => !!initialPartnerInvite());
      const [theme, setTheme] = useState('black');
      return <div className="app-shell"><header className="app-header"><Brand /><div className="app-header-end"><nav className="app-nav"><span className="nav-link active">tasks</span><span className="nav-link">count</span></nav><button className="app-settings-btn" aria-label="設定を開く" onClick={() => setSettings(true)}><Settings2 size={17} /></button></div></header>
        <main className="app-main"><TasksPage /></main>{settings ? <SettingsPanel onClose={() => setSettings(false)} theme={theme} onThemeChange={value => { setTheme(value); applyTheme(value); }} /> : null}</div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-partner-server', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === 'convex/react' ? `
      import { useSyncExternalStore } from 'react';
      import { getFunctionName } from 'convex/server';
      const subscribe = fn => { globalThis.fixtureListeners.add(fn); return () => globalThis.fixtureListeners.delete(fn); };
      export function useQuery(ref, args) {
        useSyncExternalStore(subscribe, () => globalThis.fixtureRevision);
        if (args === 'skip') return undefined;
        const name = getFunctionName(ref);
        if (name === 'partners:state') return globalThis.fixture.state;
        if (name === 'partners:list') return globalThis.fixture.list;
        if (name === 'partners:previewInvite') return globalThis.fixture.preview;
        if (name === 'sync:listMcpConnections') return [];
        if (name === 'sync:getTimeZone') return { timeZone: 'UTC' };
        return undefined;
      }
      export function useMutation(ref) {
        return async args => {
          const name = getFunctionName(ref); globalThis.fixtureCalls.push({ name, args });
          if (globalThis.fixtureFail) throw new Error('fixture failure');
          const f = globalThis.fixture;
          if (name === 'partners:createInvite') { const invite = { code: 'a'.repeat(64), expiresAt: Date.now() + 86400000 }; globalThis.fixturePatch({ state: { ...f.state, invite } }); return invite; }
          if (name === 'partners:cancelInvite') globalThis.fixturePatch({ state: { ...f.state, invite: null } });
          if (name === 'partners:acceptInvite') globalThis.fixtureConnect();
          if (name === 'partners:setLabelSharing') globalThis.fixturePatch({ state: { ...f.state, sharedLabelIds: args.shared ? [args.labelId] : [] } });
          if (name === 'partners:disconnect') globalThis.fixturePatch({ state: { ...f.state, partner: null, sharedLabelIds: [] }, list: null });
        };
      }
      export const useAction = useMutation;
    ` : `
      import { useSyncExternalStore } from 'react';
      export function useAuth() { useSyncExternalStore(fn => { globalThis.fixtureListeners.add(fn); return () => globalThis.fixtureListeners.delete(fn); }, () => globalThis.fixtureRevision); return globalThis.fixtureAuth; }
      export const SignedIn = ({ children }) => globalThis.fixtureAuth.isSignedIn ? children : null;
      export const SignedOut = ({ children }) => globalThis.fixtureAuth.isSignedIn ? null : children;
      export const SignInButton = ({ children }) => children;
    ` }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const script = outputFiles[0].text.replaceAll('</script', '<\\/script');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('https://partners.test/')
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${script}</script>` }) : route.abort());
  await page.goto('https://partners.test/');
  await page.locator('[data-row-id="own-task"]').waitFor();
  assert.equal(await page.locator('.partner-list').count(), 0);
  await page.getByRole('button', { name: '設定を開く' }).click();
  await page.getByRole('button', { name: '招待リンクを作る' }).click();
  assert.match(await page.getByLabel('自分の招待リンク').inputValue(), /#partner-invite=a{64}$/);
  await page.evaluate(() => globalThis.fixturePatch({ state: { ...globalThis.fixture.state, invite: null } }));
  await page.getByRole('button', { name: '招待リンクを作る' }).waitFor();
  assert.equal(await page.getByLabel('自分の招待リンク').count(), 0, 'another device cancels the invitation without a stale local fallback');
  await page.getByRole('button', { name: '招待リンクを作る' }).click();
  await page.getByRole('button', { name: '招待を取り消す' }).click();
  await page.getByRole('button', { name: '招待リンクを作る' }).waitFor();
  await page.getByLabel('招待リンクまたはコード').fill('javascript:alert(1)');
  await page.getByRole('button', { name: '確認', exact: true }).click();
  assert.match(await page.getByRole('alert').innerText(), /招待リンクを確認/);
  await page.evaluate(() => globalThis.fixturePatch({ preview: { name: 'パートナー', expiresAt: Date.now() + 86400000 } }));
  await page.getByLabel('招待リンクまたはコード').fill('b'.repeat(64));
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await page.getByRole('button', { name: '招待を承認' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.fixtureCalls.filter(call => call.name === 'partners:acceptInvite').length), 0, 'preview is not consent');
  await page.getByRole('button', { name: '招待を承認' }).click();
  const checkbox = page.locator('.partner-labels input[type="checkbox"]');
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check(); assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck(); assert.equal(await checkbox.isChecked(), false);
  await page.evaluate(() => { globalThis.fixtureFail = true; });
  await checkbox.click();
  await page.getByRole('alert').waitFor();
  assert.equal(await checkbox.isChecked(), false, 'failed sharing does not pretend that data is public');
  await page.evaluate(() => { globalThis.fixtureFail = false; });
  await checkbox.focus(); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '設定', exact: true }).count(), 0, 'Escape still closes settings from partner controls');

  const partner = page.locator('.partner-list');
  await partner.waitFor();
  assert.equal(await partner.locator('input, textarea, .row-actions').count(), 0, 'partner rows have no editable controls');
  assert.equal(await partner.getByText(longTitle, { exact: true }).textContent(), longTitle);
  assert.equal(await partner.getByText('2026/10/09 18:00', { exact: true }).count(), 1);
  assert.equal(await partner.getByRole('img', { name: 'ロック中', exact: true }).count(), 1);
  assert.equal(await partner.getByText('完了した作業', { exact: true }).count(), 1);
  assert.equal(await partner.getByText('整理済みの作業', { exact: true }).count(), 0);
  await partner.getByRole('button', { name: /完了済み/ }).click();
  assert.equal(await partner.getByText('整理済みの作業', { exact: true }).count(), 1);
  await page.locator('[data-row-id="own-task"] textarea.row-title').fill('自分の作業を編集');
  await page.waitForTimeout(220);
  assert.ok(!(await page.evaluate(() => localStorage.getItem('chrct.tasks.v2'))).includes('peer-'), 'peer tasks never enter the editable local task store');

  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width <= 1100) await page.getByRole('tab', { name: 'パートナー', exact: true }).click();
      const geometry = await page.evaluate(() => {
        const own = document.querySelector('.partner-self').getBoundingClientRect();
        const peer = document.querySelector('.partner-list').getBoundingClientRect();
        return { ownRight: own.right, peerLeft: peer.left, ownWidth: own.width, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.overflow, false, `${theme}/${width} no horizontal overflow`);
      if (width > 1100) assert.ok(geometry.ownRight < geometry.peerLeft, 'own on the left, peer on the right');
      else assert.equal(geometry.ownWidth, 0, 'mobile displays just the selected list');
      const titles = await partner.locator('.partner-title').evaluateAll(elements => elements.map(el => ({ h: el.clientHeight, sh: el.scrollHeight, w: el.clientWidth, sw: el.scrollWidth })));
      for (const title of titles) assert.ok(title.sh <= title.h + 1 && title.sw <= title.w + 1, 'full titles fit');
      await page.screenshot({ path: `/private/tmp/bizencore-partner-${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.getByRole('tab', { name: 'パートナー', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: '自分', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'パートナー', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator('body').evaluate(el => { el.tabIndex = -1; el.focus(); });
  await page.keyboard.press('Alt+e');
  assert.equal(await page.locator('.task-inspector').count(), 0, 'editing shortcuts never target the hidden own list');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '自分', exact: true }).getAttribute('aria-selected'), 'true', 'own search reveals own list');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'パートナー', exact: true }).click();
  await partner.getByRole('button', { name: /完了済み/ }).focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.getByRole('tab', { name: '自分', exact: true }).getAttribute('aria-selected'), 'true', 'search shortcut works from read-only partner controls');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'board', exact: true }).click(); assert.equal(await partner.count(), 0);
  await page.getByRole('tab', { name: /today/ }).click(); assert.equal(await partner.count(), 0);
  await page.getByRole('tab', { name: 'all', exact: true }).click(); await partner.waitFor({ state: 'attached' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => globalThis.fixturePatch({ list: { ...globalThis.fixture.list, items: [] } }));
  assert.equal(await partner.getByText('公開されたラベルはありません。', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '設定を開く' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'パートナーとの接続を解除', exact: true }).click();
  await page.getByRole('button', { name: '招待リンクを作る' }).waitFor();
  assert.equal(await partner.count(), 0);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.evaluate(() => globalThis.fixtureConnect()); await partner.waitFor();
  await page.evaluate(() => globalThis.fixtureAccount({ isSignedIn: true, userId: 'bob' }));
  assert.equal(await partner.count(), 0, 'account switching never displays the previous account partner');
  await page.evaluate(() => globalThis.fixtureAccount({ isSignedIn: false, userId: null }));
  assert.equal(await partner.count(), 0);
  await page.getByRole('button', { name: '設定を開く' }).click();
  await page.getByRole('button', { name: 'サインイン', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Passed: explicit invite consent, revocation, sharing success/failure, disconnect, account isolation, read-only partner trees, no local persistence, All-only layout, 3 themes at desktop/390/320px, full titles, mobile tabs and keyboard/search isolation. No real accounts or network.');
} finally { await browser.close(); }
