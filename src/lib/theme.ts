export type Theme = 'original' | 'black' | 'white';

const STORAGE_KEY = 'bizencore.theme';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'original' || saved === 'black' || saved === 'white') return saved;
  } catch {
    // Embedded hosts may block storage; use the same default there.
  }
  return 'black';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'white' ? 'light' : 'dark';
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The in-memory choice still works for this tab.
  }
}
