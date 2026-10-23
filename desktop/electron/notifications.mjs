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
  const show = (key, title, body, open) => {
    if (!Notification.isSupported() || isFocused()) return false;
    const now = clock();
    if (now - (sentAt.get(key) ?? -Infinity) < 5000) return false;
    active.get(key)?.close();
    const notification = new Notification({ title, body, silent: true });
    active.set(key, notification); sentAt.set(key, now);
    if (sentAt.size > 512) sentAt.delete(sentAt.keys().next().value);
    notification.on('click', open);
    notification.on('close', () => { if (active.get(key) === notification) active.delete(key); });
    notification.show(); return true;
  };
  return {
    notifyTask(value, open) {
      if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
        (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.length > 256 || /[\0-\x1f]/.test(value.taskId))) ||
        typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
        typeof value.body !== 'string' || value.body.length > 500 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value.title + value.body)) throw Error('Invalid task notification');
      return show(`task:${value.id}`, value.title, value.body, open);
    },
    notify(value) {
      if (!value || !uuid.test(value.paneId) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
        typeof value.body !== 'string' || value.body.length > 500 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value.title + value.body)) throw new Error('Invalid notification');
      return show(value.paneId, value.title, value.body, () => focusPane(value.paneId));
    },
    clear() {
      for (const notification of active.values()) notification.close();
      active.clear();
      sentAt.clear();
    },
  };
}
