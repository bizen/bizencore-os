/* Notification-only service worker: no fetch cache, so app updates stay independent. */
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data.json(); } catch { return; }
    if (!data || typeof data.title !== 'string' || typeof data.body !== 'string' || typeof data.tag !== 'string') return;
    const url = new URL(typeof data.path === 'string' ? data.path : '/', self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== '/') return;
    await self.registration.showNotification(data.title.slice(0, 160), {
      body: data.body.slice(0, 500), tag: data.tag.slice(0, 512),
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: url.href },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url ?? '/', self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== '/') return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = windows.find(client => new URL(client.url).origin === url.origin);
    if (current) { await current.navigate(url.href); await current.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
