import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBizencoreMcp } from '../../api/_lib/mcpServer.ts';
import { profiles, desktopMcpSite } from './release-config.mjs';
import { checkWorkScope } from './task-runner.mjs';

export const DEV_CONVEX = profiles.preview.convexUrl;
const BODY_LIMIT = 2 * 1024 * 1024;

// Only a per-pane capability reaches the CLI. The Clerk JWT stays in the main process.
export async function createDesktopMcp({ access, readApp, convexUrl = DEV_CONVEX, fetchData = fetch }) {
  const site = desktopMcpSite(convexUrl);
  const capabilities = new Map();
  const instance = createBizencoreMcp({
    signingKey: randomBytes(32), readApp: () => readFile(readApp, 'utf8'),
    fetchData: async (ctx, operation, body) => {
      const token = ctx.http?.authInfo?.token;
      const capability = capabilities.get(token);
      const grant = access();
      if (!capability || capability.generation !== grant.generation || capability.userId !== grant.userId) throw new Error('Desktop MCP access expired');
      checkWorkScope(capability.policy, operation, body);
      const scopedCompletion = Boolean(capability.policy && operation === 'complete');
      if (!capabilities.has(token) || access().generation !== capability.generation) throw new Error('Desktop MCP access expired');
      const response = await fetchData(`${site}/desktop-mcp/${scopedCompletion ? 'complete-scoped' : operation}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([capability.controller.signal, AbortSignal.timeout(15000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ ...body, clientId: `desktop-${capability.agent}`,
          ...(scopedCompletion ? { allowedTaskIds: capability.policy.taskIds } : {}),
        }),
      });
      if (scopedCompletion && response.status === 404) throw new Error('完了処理のサーバー更新が必要です。アプリとサーバーの対応版を確認してください');
      const payload = await response.json();
      if (!capabilities.has(token) || access().generation !== capability.generation) throw new Error('Desktop MCP access expired');
      if (!response.ok) throw new Error(payload?.error ?? `Desktop MCP HTTP ${response.status}`);
      return payload;
    },
  });
  let origin;
  const server = createServer(async (incoming, outgoing) => {
    const reject = status => { outgoing.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); outgoing.end('Desktop MCP unavailable'); };
    try {
      // A browser cannot use this endpoint, including through DNS rebinding.
      if (incoming.headers.host !== new URL(origin).host || incoming.headers.origin || incoming.url !== '/mcp') return reject(403);
      if (!['POST', 'GET', 'DELETE'].includes(incoming.method)) return reject(405);
      const token = (incoming.headers.authorization ?? '').replace(/^Bearer /, '');
      const capability = capabilities.get(token);
      const grant = access();
      if (!capability || grant.generation !== capability.generation || grant.userId !== capability.userId) return reject(401);
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > BODY_LIMIT) return reject(413);
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(`${origin}/mcp`, {
        method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      request.auth = { token, clientId: capability.paneId, scopes: [], extra: { userId: grant.userId } };
      const response = await instance.handler(request);
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store' });
      if (response.body) {
        const reader = response.body.getReader();
        outgoing.once('close', () => { void reader.cancel().catch(() => {}); });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || outgoing.destroyed) break;
            outgoing.write(value);
          }
        } finally { reader.releaseLock(); }
      }
      outgoing.end();
    } catch { if (!outgoing.headersSent) reject(401); else outgoing.end(); }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  function revoke(token) { const capability = capabilities.get(token); capability?.controller.abort(); capabilities.delete(token); }
  async function readTask(taskId, signal) {
    const grant = access();
    const response = await fetchData(`${site}/desktop-mcp/get`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ taskId, clientId: 'desktop-codex' }),
    });
    const payload = await response.json();
    if (!response.ok || access().generation !== grant.generation || access().userId !== grant.userId) throw new Error('最新のタスクを取得できませんでした');
    return payload;
  }
  return {
    readTask,
    issue(paneId, agent, policy) {
      if (!['codex', 'claude'].includes(agent)) throw new Error('Unsupported agent');
      const grant = access();
      const token = randomBytes(32).toString('base64url');
      capabilities.set(token, { paneId, agent, policy, userId: grant.userId, generation: grant.generation, controller: new AbortController() });
      return { url: `${origin}/mcp`, token };
    },
    revoke,
    revokeAll() { for (const token of capabilities.keys()) revoke(token); },
    async close() { for (const token of capabilities.keys()) revoke(token); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
