import { useSyncExternalStore } from 'react';

export type MascotStyle = 'matte' | 'flat';
const STORAGE_KEY = 'bizencore.mascotStyle';

export function readMascotStyle(): MascotStyle {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'flat') return 'flat';
  } catch {
    // Embedded hosts may block storage; keep the default usable there.
  }
  return 'matte';
}

let current = readMascotStyle();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function saveMascotStyle(style: MascotStyle): void {
  current = style;
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // The current window still switches when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function useMascotStyle(): MascotStyle {
  return useSyncExternalStore(subscribe, () => current, () => 'matte');
}
