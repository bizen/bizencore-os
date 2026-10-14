import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { attachDesktopLifecycle, restoreWindowBounds } from '../desktop/electron/lifecycle.mjs';

const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function mockWindow(calls) {
  const window = new EventEmitter();
  window.destroyed = false;
  window.minimized = false;
  window.hidden = false;
  window.isDestroyed = () => window.destroyed;
  window.isMinimized = () => window.minimized;
  window.restore = () => { window.minimized = false; calls.push('restore'); };
  window.show = () => { window.hidden = false; calls.push('show'); };
  window.hide = () => { window.hidden = true; calls.push('hide'); };
  window.focus = () => calls.push('focus');
  window.close = () => {
    const close = event();
    window.emit('close', close);
    if (!close.prevented) { window.destroyed = true; window.emit('closed'); }
    return close;
  };
  return window;
}

function fixture(options = {}) {
  const calls = [];
  const errors = [];
  const notices = [];
  const dialogs = [];
  const state = { running: 0, pending: 0, authorized: true, capabilities: new Set(['initial']) };
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  let window = mockWindow(calls);
  app.quit = () => {
    calls.push('quit');
    const before = event();
    app.emit('before-quit', before);
    if (!before.prevented) window?.close();
  };
  const lifecycle = attachDesktopLifecycle({
    app, platform: 'darwin', getWindow: () => window,
    runningCount: () => state.running, pendingCount: () => state.pending,
    showMessageBox: async (...args) => {
      calls.push('dialog'); dialogs.push(args);
      return { response: 0 };
    },
    stopAgents: async () => { calls.push('stop'); state.running = 0; state.pending = 0; },
    powerMonitor, checkAuthorization: () => state.authorized,
    revokeAccess: () => { calls.push('revoke'); state.authorized = false; state.capabilities.clear(); },
    onResume: info => { calls.push('notice'); notices.push(info); },
    onError: error => errors.push(error),
    ...options,
  });
  return { app, powerMonitor, lifecycle, state, calls, errors, notices, dialogs,
    get window() { return window; }, setWindow(value) { window = value; } };
}

test('macOS red close hides the window and preserves active/pending panes and capabilities', () => {
  const f = fixture();
  f.state.running = 2; f.state.pending = 1;
  const guard = f.lifecycle.beginAgentLaunch();
  assert.equal(f.window.close().prevented, true);
  assert.equal(f.window.destroyed, false);
  assert.equal(f.window.hidden, true);
  assert.deepEqual(f.calls, ['hide']);
  assert.equal(f.state.running, 2);
  assert.equal(f.state.pending, 1);
  assert.equal(f.state.capabilities.size, 1);
  assert.doesNotThrow(guard);
  f.app.emit('window-all-closed');
  assert.deepEqual(f.calls, ['hide']);
});

test('Dock activate restores, shows and focuses the preserved minimized window without changing access', () => {
  const f = fixture();
  f.window.close(); f.window.minimized = true;
  f.app.emit('activate');
  assert.deepEqual(f.calls, ['hide', 'restore', 'show', 'focus']);
  assert.equal(f.state.authorized, true);
  assert.equal(f.state.capabilities.size, 1);
  f.window.destroyed = true;
  f.app.emit('activate');
  f.setWindow(null);
  f.app.emit('activate');
  assert.equal(f.calls.length, 4);
});

test('window attachment is idempotent and supports construction after lifecycle attachment', async () => {
  const f = fixture();
  f.lifecycle.attachWindow(); f.lifecycle.attachWindow(f.window);
  assert.equal(f.window.listenerCount('close'), 1);
  const other = mockWindow(f.calls);
  f.app.emit('browser-window-created', {}, other);
  await tick();
  assert.equal(other.listenerCount('close'), 0);
  const replacement = mockWindow(f.calls);
  f.app.emit('browser-window-created', {}, replacement);
  f.setWindow(replacement);
  await tick();
  assert.equal(replacement.close().prevented, true);
  assert.equal(replacement.destroyed, false);
});

test('Cmd+Q is prevented synchronously; cancellation does not stop agents or revoke access', async () => {
  const f = fixture(); f.state.running = 1;
  const before = event(); f.app.emit('before-quit', before);
  assert.equal(before.prevented, true);
  assert.throws(() => f.lifecycle.beginAgentLaunch(), /lifecycle/);
  assert.equal(await f.lifecycle.requestQuit(), false);
  assert.deepEqual(f.calls, ['show', 'focus', 'dialog']);
  assert.equal(f.state.running, 1);
  assert.equal(f.state.authorized, true);
  const options = f.dialogs[0][1];
  assert.equal(options.message, 'エージェントを停止して終了しますか？');
  assert.deepEqual(options.buttons, ['キャンセル', '停止して終了']);
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
  assert.doesNotThrow(() => f.lifecycle.beginAgentLaunch());
});

test('approved quit runs after the original native event has unwound', async () => {
  const f = fixture();
  let insideNativeQuit = true;
  f.app.quit = () => { assert.equal(insideNativeQuit, false); f.calls.push('quit-after-native-event'); };
  f.app.emit('before-quit', event());
  await Promise.resolve();
  assert.ok(!f.calls.includes('quit-after-native-event'));
  insideNativeQuit = false;
  assert.equal(await f.lifecycle.requestQuit(), true);
  assert.ok(f.calls.includes('quit-after-native-event'));
});

test('pending-only panes require confirmation, including a parentless dialog', async () => {
  const f = fixture(); f.state.pending = 3;
  f.window.destroyed = true;
  assert.equal(await f.lifecycle.requestQuit(), false);
  assert.equal(f.dialogs[0].length, 1);
  assert.equal(f.dialogs[0][0].detail, '実行中のペインが0件、起動待ちのペインが3件あります。起動待ちのエージェントはキャンセルされます。');
  assert.deepEqual(f.calls, ['dialog']);
});

test('repeated native and updater quit requests share one dialog and one shutdown; first action wins', async () => {
  const dialog = deferred(), stopped = deferred();
  const f = fixture({
    showMessageBox: () => { f.calls.push('dialog'); return dialog.promise; },
    stopAgents: async () => {
      f.calls.push('stop'); await stopped.promise;
      f.state.running = 0; f.state.pending = 0;
    },
  });
  f.state.running = 1; f.state.pending = 1;
  const first = f.lifecycle.requestQuit();
  const updater = f.lifecycle.requestQuit({ reason: 'update', onApproved: () => f.calls.push('install') });
  assert.equal(first, updater);
  for (let i = 0; i < 3; i++) {
    const before = event(); f.app.emit('before-quit', before); assert.equal(before.prevented, true);
  }
  await tick(); assert.equal(f.calls.filter(call => call === 'dialog').length, 1);
  dialog.resolve({ response: 1 }); await tick();
  assert.equal(f.calls.includes('quit'), false);
  assert.throws(() => f.lifecycle.beginAgentLaunch(), /lifecycle/);
  stopped.resolve(); assert.equal(await first, true);
  assert.deepEqual(f.calls, ['show', 'focus', 'dialog', 'stop', 'quit']);
  assert.equal(f.window.destroyed, true);
  assert.equal(await f.lifecycle.requestQuit(), true);
  assert.equal(f.calls.filter(call => call === 'quit').length, 1);
});

test('updater action waits for cancellation of pending work before installing and permits window close', async () => {
  const f = fixture({ showMessageBox: async () => ({ response: 1 }) });
  f.state.pending = 1;
  assert.equal(await f.lifecycle.requestQuit({ reason: 'update', onApproved: ({ reason }) => {
    assert.equal(reason, 'update');
    assert.equal(f.state.pending, 0);
    f.calls.push('install');
    assert.equal(f.window.close().prevented, false);
  } }), true);
  assert.deepEqual(f.calls, ['show', 'focus', 'stop', 'install']);
});

test('a cancelled updater action is never called', async () => {
  const f = fixture(); f.state.running = 1;
  assert.equal(await f.lifecycle.requestQuit({ reason: 'update', onApproved: () => assert.fail('installed') }), false);
  assert.equal(f.state.running, 1);
});

test('updater beforeInstall can approve first, then quitAndInstall closes windows before before-quit', async () => {
  const f = fixture({ showMessageBox: async () => ({ response: 1 }) });
  f.state.running = 1; f.state.pending = 1;
  assert.equal(await f.lifecycle.requestQuit({ reason: 'update', onApproved: () => true }), true);
  assert.equal(f.lifecycle.canExit(), true);
  assert.equal(f.calls.includes('quit'), false);
  assert.equal(f.window.close().prevented, false);
  const before = event(); f.app.emit('before-quit', before);
  assert.equal(before.prevented, false);
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
});

test('including stopping processes in runningCount prevents approval after a shutdown timeout', async () => {
  let stopping = 1;
  const f = fixture({ runningCount: () => f.state.running + stopping,
    showMessageBox: async () => ({ response: 1 }),
    stopAgents: async () => { f.state.running = 0; f.state.pending = 0; },
  });
  assert.equal(await f.lifecycle.requestQuit({ reason: 'update', onApproved: () => true }), false);
  assert.equal(f.lifecycle.canExit(), false);
  assert.equal(f.errors.length, 1);
  stopping = 0;
  assert.equal(await f.lifecycle.requestQuit({ reason: 'update', onApproved: () => true }), true);
  assert.equal(f.lifecycle.canExit(), true);
});

test('idle quit skips confirmation but still awaits the stop callback before quitting', async () => {
  const f = fixture({ stopAgents: async ({ reason }) => { assert.equal(reason, 'quit'); f.calls.push('stop'); } });
  assert.equal(await f.lifecycle.requestQuit(), true);
  assert.deepEqual(f.calls, ['stop', 'quit']);
});

test('late pending launches cannot spawn during confirmation, after cancellation, or after approved quit', async () => {
  for (const response of [0, 1]) {
    const dialog = deferred();
    const f = fixture({ showMessageBox: () => dialog.promise }); f.state.pending = 1;
    const guard = f.lifecycle.beginAgentLaunch();
    const quit = f.lifecycle.requestQuit();
    let spawned = false;
    const lateLaunch = Promise.resolve().then(() => { guard(); spawned = true; });
    await assert.rejects(lateLaunch, /lifecycle/);
    await tick(); dialog.resolve({ response });
    assert.equal(await quit, response === 1);
    assert.equal(spawned, false);
    assert.throws(guard, /lifecycle/);
    if (response === 0) assert.doesNotThrow(() => f.lifecycle.beginAgentLaunch());
  }
});

test('dialog errors, dismissed dialogs and unknown responses fail closed and allow a fresh request', async () => {
  for (const result of [undefined, {}, { response: -1 }, { response: 2 }, Error('dialog unavailable')]) {
    let attempt = 0;
    const f = fixture({ showMessageBox: async () => {
      if (attempt++) return { response: 1 };
      if (result instanceof Error) throw result;
      return result;
    } }); f.state.running = 1;
    assert.equal(await f.lifecycle.requestQuit(), false);
    assert.equal(f.state.running, 1);
    assert.equal(f.calls.includes('stop'), false);
    assert.equal(await f.lifecycle.requestQuit(), true);
  }
});

test('failed or incomplete agent shutdown prevents exit and can be retried', async () => {
  for (const failure of ['throw', 'running', 'pending']) {
    let attempt = 0;
    const f = fixture({ showMessageBox: async () => ({ response: 1 }), stopAgents: async () => {
      if (attempt++ === 0) {
        if (failure === 'throw') throw Error('stop failed');
        f.state.running = failure === 'running' ? 1 : 0;
        f.state.pending = failure === 'pending' ? 1 : 0;
        return;
      }
      f.state.running = 0; f.state.pending = 0;
    } }); f.state.running = 1;
    assert.equal(await f.lifecycle.requestQuit(), false);
    assert.equal(f.calls.includes('quit'), false);
    assert.equal(f.errors.length, 1);
    assert.equal(await f.lifecycle.requestQuit(), true);
  }
});

test('invalid counts prevent shutdown rather than skipping confirmation', async () => {
  for (const count of [NaN, Infinity, -1, 1.5, '1', undefined]) {
    const f = fixture({ pendingCount: () => count });
    assert.equal(await f.lifecycle.requestQuit(), false);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.calls, []);
  }
});

test('a failed quit action does not permanently authorize future unguarded native quits', async () => {
  const f = fixture({ onQuit: () => { throw Error('install failed'); } });
  assert.equal(await f.lifecycle.requestQuit(), false);
  assert.equal(f.errors.length, 1);
  const before = event(); f.app.emit('before-quit', before);
  assert.equal(before.prevented, true);
  await f.lifecycle.requestQuit();
});

test('canExit allows parent cleanup only after asynchronous shutdown and explicit approval', async () => {
  const dialog = deferred(), stopped = deferred();
  const f = fixture({ showMessageBox: () => dialog.promise, stopAgents: async () => {
    await stopped.promise; f.state.running = 0;
  } }); f.state.running = 1;
  const cleanup = [];
  f.app.on('before-quit', () => { if (f.lifecycle.canExit()) cleanup.push('cleanup'); });
  assert.equal(f.lifecycle.canExit(), false);
  const before = event(); f.app.emit('before-quit', before);
  const quit = f.lifecycle.requestQuit(); await tick();
  assert.equal(f.lifecycle.canExit(), false); assert.deepEqual(cleanup, []);
  dialog.resolve({ response: 1 }); await tick();
  assert.equal(f.lifecycle.canExit(), false); assert.deepEqual(cleanup, []);
  stopped.resolve(); assert.equal(await quit, true);
  assert.equal(f.lifecycle.canExit(), true); assert.deepEqual(cleanup, ['cleanup']);
});

test('onApproved can decline exit without false success or leaving native quit approved', async () => {
  const f = fixture();
  assert.equal(await f.lifecycle.requestQuit({ onApproved: () => false }), false);
  assert.equal(f.lifecycle.canExit(), false);
  assert.equal(f.calls.includes('quit'), false);
  assert.equal(await f.lifecycle.requestQuit(), true);
});

test('rogue pending work during an exit action prevents native quit and window destruction', async () => {
  const f = fixture();
  assert.equal(await f.lifecycle.requestQuit({ onApproved: () => {
    assert.equal(f.lifecycle.canExit(), true);
    f.state.pending = 1;
    assert.equal(f.lifecycle.canExit(), false);
    const before = event(); f.app.emit('before-quit', before);
    assert.equal(before.prevented, true);
    assert.equal(f.window.close().prevented, true);
  } }), false);
  assert.equal(f.window.destroyed, false);
  assert.equal(f.lifecycle.canExit(), false);
  assert.equal(f.errors.length, 1);
});

test('non-macOS window close guards active panes before destroying the window', async () => {
  const f = fixture({ platform: 'linux' }); f.state.running = 1;
  assert.equal(f.window.close().prevented, true);
  assert.equal(await f.lifecycle.requestQuit(), false);
  assert.equal(f.window.destroyed, false);
  assert.equal(f.calls.includes('hide'), false);
  f.state.running = 0;
  f.app.emit('window-all-closed');
  assert.equal(await f.lifecycle.requestQuit(), true);
});

test('resume with valid authorization reports reconnect without stopping or restarting agents', async () => {
  const f = fixture(); f.state.running = 2;
  f.powerMonitor.emit('resume');
  assert.equal(await f.lifecycle.resume(), true);
  assert.deepEqual(f.calls, ['notice']);
  assert.deepEqual(f.notices, [{ reason: 'resume', authorized: true, reconnect: true, reauthorize: false, restartAgents: 'manual' }]);
  assert.equal(f.state.running, 2);
  assert.equal(f.state.capabilities.size, 1);
});

test('expiry while asleep revokes capabilities immediately, cancels pending work, and requests manual recovery', async () => {
  const stopped = deferred();
  const f = fixture({ stopAgents: async () => {
    f.calls.push('stop'); await stopped.promise;
    f.state.running = 0; f.state.pending = 0;
  } });
  f.state.running = 2; f.state.pending = 1;
  const guard = f.lifecycle.beginAgentLaunch();
  f.state.authorized = false;
  f.powerMonitor.emit('resume');
  assert.equal(f.state.capabilities.size, 0);
  assert.deepEqual(f.calls, ['revoke']);
  assert.throws(guard, /lifecycle/);
  assert.throws(() => f.lifecycle.beginAgentLaunch(), /lifecycle/);
  await tick(); assert.deepEqual(f.calls, ['revoke', 'stop']);
  stopped.resolve(); await f.lifecycle.resume();
  assert.deepEqual(f.calls, ['revoke', 'stop', 'notice']);
  assert.deepEqual(f.notices[0], { reason: 'resume', authorized: false, reconnect: true, reauthorize: true, restartAgents: 'manual' });
  assert.equal(f.state.authorized, false);
  assert.equal(f.state.running, 0);
});

test('logout blocks old launch guards even after reauthorization; only a fresh explicit launch is permitted', async () => {
  const f = fixture(); f.state.running = 1;
  const oldGuard = f.lifecycle.beginAgentLaunch();
  const recovering = f.lifecycle.authorizationLost('logout');
  assert.equal(f.state.authorized, false);
  assert.equal(f.state.capabilities.size, 0);
  await recovering;
  assert.equal(f.notices[0].reason, 'logout');
  assert.equal(f.state.running, 0);
  f.state.authorized = true;
  assert.throws(oldGuard, /lifecycle/);
  assert.doesNotThrow(() => f.lifecycle.beginAgentLaunch());
  assert.equal(f.state.running, 0);
  assert.equal(f.state.capabilities.size, 0);
});

test('launch continuation checks authorization again and revokes newly expired capabilities', async () => {
  const f = fixture();
  const guard = f.lifecycle.beginAgentLaunch();
  f.state.authorized = false;
  assert.throws(guard, /requires authorization/);
  assert.equal(f.state.capabilities.size, 0);
  await tick();
  assert.equal(f.notices[0].reason, 'expired');
});

test('resume rechecks authorization if it expires between the power event and notification', async () => {
  const f = fixture();
  const resume = f.lifecycle.resume(); f.state.authorized = false;
  await resume;
  assert.deepEqual(f.calls, ['revoke', 'stop', 'notice']);
  assert.equal(f.notices[0].authorized, false);
});

test('authorization check exceptions and non-boolean results fail closed on resume', async () => {
  for (const checkAuthorization of [() => { throw Error('offline'); }, () => undefined, () => ({ authorized: true })]) {
    const f = fixture({ checkAuthorization });
    await f.lifecycle.resume();
    assert.equal(f.state.authorized, false);
    assert.equal(f.state.capabilities.size, 0);
    assert.equal(f.notices[0].reauthorize, true);
  }
});

test('repeated resume and logout events share shutdown and UI notification without retaining new capabilities', async () => {
  const stopped = deferred();
  const f = fixture({ stopAgents: async () => { f.calls.push('stop'); await stopped.promise; } });
  f.state.authorized = false;
  const first = f.lifecycle.resume();
  assert.equal(first, f.lifecycle.resume());
  f.powerMonitor.emit('resume');
  f.state.capabilities.add('new');
  const logout = f.lifecycle.authorizationLost('logout');
  assert.equal(f.state.capabilities.size, 0);
  await tick();
  stopped.resolve(); await first; await logout;
  assert.deepEqual(f.calls, ['revoke', 'revoke', 'stop', 'notice']);
});

test('quit during resume recovery awaits the same stop callback and never duplicates shutdown', async () => {
  const stopped = deferred();
  const f = fixture({ showMessageBox: async () => ({ response: 1 }), stopAgents: async () => {
    f.calls.push('stop'); await stopped.promise; f.state.running = 0;
  } }); f.state.running = 1; f.state.authorized = false;
  const resume = f.lifecycle.resume(); const quit = f.lifecycle.requestQuit();
  await tick(); assert.equal(f.calls.filter(call => call === 'stop').length, 1);
  assert.equal(f.calls.includes('quit'), false);
  stopped.resolve(); await resume;
  assert.equal(await quit, true);
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
});

test('recovery callback can request quit without deadlocking on its own notification', async () => {
  const f = fixture({ onResume: async () => { await f.lifecycle.requestQuit(); } });
  f.state.authorized = false;
  assert.equal(await f.lifecycle.resume(), true);
  assert.equal(f.calls.includes('quit'), true);
});

test('failed recovery keeps launches blocked and is reported safely from powerMonitor', async () => {
  const f = fixture({ revokeAccess: () => { throw Error('revocation failed'); } });
  f.state.authorized = false;
  f.powerMonitor.emit('resume'); await tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.notices.length, 0);
  f.state.authorized = true;
  assert.throws(() => f.lifecycle.beginAgentLaunch(), /lifecycle/);
});

test('accidentally async authorization callbacks fail closed without unhandled rejections', async () => {
  const f = fixture({ checkAuthorization: async () => { throw Error('async check'); } });
  assert.equal(await f.lifecycle.resume(), true);
  assert.equal(f.state.capabilities.size, 0);
  assert.equal(f.notices[0].authorized, false);
  assert.equal(f.errors.length, 1);
  const other = fixture({ revokeAccess: async () => { throw Error('async revoke'); } });
  other.state.authorized = false;
  await assert.rejects(other.lifecycle.resume(), /synchronously/);
  other.state.authorized = true;
  assert.throws(() => other.lifecycle.beginAgentLaunch(), /lifecycle/);
  assert.equal(other.notices.length, 0);
  await tick(); assert.equal(other.errors.length, 1);
});

test('an overlapping logout revocation failure cannot release a recovery launch block', async () => {
  let attempt = 0;
  const notice = deferred();
  const f = fixture({ revokeAccess: () => {
    if (attempt++) throw Error('second revoke failed');
    f.state.authorized = false; f.state.capabilities.clear();
  }, onResume: () => notice.promise });
  const first = f.lifecycle.authorizationLost('expired'); await tick();
  assert.equal(first, f.lifecycle.authorizationLost('logout'));
  notice.resolve(); await assert.rejects(first, /second revoke failed/);
  f.state.authorized = true;
  assert.throws(() => f.lifecycle.beginAgentLaunch(), /lifecycle/);
});

test('dispose cancels a pending quit and removes only the helper\'s event listeners', async () => {
  const dialog = deferred();
  const f = fixture({ showMessageBox: () => dialog.promise }); f.state.running = 1;
  const external = () => {};
  f.app.on('activate', external); f.window.on('close', external); f.powerMonitor.on('resume', external);
  const quit = f.lifecycle.requestQuit(); await tick();
  f.lifecycle.dispose(); f.lifecycle.dispose();
  dialog.resolve({ response: 1 });
  assert.equal(await quit, false);
  assert.equal(await f.lifecycle.requestQuit(), false);
  assert.equal(await f.lifecycle.resume(), false);
  assert.equal(f.calls.includes('stop'), false);
  assert.deepEqual(f.app.listeners('activate'), [external]);
  assert.deepEqual(f.window.listeners('close'), [external]);
  assert.deepEqual(f.powerMonitor.listeners('resume'), [external]);
  assert.equal(f.app.listenerCount('before-quit'), 0);
});

test('dispose during shutdown or resume prevents later quit or recovery UI', async () => {
  for (const action of ['quit', 'resume']) {
    const stopped = deferred();
    const f = fixture({ stopAgents: async () => { await stopped.promise; } });
    if (action === 'resume') f.state.authorized = false;
    const pending = action === 'quit' ? f.lifecycle.requestQuit() : f.lifecycle.resume();
    await tick(); f.lifecycle.dispose(); stopped.resolve();
    assert.equal(await pending, false);
    assert.equal(f.calls.includes('quit'), false);
    assert.equal(f.notices.length, 0);
  }
});

test('powerMonitor recovery requires explicit authorization and revocation callbacks', () => {
  assert.throws(() => fixture({ revokeAccess: undefined }), /Recovery requires/);
  assert.throws(() => fixture({ checkAuthorization: undefined }), /Recovery requires/);
});

const primary = { x: 0, y: 24, width: 1440, height: 876 };
const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
test('bounds preserve valid negative display coordinates and select the display with greatest overlap', () => {
  const saved = { x: -1800, y: 60, width: 1200, height: 800 };
  assert.deepEqual(restoreWindowBounds(saved, [primary, secondary]), saved);
});

test('offscreen bounds from a removed monitor are centered on the primary work area', () => {
  assert.deepEqual(restoreWindowBounds({ x: 5000, y: 5000, width: 1000, height: 700 }, [primary]),
    { x: 220, y: 112, width: 1000, height: 700 });
});

test('bounds clamp size and position including work areas smaller than minimum dimensions', () => {
  assert.deepEqual(restoreWindowBounds({ x: 1400, y: 850, width: 3000, height: 2000 }, [primary]), primary);
  const tiny = { x: 15, y: 30, width: 640, height: 480 };
  assert.deepEqual(restoreWindowBounds(null, [tiny]), tiny);
  assert.deepEqual(restoreWindowBounds({ x: 10, y: 30, width: 10, height: 10 }, [primary]),
    { x: 10, y: 30, width: 900, height: 600 });
});

test('malformed persisted bounds use defaults and malformed work areas or dimensions are rejected', () => {
  const expected = { x: 30, y: 24, width: 1380, height: 876 };
  for (const saved of [null, {}, { x: NaN, y: 0, width: 900, height: 600 },
    { x: 0, y: 0, width: '900', height: 600 }, { x: 0, y: 0, width: -1, height: 600 },
    { x: Number.MAX_SAFE_INTEGER, y: 0, width: 900, height: 600 }]) {
    assert.deepEqual(restoreWindowBounds(saved, [primary]), expected);
  }
  assert.throws(() => restoreWindowBounds(null, []), /work area/);
  assert.throws(() => restoreWindowBounds(null, null), /work area/);
  assert.throws(() => restoreWindowBounds(null, [primary], { minWidth: 0 }), /dimensions/);
  assert.deepEqual(restoreWindowBounds(null, [{}, primary]), expected);
});
