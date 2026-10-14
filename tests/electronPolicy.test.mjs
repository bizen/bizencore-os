import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessState, checkedGrant, convexEndpoint, paneId, terminalSize, tokenClaims, trustedRenderer } from '../desktop/electron/policy.mjs';

test('Electron IPC accepts only the local renderer origin', () => {
  assert.ok(trustedRenderer('bizencore-electron-preview://renderer/'));
  assert.ok(trustedRenderer('http://127.0.0.1:5211/', true));
  for (const url of ['http://127.0.0.1:5211/', 'file:///tmp/index.html', 'https://app.bizencore.com/', 'bizencore-electron-preview://renderer.evil/', 'bizencore-electron-preview://evil@renderer/']) assert.equal(trustedRenderer(url), false);
});
test('Electron starts locked and enforces both wall-clock and monotonic expiry', () => {
  let now = 100000; let mono = 0;
  const state = new AccessState(() => now, () => mono);
  assert.throws(() => state.require());
  state.install(0, { userId: 'first', expiresAt: 130 });
  assert.equal(state.require().userId, 'first');
  mono = 31000;
  assert.throws(() => state.require());
  assert.ok(state.expired());
  state.revoke(); mono = 0;
  state.install(1, { userId: 'first', expiresAt: 130 });
  now = 131000;
  assert.throws(() => state.require());
});
test('Logout invalidates late verification and account changes need a new grant', () => {
  const state = new AccessState(() => 100000, () => 0);
  state.install(0, { userId: 'first', expiresAt: 130 });
  assert.throws(() => state.install(0, { userId: 'second', expiresAt: 130 }));
  state.revoke();
  assert.throws(() => state.install(0, { userId: 'first', expiresAt: 130 }));
  state.install(1, { userId: 'second', expiresAt: 130 });
  assert.equal(state.require().userId, 'second');
});
test('Only matching server-verified active accounts unlock the workspace', () => {
  const claims = { sub: 'first', exp: 200 };
  const value = { status: 'success', value: { userId: 'first', phase: 'active' } };
  assert.deepEqual(checkedGrant(value, claims, 100000), { userId: 'first', expiresAt: 190 });
  for (const bad of [null, { status: 'success', value: null }, { status: 'success', value: { userId: 'second', phase: 'active' } }, { status: 'success', value: { userId: 'first', phase: 'data' } }]) assert.throws(() => checkedGrant(bad, claims, 100000));
});
test('Malformed JWTs and arbitrary token destinations are rejected', () => {
  for (const token of ['', 'a.b.c', 'a'.repeat(17000), null]) assert.throws(() => tokenClaims(token));
  const token = `a.${Buffer.from(JSON.stringify({ sub: 'first', exp: 200 })).toString('base64url')}.c`;
  assert.equal(tokenClaims(token, 100000).sub, 'first');
  assert.throws(() => tokenClaims(token, 200000));
  for (const url of ['http://test.convex.cloud', 'https://test.convex.cloud.evil', 'https://test.convex.cloud/redirect', 'https://test.convex.cloud?x=1', 'https://user@test.convex.cloud']) assert.throws(() => convexEndpoint(url));
  assert.equal(convexEndpoint('https://test.convex.cloud'), 'https://test.convex.cloud/api/query');
});
test('Pane commands validate IDs and terminal dimensions', () => {
  assert.equal(paneId('17d1c653-d4b7-4224-9d0b-027df8da9ba3'), '17d1c653-d4b7-4224-9d0b-027df8da9ba3');
  assert.throws(() => paneId('../evil'));
  assert.throws(() => terminalSize(1, 30));
  assert.throws(() => terminalSize(80, 301));
  assert.throws(() => terminalSize(80.5, 30));
  assert.deepEqual(terminalSize(80, 30), { cols: 80, rows: 30 });
});
