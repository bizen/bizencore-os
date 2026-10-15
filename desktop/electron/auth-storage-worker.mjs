import { app } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { checkedRuntimeConfig } from './release-config.mjs';
import { createAuthStorage } from './auth-storage.mjs';
import { serveAuthStorage } from './auth-storage-channel.mjs';

// This mode must be a direct child of this application, never a standalone token reader.
const parentExecutable = process.send && process.connected ? execFileSync('/bin/ps', ['-p', String(process.ppid), '-o', 'comm='], { encoding: 'utf8', timeout: 2000 }).trim() : '';
if (!parentExecutable || await realpath(parentExecutable) !== await realpath(process.execPath)) app.exit(2);
else {
  const config = JSON.parse(await readFile(path.join(app.getAppPath(), 'config.json'), 'utf8'));
  const profile = checkedRuntimeConfig(config);
  app.setName(profile.name);
  const directory = path.join(app.getPath('appData'), profile.userData);
  // No browser profile is opened by the helper. The token file remains at its old path.
  app.setPath('userData', path.join(directory, 'auth-worker-runtime'));
  process.on('disconnect', () => app.exit(0));
  app.whenReady().then(() => {
    app.dock?.hide();
    const storage = createAuthStorage(directory, config.clerkHost);
    serveAuthStorage(process, storage, () => app.exit(2));
    if (process.connected) process.send({ ready: true }); else app.exit(0);
  }).catch(() => app.exit(2));
}
