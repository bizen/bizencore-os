export const DESKTOP_RELEASE_URL = 'https://bizencore.com/downloads/desktop/latest.json';
export const DESKTOP_DOWNLOAD_URL = 'https://bizencore.com/downloads/';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function newerVersion(candidate, current) {
  if (!SEMVER.test(candidate) || !SEMVER.test(current)) return false;
  const next = candidate.split('.').map(Number);
  const before = current.split('.').map(Number);
  return next.every(Number.isSafeInteger) && before.every(Number.isSafeInteger) &&
    next.some((value, i) => value > before[i] && next.slice(0, i).every((part, j) => part === before[j]));
}

export function checkedDesktopRelease(value, arch, current) {
  if (!value || value.channel !== 'production' || value.platform !== 'darwin' || value.arch !== arch ||
    value.published !== true || value.updateMethod !== 'manual' || !SEMVER.test(value.version) ||
    value.adHocSigned !== true || value.developerIdSigned !== false || value.notarized !== false ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    value.pageUrl !== DESKTOP_DOWNLOAD_URL || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size <= 0 || !newerVersion(value.version, current)) return null;
  return { version: value.version, pageUrl: DESKTOP_DOWNLOAD_URL, sha256: value.sha256, size: value.size };
}

export function createDesktopUpdateCheck({ channel, arch, version, fetchRelease, now = Date.now }) {
  let pending;
  let nextCheck = 0;
  let latest = null;
  return async () => {
    if (channel !== 'production') return null;
    if (pending) return pending;
    if (now() < nextCheck) return latest;
    nextCheck = now() + 60_000;
    pending = (async () => {
      try {
        const response = await fetchRelease(DESKTOP_RELEASE_URL, {
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || !response.body) return latest = null;
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 16_384) return latest = null;
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel(); }
        return latest = checkedDesktopRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), arch, version);
      } catch { return latest = null; }
    })().finally(() => { pending = null; });
    return pending;
  };
}
