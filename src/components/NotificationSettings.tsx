import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { defaultNotificationPreferences, noticesEnabled, type NotificationPreferences } from '../lib/taskNotifications';
import { notificationDesktop, notificationDeviceId, subscribeToNotifications, unsubscribeNotifications, webPushSupported } from '../lib/notificationClient';

export function NotificationSettings() {
  const { userId } = useAuth();
  const [deviceId] = useState(() => { try { return notificationDeviceId(userId!); } catch { return null; } });
  const saved = useQuery(api.notifications.state, deviceId ? { deviceId } : 'skip');
  const save = useMutation(api.notifications.save);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const desktop = !!notificationDesktop()?.notifyTask;
  const value = draft ?? saved?.preferences ?? defaultNotificationPreferences;
  const change = (patch: Partial<NotificationPreferences>) => { setDraft({ ...value, ...patch }); setMessage(''); };
  const submit = async () => {
    if (!deviceId || !saved) return;
    setBusy(true); setMessage('');
    try {
      let subscription;
      if (!desktop && noticesEnabled(value)) {
        if (!saved.webPushReady || !saved.publicKey) throw Error('プッシュ通知の配信設定が必要です。');
        subscription = (await subscribeToNotifications(saved.publicKey)).toJSON();
        if (!subscription.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) throw Error('通知の登録情報を取得できませんでした。');
      }
      if (!desktop && !noticesEnabled(value)) await unsubscribeNotifications();
      await save({ deviceId, platform: desktop ? 'desktop' : 'web', preferences: value,
        subscription: subscription ? { endpoint: subscription.endpoint!, keys: { auth: subscription.keys!.auth, p256dh: subscription.keys!.p256dh } } : undefined });
      setDraft(null); setMessage('この端末の通知設定を保存しました。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '通知設定を保存できませんでした。'); }
    finally { setBusy(false); }
  };
  return <div className="notification-settings">
    <p className="settings-muted">この端末で受け取る通知を選びます。時刻はアカウントのタイムゾーンに従います。</p>
    {!desktop ? <p className="settings-muted">iPhone・iPadはホーム画面に追加して開き、通知を許可してください。</p> : <p className="settings-muted">デスクトップ通知はアプリ起動中に届きます。macOSの通知設定でも許可してください。</p>}
    {!desktop && !webPushSupported() ? <p role="status">この画面ではプッシュ通知を利用できません。</p> : null}
    {!desktop && saved && !saved.webPushReady ? <p role="status">プッシュ通知は配信設定の準備中です。</p> : null}
    <fieldset aria-label="この端末の通知" disabled={busy || !deviceId || !saved}>
      <label><input type="checkbox" checked={value.deadline} onChange={e => change({ deadline: e.target.checked })} />時刻を指定した期限の30分前</label>
      <label><input type="checkbox" checked={value.morning} onChange={e => change({ morning: e.target.checked })} />朝のTodayまとめ（先頭タスク名も表示）</label>
      <label>通知する時刻<input type="time" aria-label="朝の通知時刻" value={value.morningTime} disabled={!value.morning} onChange={e => change({ morningTime: e.target.value })} /></label>
      <label><input type="checkbox" checked={value.completion} onChange={e => change({ completion: e.target.checked })} />エージェントがタスクを完了したとき</label>
      <button type="button" onClick={() => void submit()} disabled={busy || (!desktop && noticesEnabled(value) && (!webPushSupported() || !saved?.webPushReady))}>{busy ? '保存中…' : 'この端末に保存'}</button>
    </fieldset>
    {!deviceId ? <p role="alert">端末の保存領域を利用できません。</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
