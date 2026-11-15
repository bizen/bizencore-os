import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthStorage } from './auth-storage.mjs';

export async function checkAuthStorage(clerkHost) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bizencore-auth-storage-'));
  const file = path.join(directory, 'auth', clerkHost, 'clerk-tokens.json');
  const value = `storage-check-${randomBytes(32).toString('hex')}`;
  try {
    const first = createAuthStorage(directory, clerkHost);
    await first.setItem('probe', value);
    const serialized = await readFile(file, 'utf8').catch(() => '{}');
    const stored = JSON.parse(serialized).probe;
    const second = createAuthStorage(directory, clerkHost);
    const restored = await second.getItem('probe') === value;
    await second.removeItem('probe');
    const removed = await createAuthStorage(directory, clerkHost).getItem('probe') === null;
    const mode = await stat(file).then(info => info.mode & 0o777).catch(() => null);
    return {
      encryptedOnDisk: typeof stored === 'string' && stored.startsWith('enc:'),
      restored, removed, noPlaintext: !serialized.includes(value), privateFile: mode === 0o600,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
