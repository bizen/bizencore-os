import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const model = await load('src/lib/lifeWorldModel.ts');
const { createLifeWorldStore, LIFE_STORAGE_KEY } = await load('src/lib/lifeWorldStore.ts');
function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test('habit history edits one scheduled day in the last seven days without changing descendants or other days', () => {
  const storage = memoryStorage(), store = createLifeWorldStore(storage), today = '2026-10-07';
  const habit = store.add('2026-10-01'); store.setRepeat(habit, 'daily');
  const child = store.add('2026-10-01', habit, true, true); store.setRepeat(child, 'once');
  store.setHabitDayDone(habit, today, true, today); store.fileCompleted(today);
  const todayCheck = store.getSnapshot().data.checks[model.lifeCheckKey(habit, today)];
  assert.deepEqual(model.partitionLifeRows(store.getSnapshot().data, today, true).active.map(row => row.entry.id), [habit, child],
    'filing a completed container does not hide its unfinished child');
  store.setHabitDayDone(habit, '2026-10-01', true, today);
  let data = store.getSnapshot().data;
  assert.equal(data.checks[model.lifeCheckKey(habit, '2026-10-01')].done, true, 'oldest visible day is editable');
  assert.deepEqual(data.checks[model.lifeCheckKey(habit, today)], todayCheck, 'today stays filed and complete');
  assert.equal(model.lifeEntryDone(data, data.entries[child], today), false, 'one-off child is untouched');
  const saved = JSON.stringify(data); store.setHabitDayDone(habit, '2026-10-01', true, today);
  assert.equal(JSON.stringify(store.getSnapshot().data), saved, 'setting the same value is a no-op');
  for (const invalid of ['2026-09-30', '2026-10-08', '2026-02-30']) store.setHabitDayDone(habit, invalid, true, today);
  store.setHabitDayDone(child, '2026-10-01', true, today);
  assert.equal(JSON.stringify(store.getSnapshot().data), saved, 'out-of-range, invalid and one-off edits are rejected');
  store.setHabitDayDone(habit, today, false, today); data = store.getSnapshot().data;
  assert.equal(data.checks[model.lifeCheckKey(habit, today)].filed, undefined, 'unchecking restores a filed habit');
  assert.equal(data.checks[model.lifeCheckKey(habit, '2026-10-01')].done, true);
  store.undo(); assert.deepEqual(store.getSnapshot().data.checks[model.lifeCheckKey(habit, today)].done, true);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, today)].filed, true);
  const reopened = createLifeWorldStore(storage);
  assert.equal(model.lifeWeek(reopened.getSnapshot().data, reopened.getSnapshot().data.entries[habit], today).filter(day => day.done).length, 2);
});

test('habit history rejects unscheduled, pre-creation, deleted and locked days and respects subtree completion locks', () => {
  const store = createLifeWorldStore(memoryStorage()), today = '2026-10-07';
  const habit = store.add('2026-10-01'); store.setRepeat(habit, 'weekdays');
  for (const date of ['2026-10-03', '2026-10-04', '2026-09-30']) store.setHabitDayDone(habit, date, true, today);
  assert.deepEqual(store.getSnapshot().data.checks, {});
  store.setHabitDayDone(habit, '2026-10-02', true, today);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, '2026-10-02')].done, true);
  const child = store.add('2026-10-01', habit, true, true); store.setLocked(child, true, today);
  store.setHabitDayDone(habit, '2026-10-05', true, today);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, '2026-10-05')], undefined);
  store.setHabitDayDone(habit, '2026-10-02', false, today);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, '2026-10-02')].done, false, 'existing history can be unchecked without completing a locked subtree');
  store.setLocked(habit, true, today); store.setHabitDayDone(habit, '2026-10-06', true, today);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, '2026-10-06')], undefined);
  store.setLocked(habit, false, today); store.remove(habit); store.setHabitDayDone(habit, today, true, today);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(habit, today)], undefined);
});

test('filing moves only completed life tasks, carries single tasks forward and leaves daily checks intact', () => {
  const storage = memoryStorage(), store = createLifeWorldStore(storage), date = '2026-10-05';
  const wish = store.add(date), habit = store.add(date), unfinished = store.add(date), locked = store.add(date);
  store.setRepeat(habit, 'daily'); store.setLocked(locked, true, date);
  store.toggle(wish, date); store.toggle(habit, date);
  const history = model.lifeWeek(store.getSnapshot().data, store.getSnapshot().data.entries[habit], date);
  store.fileCompleted('2026-02-30');
  assert.equal(model.partitionLifeRows(store.getSnapshot().data, date, true).done.length, 0);
  store.fileCompleted(date);
  let data = store.getSnapshot().data;
  assert.deepEqual(model.partitionLifeRows(data, date, true).active.map(row => row.entry.id), [unfinished, locked]);
  assert.deepEqual(model.partitionLifeRows(data, date, true).done.map(row => row.entry.id), [wish, habit]);
  assert.deepEqual(model.lifeWeek(data, data.entries[habit], date), history, 'streak is unchanged');
  assert.equal(Object.values(data.entries).some(entry => entry.deletedAt), false, 'filing is not deletion');
  const before = JSON.stringify(data); store.fileCompleted(date);
  assert.equal(JSON.stringify(store.getSnapshot().data), before, 'repeated filing is a no-op');
  store.undo();
  assert.equal(model.partitionLifeRows(store.getSnapshot().data, date, true).done.length, 0, 'one undo restores the filing batch');
  store.fileCompleted(date);
  const reopened = createLifeWorldStore(storage); data = reopened.getSnapshot().data;
  assert.deepEqual(model.partitionLifeRows(data, '2026-10-06', true).done.map(row => row.entry.id), [wish]);
  assert.equal(model.lifeEntryDone(data, data.entries[habit], '2026-10-06'), false);
  assert.equal(model.lifeEntryDone(data, data.entries[habit], date), true);
  reopened.toggle(wish, '2026-10-06'); data = reopened.getSnapshot().data;
  assert.equal(model.lifeEntryFiled(data, data.entries[wish], '2026-10-06'), false, 'unchecking restores the original position');
  assert.equal(model.lifeEntryFiled(data, data.entries[wish], date), true, 'history stays filed');
});

test('completed life subtasks can be filed under an unfinished or locked parent without losing hierarchy', () => {
  const store = createLifeWorldStore(memoryStorage()), date = '2026-10-05';
  const parent = store.add(date); store.setText(parent, '買い物'); store.setLocked(parent, true, date);
  const child = store.add(date, parent, true, true); store.setText(child, '牛乳');
  const other = store.add(date, child, true); store.setText(other, 'パン');
  store.toggle(child, date, true); store.fileCompleted(date);
  let parts = model.partitionLifeRows(store.getSnapshot().data, date, true);
  assert.deepEqual(parts.active.map(row => [row.entry.id, row.depth]), [[parent, 0], [other, 1]]);
  assert.deepEqual(parts.done.map(row => [row.entry.id, row.depth, row.context]), [[child, 0, '生活世界 › 買い物']]);
  store.toggle(child, date, true);
  parts = model.partitionLifeRows(store.getSnapshot().data, date, true);
  assert.deepEqual(parts.active.map(row => [row.entry.id, row.depth]), [[parent, 0], [child, 1], [other, 1]]);
  assert.equal(parts.done.length, 0);
  store.setLocked(parent, false, date); store.toggle(parent, date, true); store.fileCompleted(date);
  parts = model.partitionLifeRows(store.getSnapshot().data, date, true);
  assert.equal(parts.active.length, 0);
  assert.deepEqual(parts.done.map(row => [row.entry.id, row.depth]), [[parent, 0], [child, 1], [other, 1]]);
});

test('persistent wishes and habits share a list without creating daily duplicate tasks', () => {
  const storage = memoryStorage();
  const store = createLifeWorldStore(storage);
  const wish = store.add('2026-10-05');
  store.setText(wish, 'フォーを食べたい');
  const habit = store.add('2026-10-05');
  store.setText(habit, 'ストレッチ');
  store.setRepeat(habit, 'daily');
  const data = store.getSnapshot().data;
  assert.deepEqual(model.lifeEntriesForDate(data, '2026-10-05').map(e => e.id), [wish, habit]);
  assert.deepEqual(model.lifeEntriesForDate(data, '2026-10-06').map(e => e.id), [wish, habit]);
  assert.deepEqual(model.lifeEntriesForDate(data, '2026-10-04'), []);
  for (let day = 1; day <= 28; day++) model.lifeEntriesForDate(data, `2027-02-${String(day).padStart(2, '0')}`);
  assert.equal(Object.keys(data.entries).length, 2);
  assert.deepEqual([...storage.data.keys()], [LIFE_STORAGE_KEY]);
});

test('habit completion is per day and survives reloading without resetting yesterday', () => {
  const storage = memoryStorage();
  let store = createLifeWorldStore(storage);
  const id = store.add('2026-10-05');
  store.setRepeat(id, 'daily');
  store.toggle(id, '2026-10-05');
  const key = date => model.lifeCheckKey(id, date);
  assert.equal(store.getSnapshot().data.checks[key('2026-10-05')].done, true);
  assert.equal(store.getSnapshot().data.checks[key('2026-10-06')], undefined);
  store = createLifeWorldStore(storage);
  store.toggle(id, '2026-10-06');
  assert.equal(store.getSnapshot().data.checks[key('2026-10-05')].done, true);
  assert.equal(store.getSnapshot().data.checks[key('2026-10-06')].done, true);
  store.toggle(id, '2026-10-06');
  assert.equal(store.getSnapshot().data.checks[key('2026-10-06')].done, false);
  assert.equal(store.getSnapshot().data.checks[key('2026-10-05')].done, true);
});

test('weekdays respect calendar dates, and edits/notes/ordering persist', () => {
  const store = createLifeWorldStore(memoryStorage());
  const id = store.add('2026-10-05');
  store.setRepeat(id, 'weekdays');
  store.setNote(id, '気楽に');
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-09').length, 1);
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-10').length, 0);
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-11').length, 0);
  const second = store.add('2026-10-05');
  const third = store.add('2026-10-05', id);
  assert.deepEqual(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-05').map(e => e.id), [id, third, second]);
  store.move(second, '2026-10-05', -1);
  assert.deepEqual(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-05').map(e => e.id), [id, second, third]);
  assert.equal(store.getSnapshot().data.entries[id].note, '気楽に');
  assert.equal(model.shiftLifeDate('2026-12-31', 1), '2027-01-01');
  assert.equal(model.shiftLifeDate('2028-03-01', -1), '2028-02-29');
});

test('deleting a habit is recoverable, preserves its checks, and supports consecutive undo', () => {
  const store = createLifeWorldStore(memoryStorage());
  const id = store.add('2026-10-05');
  store.setText(id, '読む');
  store.setRepeat(id, 'daily');
  store.toggle(id, '2026-10-05');
  store.remove(id);
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-06').length, 0);
  store.undo();
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-06').length, 1);
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(id, '2026-10-05')].done, true);
  store.undo();
  assert.equal(store.getSnapshot().data.checks[model.lifeCheckKey(id, '2026-10-05')].done, false);
  store.undo();
  assert.equal(store.getSnapshot().data.entries[id].repeat, 'once');
  store.undo();
  assert.equal(store.getSnapshot().data.entries[id].text, '');
  store.undo();
  assert.equal(model.lifeEntriesForDate(store.getSnapshot().data, '2026-10-05').length, 0);
});

test('multiple tabs keep independent rows and checks and do not resurrect deleted entries', () => {
  const storage = memoryStorage();
  const a = createLifeWorldStore(storage);
  const b = createLifeWorldStore(storage);
  const id = a.add('2026-10-05');
  a.setRepeat(id, 'daily');
  const other = b.add('2026-10-05');
  b.setText(other, 'フォー');
  a.toggle(id, '2026-10-05');
  b.toggle(id, '2026-10-06');
  a.reload();
  assert.equal(Object.keys(a.getSnapshot().data.entries).length, 2);
  assert.equal(Object.values(a.getSnapshot().data.checks).filter(c => c.done).length, 2);
  a.remove(id);
  b.setText(other, 'フォーを食べる');
  b.reload();
  assert.ok(b.getSnapshot().data.entries[id].deletedAt);
  const stale = createLifeWorldStore(storage);
  stale.setText(other, '別タブから変更');
  b.undo();
  assert.equal(b.getSnapshot().data.entries[other].text, '別タブから変更');
});

test('malformed storage and invalid dates do not create invalid tasks, and save errors are visible', () => {
  for (const bad of [null, [], { version: 99 }, { version: 1, entries: { x: { id: 'x', text: 'x', startDate: '2026-02-30', repeat: 'daily', order: 1, updatedAt: 1 } } }]) {
    assert.deepEqual(model.coerceLifeData(bad), model.emptyLifeData());
  }
  const store = createLifeWorldStore({ getItem: () => '{bad json', setItem: () => { throw new Error('quota'); } });
  assert.equal(store.add('2026-02-30'), undefined);
  const id = store.add('2026-10-05');
  assert.ok(id);
  assert.equal(store.getSnapshot().saveFailed, true);
  store.toggle(id, '2026-02-30');
  assert.deepEqual(store.getSnapshot().data.checks, {});
});

test('life world is opt-in for All and uses its own account sync rather than the ordinary task stream', async () => {
  const page = await readFile('src/pages/TasksPage.tsx', 'utf8');
  const bridge = await readFile('src/components/SyncBridge.tsx', 'utf8');
  const store = await readFile('src/lib/lifeWorldStore.ts', 'utf8');
  assert.match(page, /view === 'today' \? <LifeWorld todayDate=\{todayDate\}/);
  assert.match(page, /view === 'all' && lifeData.preferences\?\.showInAll === true/);
  assert.doesNotMatch(bridge, /lifeWorldStore|LIFE_STORAGE_KEY/);
  assert.match(bridge, /LifeWorldSyncBridge/);
  assert.doesNotMatch(store, /useMutation|convex\/react|api\.sync|taskStore\./);
});

test('single tasks and their completion carry forward, including existing date-check data', () => {
  const storage = memoryStorage();
  const store = createLifeWorldStore(storage);
  const id = store.add('2026-10-05');
  store.setText(id, 'Grocery shopping');
  store.toggle(id, '2026-10-05');
  assert.equal(model.lifeEntryDone(store.getSnapshot().data, store.getSnapshot().data.entries[id], '2026-10-06'), true);
  const reopened = createLifeWorldStore(storage);
  reopened.toggle(id, '2026-10-07');
  assert.equal(model.lifeEntryDone(reopened.getSnapshot().data, reopened.getSnapshot().data.entries[id], '2026-10-08'), false);
  assert.equal(model.lifeEntryDone(reopened.getSnapshot().data, reopened.getSnapshot().data.entries[id], '2026-10-06'), true, 'historical completion remains');
  assert.equal(model.lifeEntriesForDate(reopened.getSnapshot().data, '2027-01-01').length, 1);
});

test('locked life tasks have no completion, persist across days and survive reload/undo and legacy edits', () => {
  const storage = memoryStorage();
  const store = createLifeWorldStore(storage);
  const id = store.add('2026-10-05');
  store.setLocked(id, true, '2026-10-05');
  assert.equal(store.getSnapshot().data.entries[id].locked, true);
  store.toggle(id, '2026-10-06');
  assert.deepEqual(store.getSnapshot().data.checks, {});
  const reopened = createLifeWorldStore(storage);
  assert.equal(reopened.getSnapshot().data.entries[id].locked, true);
  reopened.setLocked(id, false, '2026-10-06');
  reopened.undo();
  assert.equal(reopened.getSnapshot().data.entries[id].locked, true);
  const locked = reopened.getSnapshot().data.entries[id];
  const legacy = { ...locked, locked: undefined, stamps: undefined, text: '別の端末からのメモ', updatedAt: locked.updatedAt + 10 };
  const merged = model.mergeLifeEntry(locked, legacy);
  assert.equal(merged.locked, true, 'old clients cannot clear a lock by editing another field');
  assert.equal(merged.text, legacy.text);
  reopened.setLocked(id, false, '2026-10-06');
  reopened.toggle(id, '2026-10-06');
  reopened.setLocked(id, true, '2026-10-06');
  assert.equal(!!reopened.getSnapshot().data.entries[id].locked, false, 'completed tasks cannot be locked');
});

test('All visibility defaults off, whole-label placement and visibility merge independently and isolate accounts', () => {
  const storage = memoryStorage();
  const a = createLifeWorldStore(storage);
  assert.equal(a.getSnapshot().data.preferences?.showInAll ?? false, false);
  a.setAccount('a');
  a.setShowInAll(true);
  a.moveSection(['a', 'b', 'c'], -1);
  assert.equal(a.getSnapshot().data.preferences.beforeId, 'c');
  a.moveSection(['a', 'b', 'c'], -1);
  assert.equal(a.getSnapshot().data.preferences.beforeId, 'b');
  a.setShowInAll(false);
  a.setShowInAll(true);
  assert.equal(a.getSnapshot().data.preferences.beforeId, 'b');
  const rows = [{ depth: 0, item: { id: 'a' } }, { depth: 1, item: { id: 'task' } }, { depth: 0, item: { id: 'b' } }];
  assert.equal(model.lifeSectionIndex(rows, 'b'), 2);
  assert.equal(model.lifeSectionIndex(rows, 'missing'), 3);
  const p = a.getSnapshot().data.preferences;
  const visibility = { ...p, showInAll: false, visibilityStamp: p.updatedAt + 10, updatedAt: p.updatedAt + 10 };
  const placement = { ...p, beforeId: 'a', placementStamp: p.updatedAt + 20, updatedAt: p.updatedAt + 20 };
  const merged = model.mergeLifePreferences(visibility, placement);
  assert.equal(merged.showInAll, false);
  assert.equal(merged.beforeId, 'a');
  assert.deepEqual(model.mergeLifePreferences(placement, visibility), merged);
  const reopened = createLifeWorldStore(storage); reopened.setAccount('a');
  assert.equal(reopened.getSnapshot().data.preferences.showInAll, true);
  reopened.setAccount('b');
  assert.equal(reopened.getSnapshot().data.preferences, undefined);
});

test('concurrent lock/completion converges without a permanently rejected sync batch', () => {
  const entry = { id: 'shopping', text: '買い物', note: '', startDate: '2026-10-05', repeat: 'once', order: 0,
    updatedAt: 200, locked: true, stamps: { lock: 200 } };
  const check = { entryId: entry.id, date: '2026-10-06', done: true, updatedAt: 201 };
  const locked = { version: 1, entries: { [entry.id]: entry }, checks: {} };
  const completed = { version: 1, entries: {}, checks: { [model.lifeCheckKey(entry.id, check.date)]: check } };
  const merged = model.mergeLifeData(locked, completed);
  assert.equal(merged.checks[model.lifeCheckKey(entry.id, check.date)].done, false);
  assert.deepEqual(model.mergeLifeData(completed, locked), merged);
  assert.deepEqual(model.coerceLifeData(merged), model.coerceLifeData({ ...locked, checks: completed.checks }));
});

test('seven circles end today and distinguish completed, missed and unscheduled dates', () => {
  const store = createLifeWorldStore(memoryStorage());
  const id = store.add('2026-10-01');
  store.setRepeat(id, 'weekdays');
  store.toggle(id, '2026-10-01');
  store.toggle(id, '2026-10-05');
  const data = store.getSnapshot().data;
  const week = model.lifeWeek(data, data.entries[id], '2026-10-05');
  assert.equal(week.length, 7);
  assert.deepEqual(week.map(d => d.date), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(week.map(d => d.scheduled), [false, false, true, true, false, false, true]);
  assert.deepEqual(week.map(d => d.done), [false, false, true, false, false, false, true]);
  assert.deepEqual(week.map(d => d.today), [false, false, false, false, false, false, true]);
});

test('account caches isolate guest data, sign-out, account switches and late responses', () => {
  const storage = memoryStorage();
  const store = createLifeWorldStore(storage);
  const guest = store.add('2026-10-05');
  store.setText(guest, 'ゲストのフォー');
  store.setAccount('user-a');
  assert.equal(store.getSnapshot().data.entries[guest].text, 'ゲストのフォー');
  store.setText(guest, 'アカウントAのフォー');
  const dataA = store.getSnapshot().data;
  store.setAccount('user-b');
  assert.deepEqual(store.getSnapshot().data.entries, {});
  store.mergeRemote(dataA, 'user-a');
  store.setSyncStatus('synced', 'user-a');
  assert.deepEqual(store.getSnapshot().data.entries, {});
  assert.equal(store.getSnapshot().syncStatus, 'loading');
  assert.equal(store.getSnapshot().canUndo, false);
  store.setAccount(null);
  assert.equal(store.getSnapshot().data.entries[guest].text, 'ゲストのフォー');
  assert.equal(store.getSnapshot().syncStatus, 'local');
  const reopened = createLifeWorldStore(storage);
  reopened.setAccount('user-a');
  assert.equal(reopened.getSnapshot().data.entries[guest].text, 'アカウントAのフォー');
});

test('entry field merges keep independent offline text and note edits', () => {
  const base = model.restampLifeEntry(undefined, { id: 'habit', text: '読む', note: '', startDate: '2026-10-01', repeat: 'daily', order: 0, updatedAt: 1 }, 100);
  const a = model.restampLifeEntry(base, { ...base, text: '本を読む' }, 200);
  const b = model.restampLifeEntry(base, { ...base, note: '短くてもいい' }, 210);
  const merged = model.mergeLifeEntry(a, b);
  assert.equal(merged.text, '本を読む');
  assert.equal(merged.note, '短くてもいい');
  assert.deepEqual(model.mergeLifeEntry(b, a), merged);
  const data = { version: 1, entries: { habit: merged }, checks: {} };
  assert.deepEqual(model.lifePendingChanges(data, model.coerceLifeData(data)), { entries: [], checks: [] });
});
