import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { installRendererRecovery } from '../desktop/electron/renderer-recovery.mjs';

function fixture(prompt = async () => ({ response: 0 })) {
  const calls = [];
  const contents = new EventEmitter();
  let destroyed = false;
  contents.isDestroyed = () => destroyed;
  contents.reload = () => calls.push('reload');
  const window = { webContents: contents, isDestroyed: () => destroyed };
  const recover = installRendererRecovery({ window,
    cancelAuthentication: () => calls.push('cancel'), revokeAccess: () => calls.push('revoke'),
    showMessageBox: async (...args) => { calls.push('prompt'); return prompt(...args); },
    quit: () => calls.push('quit'),
  });
  return { calls, contents, recover, destroy: () => { destroyed = true; } };
}

test('renderer failure revokes access before offering recovery; reload never starts an agent', async () => {
  const f = fixture(async (window, options) => {
    assert.equal(window.webContents, f.contents);
    assert.deepEqual(f.calls, ['cancel', 'revoke', 'prompt']);
    assert.deepEqual(options.buttons, ['再読み込み', '終了']);
    assert.equal(options.cancelId, 1);
    return { response: 0 };
  });
  await f.recover({}, { reason: 'crashed' });
  assert.deepEqual(f.calls, ['cancel', 'revoke', 'prompt', 'reload']);
});

test('repeated renderer failures revoke again without opening competing dialogs', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const first = f.recover({}, { reason: 'killed' });
  await f.recover({}, { reason: 'crashed' });
  assert.deepEqual(f.calls, ['cancel', 'revoke', 'prompt', 'cancel', 'revoke']);
  resolve({ response: 0 });
  await first;
  assert.equal(f.calls.filter(call => call === 'reload').length, 1);
});

test('cancelled recovery or a failed dialog exits without restoring authorization', async () => {
  for (const prompt of [async () => ({ response: 1 }), async () => { throw Error('dialog failed'); }]) {
    const f = fixture(prompt);
    await f.recover({}, { reason: 'crashed' });
    assert.deepEqual(f.calls, ['cancel', 'revoke', 'prompt', 'quit']);
  }
});

test('closing the app while its recovery dialog is pending never reloads or reopens it', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.recover({}, { reason: 'crashed' });
  f.destroy();
  resolve({ response: 0 });
  await pending;
  assert.deepEqual(f.calls, ['cancel', 'revoke', 'prompt']);
});

test('normal renderer exit still revokes access without a crash dialog', async () => {
  const f = fixture();
  await f.recover({}, { reason: 'clean-exit' });
  assert.deepEqual(f.calls, ['cancel', 'revoke']);
});
