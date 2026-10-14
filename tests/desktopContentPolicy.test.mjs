import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopContentPolicy } from '../desktop/electron/content-policy.mjs';
import { profiles } from '../desktop/electron/release-config.mjs';

test('native file uploads can connect only to the selected deployment file site', () => {
  for (const channel of ['production', 'preview']) {
    const profile = profiles[channel];
    const policy = desktopContentPolicy({ channel, convexUrl: profile.convexUrl, clerkHost: profile.clerkHost });
    const connect = policy.split(';').find(value => value.trim().startsWith('connect-src'));
    assert.ok(connect.split(' ').includes(profile.convexUrl.replace('.convex.cloud', '.convex.site')));
    const other = profiles[channel === 'production' ? 'preview' : 'production'];
    assert.ok(!connect.includes(other.convexUrl.replace('.convex.cloud', '.convex.site')));
    assert.ok(!connect.includes('*.convex.site'));
    assert.ok(!connect.includes('http://127.0.0.1'));
    assert.ok(policy.includes("object-src 'none'"));
    assert.ok(policy.includes("default-src 'self'"));
  }
});
test('production content policy rejects dev origins or an unrecognized Convex deployment', () => {
  const config = { channel: 'production', convexUrl: profiles.production.convexUrl, clerkHost: profiles.production.clerkHost };
  assert.throws(() => desktopContentPolicy(config, true));
  assert.throws(() => desktopContentPolicy({ ...config, convexUrl: 'https://attacker.convex.cloud' }));
});
