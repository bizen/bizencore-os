import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedDesktopRelease, createDesktopUpdateCheck, newerVersion, DESKTOP_DOWNLOAD_URL, DESKTOP_RELEASE_URL } from '../desktop/electron/desktop-update.mjs';

const release = { version: '0.1.8', channel: 'production', platform: 'darwin', arch: 'arm64', published: true,
  updateMethod: 'manual', pageUrl: DESKTOP_DOWNLOAD_URL, sha256: 'a'.repeat(64), size: 140_000_000,
  adHocSigned: true, developerIdSigned: false, notarized: false, sourceCommit: 'b'.repeat(40) };

test('desktop versions are compared numerically and reject malformed versions', () => {
  assert.ok(newerVersion('0.1.10', '0.1.9'));
  assert.ok(newerVersion('1.0.0', '0.99.99'));
  for (const version of ['0.1.7', '0.1.6', '00.1.8', '0.1.8-beta', '0.1.8.0', '9007199254740992.0.0']) assert.equal(newerVersion(version, '0.1.7'), false);
});
test('only a newer published manual release for the matching architecture is announced', () => {
  assert.equal(checkedDesktopRelease(release, 'arm64', '0.1.7')?.version, '0.1.8');
  for (const patch of [{ published: false }, { channel: 'preview' }, { arch: 'x64' }, { platform: 'win32' },
    { version: '0.1.7' }, { sha256: 'bad' }, { size: -1 }, { pageUrl: 'https://attacker.test/' }, { updateMethod: 'automatic' },
    { sourceCommit: '' }, { adHocSigned: false }]) {
    assert.equal(checkedDesktopRelease({ ...release, ...patch }, 'arm64', '0.1.7'), null);
  }
});
test('synchronous network errors can recover on the next check', async () => {
  let now = 0; let fail = true;
  const check = createDesktopUpdateCheck({ channel: 'production', arch: 'arm64', version: '0.1.7', now: () => now,
    fetchRelease: () => { if (fail) throw Error('network unavailable'); return Promise.resolve(Response.json(release)); } });
  assert.equal(await check(), null);
  fail = false; now = 60_001;
  assert.equal((await check()).version, '0.1.8');
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

test('download URLs are fixed to the versioned first-party GitHub asset', () => {
  const checked = checkedDesktopRelease(release, 'arm64', '0.1.7');
  assert.equal(checked.downloadUrl, 'https://github.com/bizen/bizencore-os/releases/download/desktop-v0.1.8/bizencore-terminal-0.1.8-darwin-arm64.zip');
  for (const downloadUrl of ['https://attacker.test/update.zip', checked.downloadUrl + '?redirect=evil']) {
    assert.equal(checkedDesktopRelease({ ...release, downloadUrl }, 'arm64', '0.1.7'), null);
  }
});
