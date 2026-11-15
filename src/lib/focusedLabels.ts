export const LEGACY_FOCUS_KEY = 'chrct.tasks.focusedLabels';
export const GUEST_FOCUS_KEY = 'chrct.tasks.focusedLabels.guest';
const LEGACY_OWNER_KEY = 'chrct.tasks.focusedLabels.owner';
export const MAX_FOCUSED_LABELS = 512;

interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function browserFocusStorage(): Storage {
  try { return window.localStorage; }
  catch { return { getItem: () => null, setItem: () => {} }; }
}

export const focusCacheKey = (scope: string, accountId: string) =>
  `chrct.tasks.focusedLabels.account.${JSON.stringify([scope, accountId])}`;

export function normalizeFocusedLabels(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, MAX_FOCUSED_LABELS) : [];
}

export function changeFocusedLabel(ids: readonly string[], labelId: string, focused: boolean): string[] {
  if (!focused) return ids.filter(id => id !== labelId);
  return ids.includes(labelId) ? [...ids] : [...ids, labelId];
}

export function readFocusCache(storage: Storage, key: string): string[] {
  try { return normalizeFocusedLabels(JSON.parse(storage.getItem(key) ?? '[]')); }
  catch { return []; }
}

export function readGuestFocus(storage: Storage): string[] {
  try {
    if (storage.getItem(GUEST_FOCUS_KEY) !== null) return readFocusCache(storage, GUEST_FOCUS_KEY);
    return storage.getItem(LEGACY_OWNER_KEY) ? [] : readFocusCache(storage, LEGACY_FOCUS_KEY);
  } catch { return []; }
}

// The old shared preference can migrate to one account, never to every subsequent sign-in.
export function claimLegacyFocus(storage: Storage, scope: string, accountId: string): string[] {
  const owner = focusCacheKey(scope, accountId);
  try {
    const claimed = storage.getItem(LEGACY_OWNER_KEY);
    if (claimed && claimed !== owner) return [];
    if (!claimed) storage.setItem(LEGACY_OWNER_KEY, owner);
    return storage.getItem(GUEST_FOCUS_KEY) !== null
      ? readFocusCache(storage, GUEST_FOCUS_KEY) : readFocusCache(storage, LEGACY_FOCUS_KEY);
  } catch { return []; }
}
