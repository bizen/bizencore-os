import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { loadConfigFromFile } from 'vite';

async function load(contents) {
  const { outputFiles } = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    define: { 'import.meta.env': '{"VITE_APP_BUILD_ID":"current"}' } });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { fetchPublishedBuild, watchForAppUpdate } = await load("export * from './src/lib/appUpdate';");
const tick = () => new Promise(resolve => setImmediate(resolve));

test('each production build emits the same ID that is compiled into that build; dev disables checking', async () => {
  const first = (await loadConfigFromFile({ command: 'build', mode: 'production' })).config;
  const second = (await loadConfigFromFile({ command: 'build', mode: 'production' })).config;
  const id = JSON.parse(first.define['import.meta.env.VITE_APP_BUILD_ID']);
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.define['import.meta.env.VITE_APP_BUILD_ID'], second.define['import.meta.env.VITE_APP_BUILD_ID']);
  const plugin = first.plugins.flat().find(plugin => plugin.name === 'app-build-version');
  let artifact;
  plugin.generateBundle.call({ emitFile: file => { artifact = file; } });
  assert.equal(artifact.fileName, 'version.json');
  assert.equal(JSON.parse(artifact.source).buildId, id);
  const dev = (await loadConfigFromFile({ command: 'serve', mode: 'development' })).config;
  assert.equal(JSON.parse(dev.define['import.meta.env.VITE_APP_BUILD_ID']), '');
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.ok(config.headers.find(rule => rule.source === '/version.json').headers.some(header => header.key === 'Cache-Control' && header.value === 'no-store'));
});

test('version fetch bypasses cache and rejects missing, malformed and failed responses', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/version.json');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.signal, controller.signal);
      return new Response(JSON.stringify({ buildId: 'next' }));
    };
    assert.equal(await fetchPublishedBuild(controller.signal), 'next');
    for (const body of ['{}', '{"buildId":null}', '{"buildId":""}', '{"buildId":"https://bad.test"}', '<html>SPA fallback</html>']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(fetchPublishedBuild(controller.signal));
    }
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    await assert.rejects(fetchPublishedBuild(controller.signal));
    globalThis.fetch = async () => { throw new Error('Offline'); };
    await assert.rejects(fetchPublishedBuild(controller.signal));
  } finally { globalThis.fetch = original; }
});

test('watcher checks startup, visible polling and resume; handles offline, rollback, timeout and cleanup', async () => {
  const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), now: Date.now };
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = new EventTarget();
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 0, now = 0, calls = 0, remote = 'current', pending = false;
  let complete;
  Object.assign(win, {
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
  });
  const published = [];
  let stop;
  try {
    globalThis.document = doc; globalThis.window = win;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    Date.now = () => now;
    globalThis.fetch = async (_url, options) => {
      calls++;
      if (pending) return new Promise((resolve, reject) => {
        complete = () => resolve(new Response(JSON.stringify({ buildId: remote })));
        options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      return new Response(JSON.stringify({ buildId: remote }));
    };
    const noDevWork = watchForAppUpdate('', () => assert.fail('dev cannot notify'));
    noDevWork(); assert.equal(calls, 0); assert.equal(intervals.size, 0);
    stop = watchForAppUpdate('current', id => published.push(id));
    await tick(); assert.deepEqual(published, [null]);
    assert.equal(calls, 1);
    win.dispatchEvent(new Event('focus')); await tick(); assert.equal(calls, 1, 'duplicate focus is throttled');
    remote = 'next'; now += 180_000;
    for (const poll of intervals.values()) void poll();
    await tick(); assert.equal(published.at(-1), 'next');
    doc.visibilityState = 'hidden'; now += 180_000;
    for (const poll of intervals.values()) void poll();
    await tick(); assert.equal(calls, 2, 'no background requests');
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
    await tick(); assert.equal(calls, 3);
    navigator.onLine = false; win.dispatchEvent(new Event('offline'));
    assert.equal(published.at(-1), null);
    now += 180_000; for (const poll of intervals.values()) void poll();
    await tick(); assert.equal(calls, 3);
    navigator.onLine = true; remote = 'current'; win.dispatchEvent(new Event('online'));
    await tick(); assert.equal(published.at(-1), null, 'rollback removes stale update');
    pending = true; now += 180_000; win.dispatchEvent(new Event('pageshow'));
    assert.equal(calls, 5);
    win.dispatchEvent(new Event('focus')); assert.equal(calls, 5, 'only one request in flight');
    for (const timeout of timers.values()) timeout();
    await tick(); assert.equal(published.at(-1), null, 'timeout is not a new version');
    now += 180_000; win.dispatchEvent(new Event('focus'));
    const before = published.length;
    stop(); complete(); await tick();
    assert.equal(published.length, before, 'disposed watcher cannot publish');
    assert.equal(intervals.size, 0); assert.equal(timers.size, 0);
    win.dispatchEvent(new Event('focus')); assert.equal(calls, 6);
  } finally {
    stop?.(); globalThis.document = original.document; globalThis.window = original.window; globalThis.fetch = original.fetch;
    Date.now = original.now;
    if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator); else delete globalThis.navigator;
  }
});

test('reload preparation preserves current task/life/count edits and refuses unsaved drafts, uploads and storage failure', async () => {
  const original = { document: globalThis.document, window: globalThis.window, storage: globalThis.localStorage };
  const storage = new Map();
  let fail = false, draft = '', uploading = false, consent = false;
  const alerts = [];
  try {
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => {
      if (fail) throw new Error('Quota exceeded'); storage.set(key, value);
    } };
    globalThis.window = Object.assign(new EventTarget(), { localStorage, alert: message => alerts.push(message), confirm: () => consent });
    globalThis.document = Object.assign(new EventTarget(), {
      querySelector: selector => selector.startsWith('.context-upload-btn') ? (uploading ? {} : null) : { value: draft },
      querySelectorAll: () => [{ dataset: { reloadStorageKey: 'chrct.count.text' }, value: 'Current count input' }],
    });
    const { prepareAppReload, taskStore, lifeWorldStore, flushPersist, restamp } = await load(`
      export * from './src/lib/prepareAppReload';
      export { taskStore, flushPersist } from './src/lib/taskStore';
      export { lifeWorldStore } from './src/lib/lifeWorldStore';
      export { restamp } from './src/lib/itemMerge';
    `);
    const item = { id: 'reload-test', text: 'Typing just now', type: 'task', parentId: null, order: 0, done: false, updatedAt: 1, createdAt: 1 };
    taskStore.mergeRemote([{ itemId: item.id, updatedAt: 1, payload: JSON.stringify(item) }]);
    const lifeId = lifeWorldStore.add('2026-10-07'); lifeWorldStore.setText(lifeId, 'Pho');
    assert.equal(prepareAppReload(), true);
    assert.equal(JSON.parse(storage.get('chrct.tasks.v2'))[0].text, 'Typing just now');
    assert.equal(JSON.parse(storage.get('bizencore.life-world.local.v1')).entries[lifeId].text, 'Pho');
    assert.equal(storage.get('chrct.count.text'), 'Current count input');
    const current = taskStore.getState().items[item.id];
    const later = Date.now() + 10_000;
    const otherTab = restamp(current, { ...current, note: 'Other tab note' }, later);
    storage.set('chrct.tasks.v2', JSON.stringify([otherTab, { ...item, id: 'another-tab' }]));
    const lifeData = JSON.parse(storage.get('bizencore.life-world.local.v1'));
    lifeData.entries[lifeId].note = 'Other tab life note';
    lifeData.entries[lifeId].updatedAt = later;
    lifeData.entries[lifeId].stamps.note = later;
    storage.set('bizencore.life-world.local.v1', JSON.stringify(lifeData));
    assert.equal(prepareAppReload(), true);
    assert.equal(JSON.parse(storage.get('chrct.tasks.v2')).find(entry => entry.id === item.id).note, 'Other tab note');
    assert.ok(JSON.parse(storage.get('chrct.tasks.v2')).some(entry => entry.id === 'another-tab'));
    assert.equal(JSON.parse(storage.get('bizencore.life-world.local.v1')).entries[lifeId].note, 'Other tab life note');
    draft = 'Unattached text'; assert.equal(prepareAppReload(), false);
    consent = true; assert.equal(prepareAppReload(), true);
    uploading = true; assert.equal(prepareAppReload(), false); assert.match(alerts.at(-1), /アップロード/);
    uploading = false; draft = ''; fail = true;
    taskStore.setText(item.id, 'Failed save stays in memory'); flushPersist();
    assert.equal(prepareAppReload(), false); assert.match(alerts.at(-1), /保存に失敗/);
    fail = false; assert.equal(prepareAppReload(), true);
    assert.equal(JSON.parse(storage.get('chrct.tasks.v2')).find(entry => entry.id === item.id).text, 'Failed save stays in memory');
  } finally { globalThis.document = original.document; globalThis.window = original.window; globalThis.localStorage = original.storage; }
});
