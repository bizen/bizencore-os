import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { getFunctionName } from 'convex/server';

const compiled = await build({ entryPoints: ['convex/http.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { default: router } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const endpoint = '/desktop-mcp/complete-scoped';
const production = {
  CONVEX_CLOUD_URL: 'https://good-chinchilla-15.convex.cloud',
  DESKTOP_MCP_PRODUCTION_ENABLED: 'true',
  DESKTOP_MCP_ISSUER: 'https://clerk.bizencore.com',
  MCP_SHARED_SECRET: 'fixture-secret-not-a-production-token',
};

function fixture() {
  const calls = [];
  const state = { identity: { subject: 'account-a', issuer: production.DESKTOP_MCP_ISSUER }, deleted: false };
  const ctx = {
    auth: { getUserIdentity: async () => state.identity },
    runQuery: async ref => { assert.equal(getFunctionName(ref), 'accountDeletion:job'); return state.deleted ? {} : null; },
    runMutation: async (ref, args) => { calls.push({ name: getFunctionName(ref), args }); return { done: true }; },
  };
  const call = (body, path = endpoint, headers = {}) => router.lookup(path, 'POST')[0]._handler(ctx,
    new Request(`https://good-chinchilla-15.convex.site${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }));
  return { state, calls, call };
}

test('scoped HTTP completion is desktop-only, authenticated and preserves legacy callers', async () => {
  const previous = Object.fromEntries(Object.keys(production).map(key => [key, process.env[key]]));
  Object.assign(process.env, production);
  try {
    assert.ok(router.lookup(endpoint, 'POST'));
    assert.ok(!router.lookup('/mcp/complete-scoped', 'POST'));
    const { state, calls, call } = fixture();
    const identity = state.identity;
    const input = { taskId: 'task-a', allowedTaskIds: ['task-a'], userId: 'forged-account', clientName: 'forged-client', clientId: 'desktop-codex' };
    state.identity = null;
    assert.equal((await call(input)).status, 401);
    state.identity = { ...identity, issuer: 'https://untrusted.example' };
    assert.equal((await call(input)).status, 401);
    state.identity = identity;
    process.env.DESKTOP_MCP_PRODUCTION_ENABLED = 'false';
    assert.equal((await call(input)).status, 401);
    process.env.DESKTOP_MCP_PRODUCTION_ENABLED = 'true';
    state.deleted = true;
    assert.equal((await call(input)).status, 403);
    state.deleted = false;
    assert.equal((await call({ taskId: 'task-a' })).status, 400);
    assert.equal(calls.length, 0, 'rejected requests never reach a mutation');
    assert.equal((await call(input)).status, 200);
    assert.deepEqual(calls[0], { name: 'mcpTasks:complete', args: {
      userId: 'account-a', taskId: 'task-a', done: undefined, clientName: 'Codex', allowedTaskIds: ['task-a'],
    } });
    assert.equal((await call({ ...input, clientId: 'desktop-claude' })).status, 200);
    assert.equal(calls.findLast(call => call.name === 'mcpTasks:complete').args.clientName, 'Claude Code');
    assert.equal((await call({ userId: 'legacy-account', taskId: 'task-a', done: false }, '/mcp/complete', {
      Authorization: `Bearer ${production.MCP_SHARED_SECRET}`,
    })).status, 200);
    const legacy = calls.findLast(call => call.name === 'mcpTasks:complete').args;
    assert.equal(legacy.userId, 'legacy-account'); assert.equal(legacy.done, false);
    assert.equal(Object.hasOwn(legacy, 'allowedTaskIds'), false, 'ordinary MCP completion keeps its existing behavior');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
