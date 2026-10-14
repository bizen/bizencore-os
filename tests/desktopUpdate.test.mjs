import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedDesktopRelease, createDesktopUpdateCheck, newerVersion, DESKTOP_DOWNLOAD_URL, DESKTOP_RELEASE_URL } from '../desktop/electron/desktop-update.mjs';

const release = { version: '0.1.8', channel: 'production', platform: 'darwin', arch: 'arm64', published: true,
  updateMethod: 'manual', pageUrl: DESKTOP_DOWNLOAD_URL, sha256: 'a'.repeat(64), size: 140_000_000 };

test('desktop versions are compared numerically and reject malformed versions', () => {
  assert.ok(newerVersion('0.1.10', '0.1.9'));
  assert.ok(newerVersion('1.0.0', '0.99.99'));
  for (const version of ['0.1.7', '0.1.6', '00.1.8', '0.1.8-beta', '0.1.8.0', '9007199254740992.0.0']) assert.equal(newerVersion(version, '0.1.7'), false);
});
test('only a newer published manual release for the matching architecture is announced', () => {
  assert.equal(checkedDesktopRelease(release, 'arm64', '0.1.7')?.version, '0.1.8');
  for (const patch of [{ published: false }, { channel: 'preview' }, { arch: 'x64' }, { platform: 'win32' },
    { version: '0.1.7' }, { sha256: 'bad' }, { size: -1 }, { pageUrl: 'https://attacker.test/' }, { updateMethod: 'automatic' }]) {
    assert.equal(checkedDesktopRelease({ ...release, ...patch }, 'arm64', '0.1.7'), null);
  }
});
test('update checks are coalesced, bounded and never send account credentials', async () => {
  let calls = 0; let now = 0;
  const check = createDesktopUpdateCheck({ channel: 'production', arch: 'arm64', version: '0.1.7', now: () => now,
    fetchRelease: async (url, options) => {
      calls++; assert.equal(url, DESKTOP_RELEASE_URL); assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { Accept: 'application/json' });
      return Response.json(release);
    } });
  assert.equal((await check()).version, '0.1.8');
  await check(); assert.equal(calls, 1);
  now = 60_001; await check(); assert.equal(calls, 2);
  const invalid = body => createDesktopUpdateCheck({ channel: 'production', arch: 'arm64', version: '0.1.7', fetchRelease: async () => new Response(body) });
  assert.equal(await invalid('not json')(), null);
  assert.equal(await invalid('x'.repeat(16_385))(), null);
  const preview = createDesktopUpdateCheck({ channel: 'preview', fetchRelease: () => { throw Error('must not fetch'); } });
  assert.equal(await preview(), null);
});
