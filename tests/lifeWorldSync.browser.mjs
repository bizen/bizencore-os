import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

// Exercise the real React sync bridge with a deterministic, network-isolated transport.
const cloud = `
  import { useSyncExternalStore } from 'react';
  import { emptyLifeData, mergeLifeData, lifeCheckKey } from './src/lib/lifeWorldModel';
  const listeners = new Set();
  let auth = { isLoaded: true, isSignedIn: true, userId: 'fixture-a' };
  const data = { 'fixture-a': emptyLifeData(), 'fixture-b': emptyLifeData() };
  globalThis.fixtureLifeCloud = data;
  const send = () => listeners.forEach(fn => fn());
  let offline = false;
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  export function useAuth() { return useSyncExternalStore(subscribe, () => auth); }
  const signedIn = { isAuthenticated: true }, signedOut = { isAuthenticated: false };
  export function useConvexAuth() { const a = useAuth(); return a.isSignedIn ? signedIn : signedOut; }
  export function useQuery(_ref, args) {
    return useSyncExternalStore(subscribe, () => args === 'skip' ? undefined : args.accountId === auth.userId ? data[args.accountId] : null);
  }
  async function push(args) {
    if (offline) throw new Error('fixture offline');
    if (args.accountId !== auth.userId) throw new Error('fixture unauthorized');
    data[args.accountId] = mergeLifeData(data[args.accountId], { version: 1,
      entries: Object.fromEntries(args.entries.map(e => [e.id, e])), checks: Object.fromEntries(args.checks.map(c => [lifeCheckKey(c.entryId, c.date), c])),
      ...(args.preferences ? { preferences: args.preferences } : {}) });
    send();
    return { ok: true };
  }
  export function useMutation() { return push; }
  export function identify(userId) { auth = { isLoaded: true, isSignedIn: !!userId, userId }; send(); }
  export function setOffline(value) { offline = value; }
  export function remoteComplete() {
    const entry = Object.values(data[auth.userId].entries).find(e => !e.deletedAt);
    const check = { entryId: entry.id, date: '2026-10-05', done: true, updatedAt: Date.now() + 10000 };
    data[auth.userId] = mergeLifeData(data[auth.userId], { version: 1, entries: {}, checks: { [lifeCheckKey(entry.id, check.date)]: check } });
    send();
  }
`;
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { LifeWorldSyncBridge } from './src/components/LifeWorldSyncBridge';
    import { LifeWorld } from './src/components/task/LifeWorld';
    import { LifeWorldInspector } from './src/components/task/LifeWorldInspector';
    import { lifeWorldStore, useLifeWorldState } from './src/lib/lifeWorldStore';
    import { identify, setOffline, remoteComplete } from 'fixture-cloud';
    function Fixture() {
      const { data } = useLifeWorldState();
      const [selection, setSelection] = useState(null);
      const close = () => { setSelection(null); if (selection) requestAnimationFrame(selection.restoreFocus); };
      return <>
      <div><button onClick={() => identify('fixture-a')}>Account A</button><button onClick={() => identify('fixture-b')}>Account B</button>
      <button onClick={() => identify(null)}>Sign out</button><button onClick={() => setOffline(true)}>Offline</button>
      <button onClick={() => setOffline(false)}>Online</button><button onClick={remoteComplete}>Remote check</button>
      <button onClick={() => lifeWorldStore.setShowInAll(true)}>Show in All</button>
      <button onClick={() => lifeWorldStore.moveSection(['root-a', 'root-b'], -1)}>Move label up</button>
      <output aria-label="All visibility">{data.preferences?.showInAll ? 'shown' : 'hidden'}</output></div>
      <LifeWorldSyncBridge /><LifeWorld todayDate="2026-10-05" inspectedId={selection?.id ?? null} onInspect={setSelection} onDateChange={close} />
      {selection ? <LifeWorldInspector selection={selection} todayDate="2026-10-05" onClose={close} /> : null}
    </>; }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'isolated-cloud', setup(b) {
    b.onResolve({ filter: /^(fixture-cloud|convex\/react|@clerk\/clerk-react)$/ }, () => ({ path: 'fixture-cloud', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: cloud, loader: 'js', resolveDir: process.cwd() }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url() === 'http://life-sync.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }) : route.abort());
  await page.goto('http://life-sync.test/');
  const titles = page.getByRole('textbox', { name: '生活タスク', exact: true });
  const synced = () => page.getByRole('status', { name: 'アカウント同期済み', exact: true }).waitFor({ timeout: 10000 });
  await synced();
  await page.getByRole('button', { name: 'Show in All', exact: true }).click();
  await synced();
  assert.equal(await page.evaluate(() => globalThis.fixtureLifeCloud['fixture-a'].preferences.showInAll), true, 'preference-only changes are uploaded');
  await page.getByRole('button', { name: 'Move label up', exact: true }).click(); await synced();
  assert.equal(await page.evaluate(() => globalThis.fixtureLifeCloud['fixture-a'].preferences.beforeId), 'root-b');
  await page.getByRole('button', { name: '生活世界に追加', exact: true }).click();
  await titles.first().fill('散歩');
  await page.getByRole('button', { name: '生活タスクの詳細', exact: true }).click();
  await page.getByRole('combobox', { name: '繰り返し' }).selectOption('daily');
  await page.getByRole('textbox', { name: '生活タスクのメモ' }).fill('アカウントAのメモ');
  await page.getByRole('textbox', { name: '生活タスクのメモ' }).press('Escape');
  await synced();
  await page.getByRole('button', { name: '生活タスクの詳細', exact: true }).click();
  await page.getByRole('button', { name: 'Account B', exact: true }).click();
  await synced(); assert.equal(await titles.count(), 0);
  assert.equal(await page.getByLabel('All visibility').textContent(), 'hidden');
  assert.equal(await page.getByRole('dialog', { name: '生活タスクの詳細', exact: true }).count(), 0, 'account switch closes prior-account details');
  await page.getByRole('button', { name: '生活世界に追加', exact: true }).click();
  await titles.first().fill('フォー'); await synced();
  await page.getByRole('button', { name: 'Account A', exact: true }).click();
  await synced(); assert.equal(await titles.first().inputValue(), '散歩');
  assert.equal(await page.getByLabel('All visibility').textContent(), 'shown');
  await page.getByRole('button', { name: 'Remote check', exact: true }).click();
  await page.getByRole('button', { name: '散歩を未完了に戻す', exact: true }).waitFor();
  assert.equal(await page.locator('.life-streak-dot.is-today.is-done').count(), 1);
  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  await titles.first().fill('夕方に散歩');
  await page.getByRole('button', { name: 'アカウント同期に失敗・再試行', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Online', exact: true }).click();
  await page.getByRole('button', { name: 'アカウント同期に失敗・再試行', exact: true }).click();
  await synced();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  assert.equal(await titles.count(), 0);
  await page.getByRole('button', { name: 'Account A', exact: true }).click();
  await synced(); assert.equal(await titles.first().inputValue(), '夕方に散歩');
  assert.equal(await page.getByRole('button', { name: '夕方に散歩を未完了に戻す', exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('Passed: real sync bridge lifecycle with isolated transport: initial pull, upload, remote check/streak, account switches, offline retry and sign-out/sign-in.');
} finally { await browser.close(); }
