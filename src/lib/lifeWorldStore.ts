import { useSyncExternalStore } from 'react';
import { newId } from './taskModel';
import { isDateString } from './taskDates';
import {
  coerceLifeData, emptyLifeData, lifeCheckKey, lifeEntriesForDate, mergeLifeData, restampLifeEntry,
  type LifeData, type LifeEntry, type LifeRepeat,
} from './lifeWorldModel';

export const LIFE_STORAGE_KEY = 'bizencore.life-world.local.v1';
export const LIFE_GUEST_OWNER_KEY = 'bizencore.life-world.guest-owner.v1';
export function lifeStorageKey(accountId: string | null) {
  return accountId ? `bizencore.life-world.account.${accountId}.v1` : LIFE_STORAGE_KEY;
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export type LifeSyncStatus = 'local' | 'loading' | 'pending' | 'synced' | 'error';
type Snapshot = { data: LifeData; canUndo: boolean; saveFailed: boolean; accountId: string | null; syncStatus: LifeSyncStatus; syncAttempt: number };

/** Each account has its own offline cache; guest data is imported only once. */
export function createLifeWorldStore(storage?: Storage) {
  let accountId: string | null = null;
  function read() {
    try { return coerceLifeData(JSON.parse(storage?.getItem(lifeStorageKey(accountId)) ?? 'null')); }
    catch { return emptyLifeData(); }
  }
  let state: Snapshot = { data: read(), canUndo: false, saveFailed: false, accountId, syncStatus: 'local', syncAttempt: 0 };
  const listeners = new Set<() => void>();
  const history: { before: LifeData; after: LifeData }[] = [];
  let lastEdit: { key?: string; at: number } | undefined;
  const undoStamps = new Set<number>();
  let stamp = 0;
  const nextStamp = () => {
    stamp = [...Object.values(state.data.entries), ...Object.values(state.data.checks)]
      .reduce((max, entry) => Math.max(max, entry.updatedAt + 1), Math.max(Date.now(), stamp + 1));
    return stamp;
  };
  const emit = () => { for (const listener of listeners) listener(); };
  function save(data: LifeData) {
    let saveFailed = typeof window !== 'undefined' && !storage;
    try { storage?.setItem(lifeStorageKey(accountId), JSON.stringify(data)); }
    catch { saveFailed = true; }
    state = { ...state, data, canUndo: history.length > 0, saveFailed };
    emit();
  }
  function change(update: (data: LifeData) => LifeData, key?: string) {
    const before = mergeLifeData(state.data, read());
    state = { ...state, data: before };
    const after = update(before);
    if (after === before) return;
    undoStamps.clear();
    const now = Date.now();
    if (key && lastEdit?.key === key && now - lastEdit.at < 900 && history.length) {
      history[history.length - 1].after = after;
    } else {
      history.push({ before, after });
      if (history.length > 60) history.shift();
    }
    lastEdit = { key, at: now };
    state = { ...state, syncStatus: accountId ? 'pending' : 'local' };
    save(after);
  }
  function edit(id: string, fields: Partial<Pick<LifeEntry, 'text' | 'note' | 'repeat'>>, key?: string) {
    change(data => {
      const entry = Object.hasOwn(data.entries, id) ? data.entries[id] : undefined;
      if (!entry || entry.deletedAt || Object.entries(fields).every(([k, v]) => entry[k as keyof LifeEntry] === v)) return data;
      return { ...data, entries: { ...data.entries, [id]: restampLifeEntry(entry, { ...entry, ...fields }, nextStamp()) } };
    }, key);
  }
  return {
    getSnapshot: () => state,
    getStorageKey: () => lifeStorageKey(accountId),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add(date: string, afterId?: string): string | undefined {
      if (!isDateString(date)) return;
      const id = newId();
      change(data => {
        const rows = lifeEntriesForDate(data, date);
        const index = afterId ? rows.findIndex(e => e.id === afterId) : rows.length - 1;
        const before = rows[index]?.order;
        const after = rows[index + 1]?.order;
        const order = before === undefined ? (after ?? 1) - 1 : after === undefined ? before + 1 : (before + after) / 2;
        const entry = restampLifeEntry(undefined, { id, text: '', note: '', startDate: date, repeat: 'once', order, updatedAt: 0 }, nextStamp());
        return { ...data, entries: { ...data.entries, [id]: entry } };
      });
      return id;
    },
    setText: (id: string, text: string) => edit(id, { text }, `text:${id}`),
    setNote: (id: string, note: string) => edit(id, { note }, `note:${id}`),
    setRepeat: (id: string, repeat: LifeRepeat) => edit(id, { repeat }),
    toggle(id: string, date: string) {
      change(data => {
        if (!lifeEntriesForDate(data, date).some(e => e.id === id)) return data;
        const key = lifeCheckKey(id, date);
        return { ...data, checks: { ...data.checks, [key]: { entryId: id, date, done: !data.checks[key]?.done, updatedAt: nextStamp() } } };
      });
    },
    move(id: string, date: string, direction: -1 | 1) {
      change(data => {
        const rows = lifeEntriesForDate(data, date);
        const index = rows.findIndex(e => e.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= rows.length) return data;
        [rows[index], rows[target]] = [rows[target], rows[index]];
        const entries = { ...data.entries };
        rows.forEach((entry, i) => { if (entry.order !== i) entries[entry.id] = restampLifeEntry(entry, { ...entry, order: i }, nextStamp()); });
        return { ...data, entries };
      });
    },
    remove(id: string) {
      change(data => {
        const entry = data.entries[id];
        if (!entry || entry.deletedAt) return data;
        const now = nextStamp();
        return { ...data, entries: { ...data.entries, [id]: restampLifeEntry(entry, { ...entry, deletedAt: now }, now) } };
      });
    },
    undo() {
      const previous = history.pop();
      if (!previous) return;
      lastEdit = undefined;
      const data = mergeLifeData(state.data, read());
      state = { ...state, data };
      const entries = { ...data.entries };
      const checks = { ...data.checks };
      for (const [id, after] of Object.entries(previous.after.entries)) {
        if (JSON.stringify(after) === JSON.stringify(previous.before.entries[id])) continue;
        // Do not undo another tab's later edit to the same entry.
        if (entries[id]?.updatedAt !== after.updatedAt && !undoStamps.has(entries[id]?.updatedAt)) continue;
        const before = previous.before.entries[id];
        const now = nextStamp();
        undoStamps.add(now);
        entries[id] = restampLifeEntry(entries[id], before ?? { ...after, deletedAt: now }, now);
      }
      for (const [key, after] of Object.entries(previous.after.checks)) {
        if (JSON.stringify(after) === JSON.stringify(previous.before.checks[key])) continue;
        if (checks[key]?.updatedAt !== after.updatedAt && !undoStamps.has(checks[key]?.updatedAt)) continue;
        const now = nextStamp();
        undoStamps.add(now);
        checks[key] = { ...(previous.before.checks[key] ?? { ...after, done: false }), updatedAt: now };
      }
      state = { ...state, syncStatus: accountId ? 'pending' : 'local' };
      save({ ...data, entries, checks });
    },
    setAccount(nextAccountId: string | null) {
      if (accountId === nextAccountId) return;
      accountId = nextAccountId;
      history.length = 0;
      lastEdit = undefined;
      undoStamps.clear();
      let data = read();
      let migrationFailed = false;
      if (accountId && storage) {
        try {
          if (!storage.getItem(LIFE_GUEST_OWNER_KEY)) {
            const guest = coerceLifeData(JSON.parse(storage.getItem(LIFE_STORAGE_KEY) ?? 'null'));
            // Claim before importing so another account can never receive the same guest data.
            storage.setItem(LIFE_GUEST_OWNER_KEY, accountId);
            data = mergeLifeData(data, guest);
          }
        } catch { migrationFailed = true; }
      }
      state = { data, accountId, canUndo: false, saveFailed: false, syncStatus: accountId ? 'loading' : 'local', syncAttempt: 0 };
      save(data);
      if (migrationFailed) { state = { ...state, saveFailed: true }; emit(); }
    },
    mergeRemote(remote: LifeData, expectedAccountId: string) {
      if (accountId !== expectedAccountId) return;
      const data = mergeLifeData(mergeLifeData(state.data, read()), coerceLifeData(remote));
      if (JSON.stringify(data) !== JSON.stringify(state.data)) save(data);
    },
    setSyncStatus(syncStatus: LifeSyncStatus, expectedAccountId: string | null) {
      if (accountId !== expectedAccountId || state.syncStatus === syncStatus) return;
      state = { ...state, syncStatus }; emit();
    },
    retrySync() { state = { ...state, syncAttempt: state.syncAttempt + 1 }; emit(); },
    reload() {
      const data = mergeLifeData(state.data, read());
      if (JSON.stringify(data) === JSON.stringify(state.data)) return;
      state = { ...state, data };
      emit();
    },
  };
}

let browserStorage: Storage | undefined;
try { if (typeof window !== 'undefined') browserStorage = window.localStorage; } catch { /* In-memory trial still works. */ }
export const lifeWorldStore = createLifeWorldStore(browserStorage);
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === lifeWorldStore.getStorageKey()) lifeWorldStore.reload();
  });
}
export function useLifeWorldState() {
  return useSyncExternalStore(lifeWorldStore.subscribe, lifeWorldStore.getSnapshot, lifeWorldStore.getSnapshot);
}
