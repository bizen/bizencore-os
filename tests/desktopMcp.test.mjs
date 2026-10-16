import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { getFunctionName } from 'convex/server';
import { codexMcpOverrides, isolatedMcpLaunch, verifyCodexMcp, MCP_TOKEN_ENV } from '../desktop/electron/mcp-launch.mjs';

async function load(file) {
  const { outputFiles } = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { desktopMcpIdentity, DESKTOP_DEV_CONVEX_URL } = await load('convex/lib/desktopMcp.ts');
const { default: router } = await load('convex/http.ts');
const { createDesktopMcp } = await load('desktop/electron/dev-mcp.mjs');
const taskHandlers = await load('convex/mcpTasks.ts');
const env = { DESKTOP_MCP_ENABLED: 'true', CONVEX_CLOUD_URL: DESKTOP_DEV_CONVEX_URL, DESKTOP_MCP_ISSUER: 'https://grown-gorilla-52.clerk.accounts.dev' };

test('production desktop MCP needs its own explicit enable flag and production issuer', () => {
  const production = { CONVEX_CLOUD_URL: 'https://good-chinchilla-15.convex.cloud', DESKTOP_MCP_ISSUER: 'https://clerk.bizencore.com', DESKTOP_MCP_PRODUCTION_ENABLED: 'true' };
  const identity = { subject: 'production-user', issuer: production.DESKTOP_MCP_ISSUER };
  assert.equal(desktopMcpIdentity(identity, production), 'production-user');
  assert.equal(desktopMcpIdentity(identity, { ...production, DESKTOP_MCP_PRODUCTION_ENABLED: '', DESKTOP_MCP_ENABLED: 'true' }), undefined);
  assert.equal(desktopMcpIdentity(identity, { ...production, CONVEX_CLOUD_URL: DESKTOP_DEV_CONVEX_URL }), undefined);
  assert.equal(desktopMcpIdentity({ ...identity, issuer: env.DESKTOP_MCP_ISSUER }, production), undefined);
  assert.equal(desktopMcpIdentity(null, production), undefined);
});

test('desktop MCP requires explicit development deployment, issuer and authenticated identity', () => {
  const identity = { subject: 'alice', issuer: env.DESKTOP_MCP_ISSUER };
  assert.equal(desktopMcpIdentity(identity, env), 'alice');
  for (const override of [{ DESKTOP_MCP_ENABLED: '' }, { CONVEX_CLOUD_URL: 'https://good-chinchilla-15.convex.cloud' }, { DESKTOP_MCP_ISSUER: 'https://clerk.bizencore.com' }]) {
    assert.equal(desktopMcpIdentity(identity, { ...env, ...override }), undefined);
  }
  assert.equal(desktopMcpIdentity(null, env), undefined);
  assert.equal(desktopMcpIdentity({ ...identity, issuer: 'https://clerk.bizencore.com' }, env), undefined);
});

test('session HTTP routes ignore spoofed account IDs, reject deletion and retain production shared-secret auth', async () => {
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const oldSecret = process.env.MCP_SHARED_SECRET;
  Object.assign(process.env, env); process.env.MCP_SHARED_SECRET = 'fixture-secret';
  let identity = { subject: 'alice', issuer: env.DESKTOP_MCP_ISSUER }, deleting = false, invalidToken = false;
  const calls = [];
  const ctx = {
    auth: { getUserIdentity: async () => { if (invalidToken) throw Error('Invalid token'); return identity; } },
    runQuery: async (ref, args) => { const name = getFunctionName(ref); calls.push({ name, args }); return name === 'accountDeletion:job' ? (deleting ? {} : null) : { tasks: [] }; },
    runMutation: async (ref, args) => { calls.push({ name: getFunctionName(ref), args }); return {}; },
  };
  const request = (route, token = 'ignored') => router.lookup(route, 'POST')[0]._handler(ctx, new Request(`https://dazzling-setter-393.convex.site${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'bob', clientId: 'production-client', clientName: 'Spoof' }),
  }));
  try {
    assert.equal((await request('/desktop-mcp/list')).status, 200);
    const read = calls.find(call => call.name === 'mcpTasks:list'); assert.equal(read.args.userId, 'alice');
    const touch = calls.find(call => call.name === 'sync:touchMcpConnection'); assert.equal(touch.args.userId, 'alice'); assert.equal(touch.args.clientName, 'Codex');
    deleting = true; assert.equal((await request('/desktop-mcp/list')).status, 403);
    identity = null; assert.equal((await request('/desktop-mcp/list')).status, 401);
    const beforeInvalid = calls.length;
    invalidToken = true;
    assert.equal((await request('/desktop-mcp/list')).status, 401);
    assert.equal(calls.length, beforeInvalid, 'invalid authentication never reads or mutates account data');
    invalidToken = false;
    assert.equal((await request('/mcp/list')).status, 401);
    assert.equal((await request('/mcp/list', 'fixture-secret')).status, 200);
    assert.equal(calls.findLast(call => call.name === 'mcpTasks:list').args.userId, 'bob', 'production OAuth gateway contract unchanged');
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (oldSecret === undefined) delete process.env.MCP_SHARED_SECRET; else process.env.MCP_SHARED_SECRET = oldSecret;
  }
});

test('native launch overrides only its own process and refuses leaked production MCP servers', async () => {
  const cap = { url: 'http://127.0.0.1:54321/mcp', token: 'fixture-token-not-a-jwt' };
  const effective = [{ name: 'bizencore', enabled: true, transport: { type: 'streamable_http', url: cap.url, bearer_token_env_var: MCP_TOKEN_ENV } }];
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: JSON.stringify(calls.length === 1 ? [{ name: 'bizencore' }, { name: 'other' }] : effective) }; };
  const result = await isolatedMcpLaunch('codex', '/fixture/codex', '/fixture/folder', { PATH: '/fixture' }, cap, run);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.cwd, '/fixture/folder');
  assert.ok(result.args.some(arg => arg.includes('mcp_servers.other={command="/usr/bin/false",enabled=false}')));
  assert.equal(result.env[MCP_TOKEN_ENV], cap.token); assert.ok(!result.args.join(' ').includes(cap.token));
  assert.throws(() => verifyCodexMcp([...effective, { name: 'production', enabled: true }], cap.url), /隔離/);
  assert.throws(() => verifyCodexMcp([{ ...effective[0], transport: { ...effective[0].transport, url: 'https://app.bizencore.com/mcp' } }], cap.url), /隔離/);
  const claude = await isolatedMcpLaunch('claude', '/fixture/claude', '/fixture', {}, cap, async () => ({ stdout: '--strict-mcp-config --mcp-config' }));
  assert.equal(claude.args[0], '--strict-mcp-config'); assert.ok(!claude.args.join(' ').includes(cap.token));
  assert.ok(claude.args.join(' ').includes('${BIZENCORE_DESKTOP_MCP_TOKEN}'));
});

test('work tool approvals and loopback transport share one complete override, with planning read-only', () => {
  const url = 'http://127.0.0.1:54321/mcp';
  for (const mode of ['execute', 'decompose']) {
    const args = codexMcpOverrides([], url, mode);
    assert.equal(args.length, 4);
    assert.equal(args[1], 'features.apps=false');
    assert.ok(args[3].includes(`url="${url}"`));
    assert.ok(args[3].includes('work_on_task={approval_mode="approve"}'));
    assert.equal(args[3].includes('complete_task={approval_mode="approve"}'), mode === 'execute');
    if (mode === 'decompose') assert.ok(args[3].includes('enabled_tools=["work_on_task","get_task"]'));
  }
  assert.ok(!codexMcpOverrides([], url)[3].includes('approval_mode'));
  assert.throws(() => codexMcpOverrides([], url, 'invalid'), /Invalid work mode/);
});

test('loopback tools use refreshed JWTs and lose access on pane revocation, logout or account change', async () => {
  let grant = { userId: 'alice', generation: 1, token: 'fixture-jwt-1' };
  const calls = [];
  const local = await createDesktopMcp({ access: () => { if (!grant) throw Error('signed out'); return grant; }, readApp: '/not-needed',
    fetchData: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ task: { id: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', text: 'Fresh task', done: false, subtasks: [], attachments: [] } });
    },
  });
  const cap = local.issue('pane-1', 'codex');
  const rpc = async (method, params, overrides = {}) => fetch(cap.url, { method: 'POST', headers: {
    Authorization: `Bearer ${cap.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...overrides,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).status, 200);
    const result = await rpc('tools/call', { name: 'work_on_task', arguments: { task_id: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04' } });
    assert.equal(result.status, 200); assert.match(await result.text(), /Fresh task/);
    assert.equal(calls[0].url, 'https://dazzling-setter-393.convex.site/desktop-mcp/get');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-jwt-1');
    assert.equal(JSON.parse(calls[0].options.body).userId, undefined);
    grant.token = 'fixture-jwt-2';
    await (await rpc('tools/call', { name: 'get_task', arguments: { task_id: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04' } })).text();
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fixture-jwt-2');
    assert.equal((await rpc('tools/list', {}, { Origin: 'https://evil.example' })).status, 403);
    local.revoke(cap.token); assert.equal((await rpc('tools/list', {})).status, 401);
    const second = local.issue('pane-2', 'claude'); grant = { ...grant, userId: 'bob', generation: 2 };
    assert.equal((await fetch(second.url, { method: 'POST', headers: { Authorization: `Bearer ${second.token}` } })).status, 401);
    grant = null; local.revokeAll(); assert.equal((await rpc('tools/list', {})).status, 401);
  } finally { await local.close(); }
});

test('scoped task execution enforces read-only planning, selected IDs and child-by-child completion over real MCP transport', async () => {
  const id = '370b6a1f-e4be-4e60-8bb8-8295a4f77e04';
  const childId = '662a5ff1-a990-4c90-a9bd-2a773844da3c';
  let childDone = false;
  const calls = [];
  const local = await createDesktopMcp({ access: () => ({ userId: 'fixture', generation: 1, token: 'fixture-jwt' }), readApp: '/unused',
    fetchData: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/complete-scoped')) {
        assert.deepEqual(JSON.parse(options.body).allowedTaskIds, [id, childId]);
        return childDone ? Response.json({ done: true }) : Response.json({ error: 'complete unfinished descendants first' }, { status: 400 });
      }
      return Response.json(url.endsWith('/get') ? { task: { id, text: 'Fixture task', done: false, subtasks: [{ id: childId, text: 'Child', done: childDone }] } } : { done: true });
    },
  });
  const rpc = (cap, name, args) => fetch(cap.url, { method: 'POST', headers: { Authorization: `Bearer ${cap.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  try {
    const plan = local.issue('plan', 'codex', { taskIds: [id, childId], readOnly: true });
    await (await rpc(plan, 'complete_task', { task_id: id })).text();
    assert.equal(calls.length, 0, 'planning never forwards mutations');
    await (await rpc(plan, 'get_task', { task_id: 'outside' })).text();
    assert.equal(calls.length, 0, 'unrelated task reads are rejected too');
    const work = local.issue('work', 'claude', { taskIds: [id, childId], readOnly: false });
    const unfinished = await (await rpc(work, 'complete_task', { task_id: id })).text();
    assert.match(unfinished, /complete unfinished descendants first/);
    assert.equal(calls.filter(call => call.url.endsWith('/complete')).length, 0, 'scoped work never uses the legacy bulk-completion endpoint');
    childDone = true;
    await (await rpc(work, 'complete_task', { task_id: id })).text();
    assert.equal(calls.filter(call => call.url.endsWith('/complete-scoped')).length, 2);
    await (await rpc(work, 'record_task_progress', { task_id: id, remaining_subtasks: [{ text: 'Unapproved task' }] })).text();
    assert.equal(calls.filter(call => call.url.endsWith('/record-progress')).length, 0);
  } finally { await local.close(); }
});

test('scoped completion carries immutable policy through HTTP and rejects a concurrent child in the real mutation', async () => {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const parent = '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', child = '662a5ff1-a990-4c90-a9bd-2a773844da3c';
  const row = (id, parentId) => ({ _id: id, userId: 'fixture', itemId: id, updatedAt: 1,
    payload: JSON.stringify({ id, parentId, type: 'task', text: id, order: 0, done: false, createdAt: 1, updatedAt: 1 }) });
  const rows = { syncItems: [row(parent, null)], accountDeletions: [], fileOwners: [] };
  const forwarded = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'fixture', issuer: env.DESKTOP_MCP_ISSUER }) },
    db: {
      query(table) {
        const filters = [];
        const q = { eq: (key, value) => { filters.push([key, value]); return q; } };
        const query = { withIndex: (_name, apply) => { apply(q); return query; },
          collect: async () => (rows[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value)),
          unique: async () => (await query.collect())[0] ?? null };
        return query;
      },
      patch: async (id, patch) => Object.assign(rows.syncItems.find(row => row._id === id), patch),
    },
    runQuery: async ref => { assert.equal(getFunctionName(ref), 'accountDeletion:job'); return null; },
    runMutation: async (ref, args) => {
      if (getFunctionName(ref) === 'sync:touchMcpConnection') return;
      assert.equal(getFunctionName(ref), 'mcpTasks:complete');
      return taskHandlers.complete._handler(ctx, args);
    },
  };
  const local = await createDesktopMcp({ access: () => ({ userId: 'fixture', generation: 1, token: 'fixture-token' }), readApp: '/unused',
    fetchData: async (url, options) => {
      forwarded.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      if (rows.syncItems.length === 1) rows.syncItems.push(row(child, parent));
      const handler = router.lookup(new URL(url).pathname, 'POST')[0];
      assert.ok(handler);
      return handler._handler(ctx, new Request(url, options));
    },
  });
  const rpc = async (cap, taskId) => {
    const response = await fetch(cap.url, { method: 'POST', headers: {
      Authorization: `Bearer ${cap.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'complete_task', arguments: { task_id: taskId, allowedTaskIds: [parent, child] },
    } }) });
    return response.text();
  };
  try {
    const policy = { taskIds: [parent], readOnly: false };
    const cap = local.issue('parent-pane', 'codex', policy);
    const denied = await rpc(cap, parent);
    assert.match(denied, /outside the approved completion scope/);
    assert.deepEqual(forwarded[0].body.allowedTaskIds, [parent], 'tool arguments cannot expand the native policy');
    assert.ok(rows.syncItems.every(row => JSON.parse(row.payload).done === false));
    const missingScope = await router.lookup('/desktop-mcp/complete-scoped', 'POST')[0]._handler(ctx,
      new Request('https://dazzling-setter-393.convex.site/desktop-mcp/complete-scoped', { method: 'POST', body: JSON.stringify({ taskId: parent }) }));
    assert.equal(missingScope.status, 400);
    assert.ok(rows.syncItems.every(row => JSON.parse(row.payload).done === false));
    assert.ok(!router.lookup('/mcp/complete-scoped', 'POST'), 'scoped endpoint is desktop-only');
    const childCap = local.issue('child-pane', 'claude', { taskIds: [child], readOnly: false });
    assert.doesNotMatch(await rpc(childCap, child), /"isError":true/);
    const expanded = local.issue('new-confirmed-pane', 'codex', { taskIds: [parent, child], readOnly: false });
    assert.doesNotMatch(await rpc(expanded, parent), /"isError":true/);
    assert.ok(rows.syncItems.every(row => JSON.parse(row.payload).done));
    assert.ok(forwarded.every(call => call.path === '/desktop-mcp/complete-scoped'), 'no preflight or legacy fallback');
  } finally {
    await local.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('an older backend cannot silently downgrade scoped completion to bulk completion', async () => {
  const calls = [];
  const local = await createDesktopMcp({ access: () => ({ userId: 'fixture', generation: 1, token: 'fixture-token' }), readApp: '/unused',
    fetchData: async url => { calls.push(url); return Response.json({ error: 'Not found' }, { status: 404 }); },
  });
  try {
    const cap = local.issue('fixture', 'codex', { taskIds: ['parent'], readOnly: false });
    const response = await fetch(cap.url, { method: 'POST', headers: {
      Authorization: `Bearer ${cap.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_task', arguments: { task_id: 'parent' } } }) });
    assert.match(await response.text(), /サーバー更新が必要/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/complete-scoped'));
  } finally { await local.close(); }
});
