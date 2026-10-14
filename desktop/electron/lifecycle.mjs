/**
 * Attach once. Call attachWindow immediately after constructing replacement windows.
 * stopAgents({ reason }) must cancel pending starts and await process shutdown.
 * onQuit is the approved exit action (default app.quit), not an early quit hook.
 * requestQuit({ reason, onApproved }) can substitute an updater's quitAndInstall.
 * canExit() is true only during approved exit with both pane counts at zero;
 * use it to gate the parent's before-quit cleanup. requestQuit resolves true
 * when shutdown finished and the exit action was dispatched, not on OS exit.
 * A false return or rejection from the exit action resolves requestQuit false.
 *
 * Capture beginAgentLaunch() before any launch await and call its returned guard
 * before spawning and after subsequent awaits. Cancelled quit dialogs do not
 * revive old guards. These guards supplement the parent's authentication checks.
 *
 * With powerMonitor, supply synchronous checkAuthorization() and revokeAccess().
 * Only literal true is authorized. revokeAccess must synchronously invalidate
 * grants, capabilities and pending launches; it must never renew authorization.
 * onResume is a UI notification, not permission to restart agents. Call
 * authorizationLost('logout' | 'expired') when the parent detects either event.
 */
export function attachDesktopLifecycle({
  app, getWindow, runningCount, pendingCount, showMessageBox, stopAgents,
  // Leave the cancelled native before-quit event before dispatching approved quit.
  onQuit = () => new Promise(resolve => setImmediate(() => { app.quit(); resolve(); })), platform = process.platform,
  powerMonitor, checkAuthorization, revokeAccess, onResume = () => {}, onError = () => {},
}) {
  for (const [name, callback] of Object.entries({
    getWindow, runningCount, pendingCount, showMessageBox, stopAgents, onQuit, onResume, onError,
  })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if ((powerMonitor || checkAuthorization || revokeAccess) &&
      (typeof checkAuthorization !== 'function' || typeof revokeAccess !== 'function')) {
    throw new TypeError('Recovery requires synchronous checkAuthorization and revokeAccess callbacks');
  }
  let phase = 'idle';
  let generation = 0;
  let quitTask;
  let stopTask;
  let resumeTask;
  let recoveryTask;
  let recoveryBlocked = false;
  let recoveryError;
  let exitDenied = false;
  const windows = new Map();
  const alive = window => window && !window.isDestroyed();
  const report = error => { try { onError(error); } catch { /* Error reporting must not crash event handlers. */ } };
  const counts = () => {
    const running = runningCount();
    const pending = pendingCount();
    if (![running, pending].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError('Pane counts must be non-negative safe integers');
    }
    return { running, pending };
  };
  const authorized = () => {
    try {
      const result = checkAuthorization();
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(report);
        return false;
      }
      return result === true;
    } catch { return false; }
  };
  function canExit() {
    if (phase !== 'quitting') return false;
    try {
      const { running, pending } = counts();
      return running === 0 && pending === 0;
    } catch { return false; }
  }
  function stopAll(reason) {
    if (!stopTask) {
      stopTask = Promise.resolve().then(() => stopAgents({ reason })).then(() => {
        const { running, pending } = counts();
        if (running || pending) throw new Error('Agent shutdown left running or pending panes');
      }).finally(() => { stopTask = undefined; });
    }
    return stopTask;
  }
  function restoreWindow() {
    if (phase === 'disposed' || phase === 'quitting') return;
    const window = getWindow();
    if (!alive(window)) return;
    attachWindow(window);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  function attachWindow(window = getWindow()) {
    if (phase === 'disposed' || !alive(window) || windows.has(window)) return;
    const close = event => {
      if (canExit()) return;
      event.preventDefault();
      if (phase === 'quitting') { exitDenied = true; return; }
      if (platform === 'darwin') window.hide();
      else void requestQuit({ reason: 'window-close' });
    };
    const closed = () => {
      window.removeListener('close', close);
      window.removeListener('closed', closed);
      windows.delete(window);
    };
    window.on('close', close);
    window.on('closed', closed);
    windows.set(window, { close, closed });
  }
  function requestQuit({ reason = 'quit', onApproved = onQuit } = {}) {
    if (phase === 'disposed') return Promise.resolve(false);
    if (quitTask) return quitTask;
    if (typeof onApproved !== 'function') return Promise.reject(new TypeError('onApproved must be a function'));
    // Block new work synchronously, before dialog/cleanup callbacks can re-enter.
    phase = 'confirming';
    generation++;
    quitTask = Promise.resolve().then(async () => {
      const { running, pending } = counts();
      if (running || pending) {
        restoreWindow();
        const options = {
          type: 'warning', title: 'bizencore terminal', message: 'エージェントを停止して終了しますか？',
          detail: `実行中のペインが${running}件、起動待ちのペインが${pending}件あります。起動待ちのエージェントはキャンセルされます。`,
          buttons: ['キャンセル', '停止して終了'], defaultId: 0, cancelId: 0, noLink: true,
        };
        const window = getWindow();
        const result = await (alive(window) ? showMessageBox(window, options) : showMessageBox(options));
        if (result?.response !== 1 || phase === 'disposed') return false;
      }
      if (phase === 'disposed') return false;
      phase = 'stopping';
      await stopAll(reason);
      if (phase === 'disposed') return false;
      const remaining = counts();
      if (remaining.running || remaining.pending) throw new Error('New panes appeared during shutdown');
      phase = 'quitting';
      exitDenied = false;
      const result = await onApproved({ reason });
      if (phase === 'disposed') return false;
      if (result === false || exitDenied || !canExit()) throw new Error('Approved exit action was cancelled or panes appeared');
      return true;
    }).catch(error => {
      if (phase === 'quitting') phase = 'stopping';
      report(error);
      return false;
    }).finally(() => {
      if (phase !== 'quitting' && phase !== 'disposed') phase = 'idle';
      if (phase !== 'quitting') quitTask = undefined;
    });
    return quitTask;
  }
  function authorizationLost(reason = 'expired') {
    if (phase === 'disposed' || phase === 'quitting') return Promise.resolve(false);
    if (typeof revokeAccess !== 'function') return Promise.reject(new TypeError('revokeAccess is required'));
    generation++;
    recoveryBlocked = true;
    if (!recoveryTask) recoveryError = undefined;
    // Revocation happens in the event's turn, before any async recovery UI.
    try {
      const result = revokeAccess();
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(report);
        throw new TypeError('revokeAccess must invalidate authorization synchronously');
      }
    } catch (error) { recoveryError = error; }
    if (recoveryTask) return recoveryTask;
    recoveryTask = Promise.resolve().then(async () => {
      await stopAll(reason);
      if (recoveryError) throw recoveryError;
      if (phase === 'disposed' || phase === 'quitting') return false;
      await onResume({ reason, authorized: false, reconnect: true, reauthorize: true, restartAgents: 'manual' });
      if (recoveryError) throw recoveryError;
      recoveryBlocked = false;
      return true;
    }).finally(() => { recoveryTask = undefined; });
    return recoveryTask;
  }
  function resume() {
    if (phase === 'disposed' || phase === 'quitting') return Promise.resolve(false);
    if (resumeTask) return resumeTask;
    if (recoveryTask) return recoveryTask;
    if (typeof checkAuthorization !== 'function') return Promise.reject(new TypeError('checkAuthorization is required'));
    const recovery = authorized() ? null : authorizationLost('resume');
    resumeTask = Promise.resolve().then(async () => {
      if (recovery) return recovery;
      if (phase === 'disposed' || phase === 'quitting') return false;
      // Recheck after scheduling: logout/expiry can happen between power events.
      if (!authorized()) return authorizationLost('resume');
      await onResume({ reason: 'resume', authorized: true, reconnect: true, reauthorize: false, restartAgents: 'manual' });
      return true;
    }).finally(() => { resumeTask = undefined; });
    return resumeTask;
  }
  function beginAgentLaunch() {
    const captured = generation;
    const guard = () => {
      if (phase !== 'idle' || resumeTask || recoveryTask || recoveryBlocked || captured !== generation) {
        throw new Error('Agent launch cancelled by desktop lifecycle');
      }
      if (checkAuthorization && !authorized()) {
        void authorizationLost('expired').catch(report);
        throw new Error('Agent launch requires authorization');
      }
    };
    guard();
    return guard;
  }
  const beforeQuit = event => {
    if (canExit()) return;
    event.preventDefault();
    if (phase === 'quitting') { exitDenied = true; return; }
    void requestQuit();
  };
  const allClosed = () => { if (platform !== 'darwin') void requestQuit({ reason: 'window-close' }); };
  const created = (_event, window) => {
    // Electron emits this inside the constructor, before the parent assigns it.
    queueMicrotask(() => { if (window === getWindow()) attachWindow(window); });
  };
  const powerResume = () => { void resume().catch(report); };
  app.on('before-quit', beforeQuit);
  app.on('window-all-closed', allClosed);
  app.on('activate', restoreWindow);
  app.on('browser-window-created', created);
  powerMonitor?.on('resume', powerResume);
  attachWindow();
  function dispose() {
    phase = 'disposed';
    generation++;
    app.removeListener('before-quit', beforeQuit);
    app.removeListener('window-all-closed', allClosed);
    app.removeListener('activate', restoreWindow);
    app.removeListener('browser-window-created', created);
    powerMonitor?.removeListener('resume', powerResume);
    for (const [window, { close, closed }] of windows) {
      window.removeListener('close', close);
      window.removeListener('closed', closed);
    }
    windows.clear();
  }
  return { requestQuit, canExit, attachWindow, beginAgentLaunch, resume, authorizationLost, dispose };
}

/** Pure DIP bounds; pass screen.getAllDisplays().map(display => display.workArea). */
export function restoreWindowBounds(saved, workAreas, { width = 1380, height = 900, minWidth = 900, minHeight = 600 } = {}) {
  const valid = rectangle => rectangle &&
    [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isSafeInteger) &&
    rectangle.width > 0 && rectangle.height > 0 &&
    Number.isSafeInteger(rectangle.x + rectangle.width) && Number.isSafeInteger(rectangle.y + rectangle.height);
  const areas = Array.isArray(workAreas) ? workAreas.filter(valid) : [];
  if (!areas.length) throw new TypeError('At least one valid display work area is required');
  if (![width, height, minWidth, minHeight].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Window dimensions must be positive safe integers');
  }
  const bounds = valid(saved) ? saved : null;
  let area = areas[0];
  let largestOverlap = 0;
  if (bounds) for (const candidate of areas) {
    const overlap = Math.max(0, Math.min(bounds.x + bounds.width, candidate.x + candidate.width) - Math.max(bounds.x, candidate.x)) *
      Math.max(0, Math.min(bounds.y + bounds.height, candidate.y + candidate.height) - Math.max(bounds.y, candidate.y));
    if (overlap > largestOverlap) { largestOverlap = overlap; area = candidate; }
  }
  const restoredWidth = Math.min(area.width, Math.max(minWidth, bounds?.width ?? width));
  const restoredHeight = Math.min(area.height, Math.max(minHeight, bounds?.height ?? height));
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const usePosition = bounds && largestOverlap > 0;
  return {
    x: usePosition ? clamp(bounds.x, area.x, area.x + area.width - restoredWidth) : area.x + Math.floor((area.width - restoredWidth) / 2),
    y: usePosition ? clamp(bounds.y, area.y, area.y + area.height - restoredHeight) : area.y + Math.floor((area.height - restoredHeight) / 2),
    width: restoredWidth, height: restoredHeight,
  };
}
