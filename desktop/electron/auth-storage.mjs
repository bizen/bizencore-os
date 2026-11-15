import path from 'node:path';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { storage } from '@clerk/electron/storage';
import { validAuthHost } from './release-config.mjs';

export function createAuthStorage(directory, clerkHost) {
  if (!path.isAbsolute(directory) || !validAuthHost(clerkHost)) {
    throw new Error('Invalid authentication storage configuration');
  }
  const folder = path.join(directory, 'auth', clerkHost);
  const file = path.join(folder, 'clerk-tokens.json');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const restrictFile = () => { if (existsSync(file)) chmodSync(file, 0o600); };
  restrictFile();
  const adapter = storage({
    path: folder,
    name: 'clerk-tokens',
    unencryptedFallback: false,
  });
  // electron-store's file mode otherwise depends on the launching process's umask.
  return {
    async getItem(key) {
      try { return await adapter.getItem(key); } finally { restrictFile(); }
    },
    async setItem(key, value) {
      try { await adapter.setItem(key, value); } finally { restrictFile(); }
    },
    removeItem(key) {
      try { adapter.removeItem(key); } finally { restrictFile(); }
    },
  };
}
