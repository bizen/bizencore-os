import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthStorageParent } from '../desktop/electron/auth-storage-parent.mjs';

test('authentication worker requires private IPC and the same canonical parent executable', () => {
  const input = { connected: true, canSend: true, parentPid: 42, executable: '/Applications/terminal' };
  const dependency = { readParent: () => '/Applications/terminal', canonical: value => value };
  assert.equal(isAuthStorageParent(input, dependency), true);
  for (const change of [{ connected: false }, { canSend: false }, { parentPid: 1 }, { parentPid: NaN }]) {
    assert.equal(isAuthStorageParent({ ...input, ...change }, { readParent: () => { throw Error('must not inspect parent'); } }), false);
  }
  for (const parent of ['', 'node', '/usr/bin/node']) {
    assert.equal(isAuthStorageParent(input, { ...dependency, readParent: () => parent }), false);
  }
  assert.equal(isAuthStorageParent(input, { ...dependency, readParent: () => { throw Error('parent disappeared'); } }), false);
  assert.equal(isAuthStorageParent(input, { ...dependency, canonical: () => { throw Error('path unavailable'); } }), false);
  assert.equal(isAuthStorageParent(input, { ...dependency, readParent: () => '/symlink/terminal', canonical: () => '/Applications/terminal' }), true);
});
