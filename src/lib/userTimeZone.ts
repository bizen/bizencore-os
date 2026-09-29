import { useSyncExternalStore } from 'react';

let savedTimeZone: string | null = null;
const listeners = new Set<() => void>();

export function setUserTimeZone(value: string | null): void {
  if (savedTimeZone === value) return;
  savedTimeZone = value;
  for (const listener of listeners) listener();
}

export function useUserTimeZone(): string | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => savedTimeZone,
    () => null
  );
}
