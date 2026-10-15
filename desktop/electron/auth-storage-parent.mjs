import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export function isAuthStorageParent({ connected, canSend, parentPid, executable }, {
  readParent = pid => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2000 }).trim(),
  canonical = realpathSync,
} = {}) {
  if (!connected || !canSend || !Number.isSafeInteger(parentPid) || parentPid <= 1) return false;
  try {
    const parent = readParent(parentPid);
    return path.isAbsolute(parent) && path.isAbsolute(executable) && canonical(parent) === canonical(executable);
  } catch { return false; }
}
