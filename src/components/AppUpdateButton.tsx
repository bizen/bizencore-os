import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { APP_BUILD_ID, fetchPublishedBuild, watchForAppUpdate } from '../lib/appUpdate';
import { prepareAppReload } from '../lib/prepareAppReload';

export function AppUpdateButton() {
  const [available, setAvailable] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const composing = useRef(false);
  const updating = useRef(false);
  useEffect(() => watchForAppUpdate(APP_BUILD_ID, setAvailable), []);
  useEffect(() => {
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; };
    document.addEventListener('compositionstart', start);
    document.addEventListener('compositionend', end);
    return () => {
      document.removeEventListener('compositionstart', start);
      document.removeEventListener('compositionend', end);
    };
  }, []);

  const update = async () => {
    if (updating.current || composing.current) return;
    updating.current = true;
    setChecking(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      if (!navigator.onLine) throw new Error('Offline');
      const published = await fetchPublishedBuild(controller.signal);
      if (published === APP_BUILD_ID) { setAvailable(null); return; }
      if (composing.current) return;
      // Commit blur-based inputs before checking that current edits are persisted.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (prepareAppReload()) window.location.reload();
    } catch {
      window.alert('新版を確認できませんでした。接続を確認して、もう一度お試しください。');
    } finally {
      window.clearTimeout(timeout);
      updating.current = false;
      setChecking(false);
    }
  };

  if (!available) return null;
  return <button type="button" className="app-settings-btn app-update-btn" onClick={update}
    disabled={checking} aria-busy={checking} aria-label="新版に更新" title="新版に更新">
    <RefreshCw size={17} aria-hidden />
  </button>;
}
