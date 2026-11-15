export type UiPrefs = { version: 1; terminalFontSize: number; completionNotifications: boolean };
export const defaultUiPrefs: UiPrefs = { version: 1, terminalFontSize: 13, completionNotifications: false };
export function uiPrefsKey(account: string, environment: string): string {
  return `bizencore.desktop.ui.v1:${encodeURIComponent(environment)}:${encodeURIComponent(account)}`;
}
export function normalizeUiPrefs(value: unknown): UiPrefs {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return { ...defaultUiPrefs };
  const raw = value as Record<string, unknown>;
  return {
    version: 1,
    terminalFontSize: typeof raw.terminalFontSize === 'number' && Number.isFinite(raw.terminalFontSize) ? Math.max(10, Math.min(24, Math.round(raw.terminalFontSize))) : 13,
    completionNotifications: raw.completionNotifications === true,
  };
}
export function readUiPrefs(key: string): UiPrefs {
  try {
    const saved = localStorage.getItem(key);
    return saved && saved.length <= 1024 ? normalizeUiPrefs(JSON.parse(saved)) : { ...defaultUiPrefs };
  } catch { return { ...defaultUiPrefs }; }
}
export function writeUiPrefs(key: string, value: UiPrefs): boolean {
  try { localStorage.setItem(key, JSON.stringify(normalizeUiPrefs(value))); return true; }
  catch { return false; }
}
