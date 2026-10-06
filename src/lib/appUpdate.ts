export const APP_BUILD_ID: string = import.meta.env.VITE_APP_BUILD_ID ?? '';
const CHECK_INTERVAL_MS = 3 * 60_000;
const CHECK_COOLDOWN_MS = 10_000;

export async function fetchPublishedBuild(signal: AbortSignal): Promise<string> {
  const response = await fetch('/version.json', { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Version unavailable');
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('buildId' in data) ||
    typeof data.buildId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.buildId)) {
    throw new Error('Invalid version');
  }
  return data.buildId;
}

export function watchForAppUpdate(currentBuild: string, notify: (buildId: string | null) => void): () => void {
  if (!currentBuild) return () => {};
  let stopped = false;
  let request: AbortController | null = null;
  let lastCheck = -Infinity;
  const check = async () => {
    if (stopped || request || document.visibilityState !== 'visible' || !navigator.onLine ||
      Date.now() - lastCheck < CHECK_COOLDOWN_MS) return;
    lastCheck = Date.now();
    const controller = new AbortController();
    request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const published = await fetchPublishedBuild(controller.signal);
      if (!stopped && navigator.onLine) notify(published === currentBuild ? null : published);
    } catch {
      // A missing endpoint, offline device or failed deploy is not an update.
      if (!stopped) notify(null);
    } finally {
      window.clearTimeout(timeout);
      request = null;
    }
  };
  const offline = () => { lastCheck = -Infinity; request?.abort(); notify(null); };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  window.addEventListener('online', check);
  window.addEventListener('offline', offline);
  const timer = window.setInterval(check, CHECK_INTERVAL_MS);
  void check();
  return () => {
    stopped = true;
    request?.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('pageshow', check);
    window.removeEventListener('online', check);
    window.removeEventListener('offline', offline);
  };
}
