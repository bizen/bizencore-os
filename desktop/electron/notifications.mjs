const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function externalWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid web link');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('Invalid web link');
  return url.href;
}

export function createDesktopNotifications({ Notification, isFocused, focusPane, clock = Date.now }) {
  const active = new Map();
  const sentAt = new Map();
  return {
    notify(value) {
      if (!value || !uuid.test(value.paneId) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
        typeof value.body !== 'string' || value.body.length > 500 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value.title + value.body)) throw new Error('Invalid notification');
      if (!Notification.isSupported() || isFocused()) return false;
      const now = clock();
      if (now - (sentAt.get(value.paneId) ?? -Infinity) < 5000) return false;
      active.get(value.paneId)?.close();
      const notification = new Notification({ title: value.title, body: value.body, silent: true });
      active.set(value.paneId, notification);
      sentAt.set(value.paneId, now);
      notification.on('click', () => focusPane(value.paneId));
      notification.on('close', () => { if (active.get(value.paneId) === notification) active.delete(value.paneId); });
      notification.show();
      return true;
    },
    clear() {
      for (const notification of active.values()) notification.close();
      active.clear();
      sentAt.clear();
    },
  };
}
