import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const backend = await build({ entryPoints: ['convex/focusedLabels.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const handlers = await import(`data:text/javascript;base64,${Buffer.from(backend.outputFiles[0].contents).toString('base64')}`);
const rows = { accountDeletions: [], userPreferences: [] };
let next = 0, failNext = false, transaction = Promise.resolve();
const actors = new Map(), errors = [];
const ctx = user => ({ auth: { getUserIdentity: async () => user ? { subject: user } : null }, db: {
  query(table) { const filters = []; const chain = {
    withIndex(_name, apply) { const q = { eq: (field, value) => { filters.push([field, value]); return q; } }; apply(q); return chain; },
    unique: async () => rows[table].find(row => filters.every(([field, value]) => row[field] === value)) ?? null,
  }; return chain; },
  insert: async (table, value) => { const id = `${++next}`; rows[table].push({ ...value, _id: id }); return id; },
  patch: async (id, value) => Object.assign(rows.userPreferences.find(row => row._id === id), value),
} });
const ui = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import { StrictMode } from 'react';
  import { createRoot } from 'react-dom/client';
  import { TasksPage } from './src/pages/TasksPage';
  import { taskStore } from './src/lib/taskStore';
  import { applyTheme } from './src/lib/theme';
  applyTheme('black');
  taskStore.mergeRemote(['work', 'study', 'other'].map((id, order) => ({ itemId: id, updatedAt: 1,
    payload: JSON.stringify({ id, order, text: {work:'ビルド', study:'大学', other:'生活'}[id], type:'section', parentId:null, done:false, createdAt:1, updatedAt:1 }) })));
  async function login(id) { await globalThis.fixtureLogin(id); globalThis.fixtureSetUser(id); }
  createRoot(document.getElementById('root')).render(<StrictMode><div className="app-shell">
    <header className="app-header"><button onClick={() => login('a')}>Account A</button><button onClick={() => login('b')}>Account B</button><button onClick={() => login(null)}>Sign out</button></header>
    <main className="app-main"><TasksPage /></main></div></StrictMode>);
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://focus.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'synthetic-auth-transport', setup(b) { b.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, () => ({ path: path.resolve('tests/fixtures/focusClient.mjs') })); } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch();
try {
  const open = async legacy => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); actors.set(page, 'a');
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => { if (!localStorage.getItem('seeded')) { localStorage.setItem('chrct.tasks.focusedLabels', JSON.stringify(value)); localStorage.setItem('seeded', '1'); } }, legacy);
    await page.exposeBinding('fixtureLogin', ({ page }, user) => { actors.set(page, user); });
    await page.exposeBinding('fixtureRpc', ({ page }, name, args) => {
      const run = transaction.then(async () => {
        if (name === 'focusedLabels:set' && failNext) { failNext = false; throw Error('synthetic connection failure'); }
        const method = name.split(':')[1];
        const result = await handlers[method]._handler(ctx(actors.get(page)), args);
        if (method !== 'get') for (const [other, user] of actors) {
          if (other.isClosed() || !user) continue;
          const snapshot = await handlers.get._handler(ctx(user), { accountId: user });
          await other.evaluate(({ user, snapshot }) => globalThis.fixtureRemote?.(user, snapshot), { user, snapshot });
        }
        return result;
      });
      transaction = run.catch(() => {});
      return run;
    });
    await page.route('**/*', route => route.request().url() === 'https://focus.test/'
      ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${ui.outputFiles[0].text}</script>` }) : route.abort());
    await page.goto('https://focus.test/'); return page;
  };
  const a = await open(['work']), b = await open(['other']);
  const expectTabs = async (page, expected) => { await page.waitForFunction(value => [...document.querySelectorAll('.view-switch [role="tab"]')].map(el => el.getAttribute('aria-label') || el.textContent.trim()).join('|') === value, expected.join('|')); };
  const pin = (page, id) => page.locator(`[data-row-id="${id}"] .meta-focus`);
  await expectTabs(a, ['all', 'board', 'today0', 'ビルド']); await expectTabs(b, ['all', 'board', 'today0', 'ビルド']);
  await pin(a, 'study').click();
  await expectTabs(b, ['all', 'board', 'today0', 'ビルド', '大学']);
  assert.equal(await a.getByRole('tab', { name: 'all', exact: true }).getAttribute('aria-selected'), 'true', 'pinning stays on All');
  await pin(b, 'work').click(); await expectTabs(a, ['all', 'board', 'today0', '大学']);
  await a.reload(); await expectTabs(a, ['all', 'board', 'today0', '大学']);
  await a.keyboard.press('Alt+4');
  assert.equal(await a.getByRole('tab', { name: '大学', exact: true }).getAttribute('aria-selected'), 'true');
  await a.getByRole('button', { name: 'Account B', exact: true }).click();
  await expectTabs(a, ['all', 'board', 'today0']);
  await pin(a, 'other').click(); await expectTabs(a, ['all', 'board', 'today0', '生活']);
  await expectTabs(b, ['all', 'board', 'today0', '大学']);
  await a.getByRole('button', { name: 'Account A', exact: true }).click();
  await expectTabs(a, ['all', 'board', 'today0', '大学']);
  await a.getByRole('tab', { name: 'all', exact: true }).click();
  failNext = true; await pin(a, 'other').click(); await a.getByRole('alert').waitFor();
  await expectTabs(a, ['all', 'board', 'today0', '大学']);
  await pin(a, 'study').click(); await expectTabs(b, ['all', 'board', 'today0']);
  await b.reload(); await expectTabs(b, ['all', 'board', 'today0']);
  await pin(a, 'work').click(); await pin(a, 'study').click();
  await expectTabs(b, ['all', 'board', 'today0', 'ビルド', '大学']);
  for (const width of [1280, 390]) {
    await a.setViewportSize({ width, height: 900 });
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await a.screenshot({ path: `/private/tmp/bizencore-focus-account-${width}.png`, fullPage: true });
  }
  await a.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expectTabs(a, ['all', 'board', 'today0']);
  assert.deepEqual(rows.userPreferences.find(row => row.userId === 'a').focusedLabelIds, ['work', 'study']);
  assert.deepEqual(rows.userPreferences.find(row => row.userId === 'b').focusedLabelIds, ['other']);
  assert.deepEqual(errors, []);
  console.log('Passed: two isolated browser devices share ordered focus tabs through real authenticated handlers; legacy migration, stale-device protection, account switching, logout, failed-write rollback, Alt+4, All retention, intentional empty list and 1280/390 screenshots. Synthetic auth/transport; no real accounts or deployment.');
} finally { await browser.close(); }
