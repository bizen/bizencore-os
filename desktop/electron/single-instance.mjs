export function claimDesktopInstance(app, getWindow) {
  if (!app.requestSingleInstanceLock()) return false;
  let requested = false;
  const focus = () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) { requested = true; return; }
    requested = false;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  app.on('second-instance', focus);
  app.on('browser-window-created', () => queueMicrotask(() => { if (requested) focus(); }));
  return true;
}
