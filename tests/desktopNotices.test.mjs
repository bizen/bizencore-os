import assert from 'node:assert/strict';
import test from 'node:test';
import { dependencyNotices } from '../desktop/electron/notices.mjs';
import { releaseArtifacts } from '../desktop/electron/release-config.mjs';

test('dependency notices preserve license text and report unresolved package notices', async () => {
  const notices = await dependencyNotices(new URL('..', import.meta.url).pathname);
  assert.ok(notices.count > 20);
  assert.ok(notices.text.includes('@clerk/electron@0.0.52'));
  assert.ok(notices.text.includes('Copyright (c) 2026 Clerk, Inc.'));
  assert.ok(notices.text.includes('The above copyright notice'));
  assert.deepEqual(notices.missing, []);
  assert.ok(notices.text.includes('Copyright (c) 2023 Svix'));
  assert.ok(notices.text.includes('Nick Fitzgerald'));
  assert.ok(notices.text.includes('Selected option: CC0-1.0'));
  assert.ok(notices.text.includes('OpenAI and the OpenAI Blossom are trademarks of OpenAI'));
  assert.ok(notices.text.includes('Claude is a trademark of Anthropic'));
  assert.ok(notices.text.includes('https://developers.openai.com/'));
  assert.ok(notices.text.includes('https://claude.com/'));
  assert.ok(!notices.text.includes('sk_live_'));
  assert.ok(!notices.text.includes('clerk-tokens.json'));
});

test('release metadata binds source and distribution profile without claiming publication', () => {
  const args = { version: '0.1.8', arch: 'arm64', sha256: 'a'.repeat(64), size: 10, sourceCommit: 'b'.repeat(40) };
  const metadata = releaseArtifacts(args).manifest;
  assert.equal(metadata.sourceCommit, args.sourceCommit);
  assert.equal(metadata.minimumMacOs, '13.0');
  assert.equal(metadata.channel, 'production');
  assert.equal(metadata.platform, 'darwin');
  assert.equal(metadata.published, false);
  assert.throws(() => releaseArtifacts({ ...args, sourceCommit: 'local dirty files' }));
});
