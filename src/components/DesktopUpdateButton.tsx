import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

type UpdateBridge = {
  checkUpdate?: () => Promise<{ version: string } | null>;
  openUpdate?: () => Promise<void>;
};
const updateBridge = () => (window as Window & { bizencoreDesktop?: UpdateBridge }).bizencoreDesktop;

export function DesktopUpdateButton() {
  const [version, setVersion] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const bridge = updateBridge();
    if (!bridge?.checkUpdate || !bridge.openUpdate) return;
    let stopped = false;
    let pending = false;
    const check = async () => {
      if (stopped || pending || document.visibilityState !== 'visible' || !navigator.onLine) return;
      pending = true;
      try {
        const release = await bridge.checkUpdate!();
        if (!stopped && navigator.onLine) setVersion(release?.version ?? null);
      } catch { if (!stopped) setVersion(null); }
      finally { pending = false; }
    };
    const offline = () => setVersion(null);
    const timer = window.setInterval(() => void check(), 5 * 60_000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', check);
    void check();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  if (!version) return null;
  const label = `新版 ${version} の配布ページを開く`;
  return <button type="button" className="app-settings-btn app-update-btn" aria-label={label} title={label}
    disabled={opening} aria-busy={opening} onClick={() => {
      setOpening(true);
      void updateBridge()?.openUpdate?.().catch(() => {
        window.alert('配布ページを開けませんでした。もう一度お試しください。');
      }).finally(() => setOpening(false));
    }}><RefreshCw size={17} aria-hidden /></button>;
}
