export type DesktopTaskNotice = { id: string; title: string; body: string; taskId?: string };
type NotificationDesktopBridge = { notifyTask?: (notice: DesktopTaskNotice) => Promise<boolean>; onOpenTask?: (callback: (taskId: string | null) => void) => () => void };
export const notificationDesktop = () => (window as Window & { bizencoreDesktop?: NotificationDesktopBridge }).bizencoreDesktop;
export function notificationDeviceId(userId: string): string {
  const key = `bizencore.notifications.device:${userId}`;
  const existing = localStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const id = crypto.randomUUID(); localStorage.setItem(key, id); return id;
}
export function webPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
export async function subscribeToNotifications(publicKey: string): Promise<PushSubscription> {
  if (!webPushSupported()) throw Error('この端末ではプッシュ通知を利用できません。iPhoneはホーム画面に追加して開いてください。');
  // Permission is requested directly from the Save button's user gesture.
  if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') throw Error('通知が許可されていません。端末・ブラウザーの設定を確認してください。');
  const registration = await navigator.serviceWorker.register('/notifications-sw.js');
  await navigator.serviceWorker.ready;
  const current = await registration.pushManager.getSubscription();
  if (current) return current;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}
export async function unsubscribeNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/notifications-sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
}
