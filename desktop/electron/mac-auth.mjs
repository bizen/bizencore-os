import { spawn } from 'node:child_process';
import { scheme } from './policy.mjs';
import { profiles, validAuthHost } from './release-config.mjs';

// Clerk 0.0.52 has no configurable main-process OAuth transport. Only replace
// its open handler; keep its token storage, redirect URL and nonce verification.
export const OAUTH_OPEN_CHANNEL = 'clerk:oauth-transport:open';
export function checkedAuthUrl(value, clerkHost) {
  if (!validAuthHost(clerkHost)) throw new Error('Invalid authentication host');
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid authentication URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    (url.hostname !== clerkHost && url.hostname !== 'accounts.google.com')) throw new Error('Invalid authentication host');
  return url.href;
}
export function checkedAuthCallback(value, callbackScheme = scheme) {
  if (!Object.values(profiles).some(profile => profile.scheme === callbackScheme)) throw new Error('Invalid authentication scheme');
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid authentication callback');
  const url = new URL(value);
  if (url.protocol !== `${callbackScheme}:` || url.host !== 'renderer' || url.pathname !== '/' || url.username || url.password || url.hash) throw new Error('Invalid authentication callback');
  return { callbackUrl: url.href };
}

export function installMacAuthentication({ ipcMain, executable, clerkHost, callbackScheme = scheme, checkSender, focusWindow, spawnProcess = spawn }) {
  checkedAuthCallback(`${callbackScheme}://renderer/`, callbackScheme);
  if ((clerkHost === profiles.production.clerkHost) !== (callbackScheme === profiles.production.scheme)) throw new Error('Authentication profiles differ');
  let pending = null;
  const cancel = () => pending?.cancel();
  ipcMain.removeHandler(OAUTH_OPEN_CHANNEL);
  ipcMain.handle(OAUTH_OPEN_CHANNEL, async (event, input) => {
    checkSender(event);
    if (pending) throw new Error('認証が進行中です');
    const url = checkedAuthUrl(input, clerkHost);
    const flow = {};
    pending = flow;
    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawnProcess(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          child.kill();
          if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
        };
        flow.cancel = () => finish(new Error('認証をキャンセルしました'));
        const timer = setTimeout(() => finish(new Error('認証がタイムアウトしました')), 185000);
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > 32768) finish(new Error('認証応答が不正です')); else chunks.push(chunk);
        });
        child.on('error', () => finish(new Error('認証画面を開けませんでした')));
        child.on('close', () => finish());
        child.stdin.on('error', () => finish(new Error('認証画面を開けませんでした')));
        child.stdin.end(JSON.stringify({ url, callbackScheme, clerkHost }));
      });
      checkSender(event);
      let result;
      let payload;
      try { payload = JSON.parse(output); }
      catch { throw new Error('認証をキャンセルしたか、完了できませんでした'); }
      if (Number.isSafeInteger(payload?.errorCode)) {
        throw new Error(`macOS認証セッションを完了できませんでした（コード ${payload.errorCode}）`);
      }
      try { result = checkedAuthCallback(payload?.callbackUrl, callbackScheme); }
      catch { throw new Error('認証をキャンセルしたか、完了できませんでした'); }
      focusWindow();
      return result;
    } finally { if (pending === flow) pending = null; }
  });
  return { cancel };
}
