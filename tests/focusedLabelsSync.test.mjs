import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { get, initialize, set } = await load('convex/focusedLabels.ts');
const { setTimeZone } = await load('convex/sync.ts');
const { claimLegacyFocus, readGuestFocus, readFocusCache, focusCacheKey, LEGACY_FOCUS_KEY, GUEST_FOCUS_KEY, normalizeFocusedLabels, changeFocusedLabel, browserFocusStorage } = await load('src/lib/focusedLabels.ts');

function server() {
  const rows = { accountDeletions: [], userPreferences: [] };
  let identity = 'a', sequence = 0;
  return { rows, identify: id => { identity = id; }, ctx: {
    auth: { getUserIdentity: async () => identity ? { subject: identity } : null },
    db: {
      query(table) {
        const filters = [];
        const chain = {
          withIndex(_name, apply) { const q = { eq: (field, value) => { filters.push([field, value]); return q; } }; apply(q); return chain; },
          unique: async () => rows[table].find(row => filters.every(([field, value]) => row[field] === value)) ?? null,
        };
        return chain;
      },
      insert: async (table, value) => { const id = `${table}:${++sequence}`; rows[table].push({ ...value, _id: id }); return id; },
      patch: async (id, value) => { Object.assign(Object.values(rows).flat().find(row => row._id === id), value); },
    },
  } };
}
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };
const read = s => get._handler(s.ctx, { accountId: 'a' });

test('account focus initializes once and a second device cannot overwrite it with stale local data', async () => {
  const s = server();
  assert.deepEqual(await read(s), { accountId: 'a', labelIds: null });
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['work', 'university', 'work'] });
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['stale'] });
  assert.deepEqual((await read(s)).labelIds, ['work', 'university']);
  assert.equal(s.rows.userPreferences.length, 1);
});

test('per-label device operations merge without overwriting unrelated focus tabs or their order', async () => {
  const s = server();
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['work', 'university'] });
  const change = (labelId, focused) => set._handler(s.ctx, { accountId: 'a', labelId, focused });
  await change('life', true); await change('work', false); await change('build', true);
  await change('build', true); await change('work', false);
  assert.deepEqual((await read(s)).labelIds, ['university', 'life', 'build']);
  await change('work', true);
  assert.deepEqual((await read(s)).labelIds, ['university', 'life', 'build', 'work']);
});

test('an intentional empty focus list stays empty across fresh-device initialization', async () => {
  const s = server();
  await set._handler(s.ctx, { accountId: 'a', labelId: 'work', focused: true });
  await set._handler(s.ctx, { accountId: 'a', labelId: 'work', focused: false });
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['work'] });
  assert.deepEqual((await read(s)).labelIds, []);
});

test('focus updates and time-zone updates preserve each other, including a pre-existing account row', async () => {
  const s = server();
  await setTimeZone._handler(s.ctx, { timeZone: 'Australia/Melbourne', automatic: false });
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['work'] });
  assert.equal(s.rows.userPreferences[0].timeZone, 'Australia/Melbourne');
  assert.equal(s.rows.userPreferences[0].automatic, false);
  await setTimeZone._handler(s.ctx, { timeZone: 'Asia/Tokyo', automatic: false });
  assert.deepEqual((await read(s)).labelIds, ['work']);
});

test('anonymous, mismatched-account and deleted-account requests cannot read or change preferences', async () => {
  const s = server();
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: ['private'] });
  for (const identity of ['b', null]) {
    s.identify(identity);
    assert.equal(await read(s), null);
    await assert.rejects(initialize._handler(s.ctx, { accountId: 'a', labelIds: [] }), /Unauthorized/);
    await assert.rejects(set._handler(s.ctx, { accountId: 'a', labelId: 'private', focused: false }), /Unauthorized/);
  }
  s.identify('b');
  assert.deepEqual(await get._handler(s.ctx, { accountId: 'b' }), { accountId: 'b', labelIds: null });
  await initialize._handler(s.ctx, { accountId: 'b', labelIds: ['b-only'] });
  s.identify('a'); s.rows.accountDeletions.push({ userId: 'a' });
  assert.equal(await read(s), null);
  await assert.rejects(set._handler(s.ctx, { accountId: 'a', labelId: 'other', focused: true }));
  await assert.rejects(initialize._handler(s.ctx, { accountId: 'a', labelIds: [] }));
  assert.deepEqual(s.rows.userPreferences.find(row => row.userId === 'a').focusedLabelIds, ['private']);
});

test('oversized or invalid focus inputs fail before writing', async () => {
  const s = server();
  for (const labelIds of [[''], ['x'.repeat(257)], Array.from({ length: 513 }, (_, i) => `${i}`)]) {
    await assert.rejects(initialize._handler(s.ctx, { accountId: 'a', labelIds }));
  }
  for (const labelId of ['', 'x'.repeat(257)]) await assert.rejects(set._handler(s.ctx, { accountId: 'a', labelId, focused: true }));
  assert.equal(s.rows.userPreferences.length, 0);
  await initialize._handler(s.ctx, { accountId: 'a', labelIds: Array.from({ length: 512 }, (_, i) => `${i}`) });
  await assert.rejects(set._handler(s.ctx, { accountId: 'a', labelId: 'extra', focused: true }));
  assert.equal((await read(s)).labelIds.length, 512);
});

test('legacy focus migrates only to its first account and does not leak into another account or environment', () => {
  const s = storage();
  s.setItem(LEGACY_FOCUS_KEY, JSON.stringify(['work', 'study', 'work', null]));
  assert.deepEqual(readGuestFocus(s), ['work', 'study']);
  assert.deepEqual(claimLegacyFocus(s, 'prod', 'a'), ['work', 'study']);
  assert.deepEqual(claimLegacyFocus(s, 'prod', 'a'), ['work', 'study']);
  assert.deepEqual(claimLegacyFocus(s, 'prod', 'b'), []);
  assert.deepEqual(claimLegacyFocus(s, 'dev', 'a'), []);
  assert.deepEqual(readGuestFocus(s), []);
  s.setItem(focusCacheKey('prod', 'a'), JSON.stringify(['a-only']));
  assert.deepEqual(readFocusCache(s, focusCacheKey('prod', 'a')), ['a-only']);
  assert.deepEqual(readFocusCache(s, focusCacheKey('prod', 'b')), []);
  assert.deepEqual(readFocusCache(s, focusCacheKey('dev', 'a')), []);
  assert.notEqual(focusCacheKey('x.y', 'z'), focusCacheKey('x', 'y.z'));
});

test('guest edits, malformed storage and unavailable storage remain safe', () => {
  const s = storage(); s.setItem(LEGACY_FOCUS_KEY, '[broken');
  assert.deepEqual(readGuestFocus(s), []);
  s.setItem(GUEST_FOCUS_KEY, JSON.stringify(['new']));
  assert.deepEqual(claimLegacyFocus(s, 'prod', 'a'), ['new']);
  const blocked = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } };
  assert.deepEqual(claimLegacyFocus(blocked, 'prod', 'a'), []);
  assert.deepEqual(readGuestFocus(blocked), []);
  assert.deepEqual(normalizeFocusedLabels([false, '', 'x', 'x', 'z'.repeat(257)]), ['x']);
  assert.deepEqual(changeFocusedLabel(['x', 'y'], 'x', false), ['y']);
  assert.deepEqual(changeFocusedLabel(['x', 'y'], 'x', true), ['x', 'y']);
  assert.deepEqual(readGuestFocus(browserFocusStorage()), []);
});
