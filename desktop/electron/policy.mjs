import { releaseProfile } from './release-config.mjs';

const denied = () => new Error('サインインを確認してください');
export const scheme = 'bizencore-electron-preview';
export const rendererOrigin = `${scheme}://renderer`;

export function trustedRenderer(url, dev = false, channel = 'preview') {
  const profile = releaseProfile(channel);
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && (
      (parsed.protocol === `${profile.scheme}:` && parsed.host === 'renderer') ||
      (dev && channel === 'preview' && parsed.origin === 'http://127.0.0.1:5211')
    );
  } catch { return false; }
}

export function convexEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.convex.cloud') ||
    url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ログイン設定が無効です');
  }
  return `${url.origin}/api/query`;
}

export function tokenClaims(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 16384) throw denied();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied();
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); }
  catch { throw denied(); }
  if (typeof claims.sub !== 'string' || !claims.sub || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) throw denied();
  return claims;
}

export function checkedGrant(value, claims, now = Date.now()) {
  if (value?.status !== 'success' || value.value?.userId !== claims.sub ||
    value.value?.phase !== 'active' || claims.exp * 1000 <= now) throw denied();
  return { userId: claims.sub, expiresAt: Math.min(claims.exp, Math.floor(now / 1000) + 90) };
}

export class AccessState {
  generation = 0;
  lease = null;
  constructor(clock = () => Date.now(), monotonic = () => performance.now()) {
    this.clock = clock;
    this.monotonic = monotonic;
  }
  require() {
    if (!this.lease || this.lease.grant.expiresAt * 1000 <= this.clock() || this.lease.deadline <= this.monotonic()) throw denied();
    return this.lease.grant;
  }
  revoke() { this.generation++; this.lease = null; }
  install(generation, grant) {
    if (generation !== this.generation || grant.expiresAt * 1000 <= this.clock() ||
      (this.lease && this.lease.grant.userId !== grant.userId)) throw denied();
    this.lease = { grant, deadline: this.monotonic() + grant.expiresAt * 1000 - this.clock() };
  }
  expired() {
    if (!this.lease) return false;
    try { this.require(); return false; } catch { return true; }
  }
}

export function paneId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid pane ID');
  return id;
}
export function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error('Invalid terminal size');
  return { cols, rows };
}
