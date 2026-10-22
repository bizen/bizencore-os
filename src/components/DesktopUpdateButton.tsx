import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { prepareAppReload } from '../lib/prepareAppReload';

type UpdateBridge = {
  checkUpdate?: () => Promise<{ version: string } | null>;
  openUpdate?: () => Promise<void>;
  downloadUpdate?: () => Promise<{ version: string }>;
  installUpdate?: () => Promise<boolean>;
  onUpdateProgress?: (callback: (percent: number) => void) => () => void;
};
const updateBridge = () => (window as Window & { bizencoreDesktop?: UpdateBridge }).bizencoreDesktop;
type UpdateState = { version: string | null; stage: 'available' | 'downloading' | 'ready' | 'installing'; percent: number };

export function DesktopUpdateButton() {
  const inFlight = useRef(false);
  const [state, setState] = useState<UpdateState>({ version: null, stage: 'available', percent: 0 });
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
        if (!stopped && navigator.onLine) setState(current => current.stage === 'available' ? { ...current, version: release?.version ?? null } : current);
      } catch { /* Retain a downloaded update while offline. */ }
      finally { pending = false; }
    };
    const offline = () => setState(current => current.stage === 'available' ? { ...current, version: null } : current);
    const unsubscribe = bridge.onUpdateProgress?.(percent => {
      if (!stopped && Number.isInteger(percent) && percent >= 0 && percent <= 100) {
        setState(current => current.stage === 'downloading' ? { ...current, percent } : current);
      }
    });
    const timer = window.setInterval(() => void check(), 5 * 60_000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', check);
    void check();
    return () => {
      stopped = true; unsubscribe?.(); window.clearInterval(timer);
      window.removeEventListener('focus', check); window.removeEventListener('online', check);
      window.removeEventListener('offline', offline); document.removeEventListener('visibilitychange', check);
    };
  }, []);
  if (!state.version) return null;
  const bridge = updateBridge();
  const automatic = !!bridge?.downloadUpdate && !!bridge.installUpdate;
  const label = state.stage === 'downloading' ? `新版 ${state.version} をダウンロード中 ${state.percent}%`
    : state.stage === 'ready' ? `再起動して ${state.version} に更新`
    : state.stage === 'installing' ? 'アプリを更新しています'
    : `新版 ${state.version} ${automatic ? 'をダウンロード' : 'の配布ページを開く'}`;
  const busy = state.stage === 'downloading' || state.stage === 'installing';
  return <button type="button" className="app-settings-btn app-update-btn" aria-label={label} title={label}
    disabled={busy} aria-busy={busy} onClick={async () => {
      if (inFlight.current) return;
      if (!automatic) { try { await bridge?.openUpdate?.(); } catch { window.alert('配布ページを開けませんでした。'); } return; }
      if (state.stage === 'ready') {
        if (!prepareAppReload()) return;
        inFlight.current = true;
        setState(current => ({ ...current, stage: 'installing' }));
        let approved = false;
        try { approved = await bridge.installUpdate!(); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          const marker = 'BIZENCORE_UPDATE:';
          window.alert(message.includes(marker) ? message.slice(message.indexOf(marker) + marker.length)
            : message.includes('サインイン') ? '更新前にサインインを確認してください。アプリを開き直してから再試行してください。'
            : '更新処理を完了できませんでした。更新ログ（desktop-update.log）を確認してください。');
        }
        if (!approved) { inFlight.current = false; setState(current => ({ ...current, stage: 'ready' })); }
      } else {
        inFlight.current = true;
        setState(current => ({ ...current, stage: 'downloading', percent: 0 }));
        try {
          const release = await bridge.downloadUpdate!();
          setState({ version: release.version, stage: 'ready', percent: 100 });
        } catch {
          setState(current => ({ ...current, stage: 'available' }));
          window.alert('新版を取得できませんでした。通信と保存容量を確認して再試行してください。');
        } finally { inFlight.current = false; }
      }
    }}><RefreshCw size={17} aria-hidden />{state.stage === 'downloading' ? <span aria-live="polite">{state.percent}%</span> : null}</button>;
}
