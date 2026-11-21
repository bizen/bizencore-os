import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { getFunctionName } from 'convex/server';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const [bot, tasks, { grokBotHttp, grokBotOAuthToken }, mcp, notifications, oauth] = await Promise.all([
  load('convex/grokBot.ts'), load('convex/mcpTasks.ts'), load('convex/lib/grokBotHttp.ts'), load('api/grok-bot.ts'), load('convex/notifications.ts'), load('api/grok-bot-oauth.ts'),
]);
const token = 'a'.repeat(43);
const config = { userId: 'alice', labelId: 'label', token, webhookUrl: 'https://grok-bot.test/trigger', webhookKey: 'test-key' };

function fixture(t) {
  t.mock.method(Date, 'now', () => now);
  const original = process.env.GROK_BOT_PILOT;
  process.env.GROK_BOT_PILOT = JSON.stringify(config);
  t.after(() => {
    if (original === undefined) delete process.env.GROK_BOT_PILOT;
    else process.env.GROK_BOT_PILOT = original;
  });
  let now = Date.parse('2026-11-13T12:00:00+11:00');
  let actor = 'alice';
  let next = 0;
  const jobs = [];
  const rows = {
    accountDeletions: [], taskWork: [], syncItems: [], grokBotSchedules: [], grokBotAssignments: [], grokBotSkins: [], grokBotDelegations: [], grokBotProposals: [], grokBotDeferrals: [], mcpIdempotency: [],
    taskRejections: [], grokBotNorms: [],
    notificationDevices: [], notificationDeliveries: [], fileOwners: [],
    userPreferences: [{ userId: 'alice', timeZone: 'Australia/Melbourne' }],
  };
  const get = async id => Object.values(rows).flat().find(row => row._id === id) ?? null;
  const ctx = {
    auth: { getUserIdentity: async () => actor ? { subject: actor } : null },
    scheduler: { runAfter: async (_delay, ref, args) => jobs.push({ name: getFunctionName(ref), args }) },
    db: {
      get, normalizeId: (table, id) => id.toLowerCase().startsWith(table.toLowerCase() + '-') ? id : null,
      query(table) {
        const checks = [];
        let descending = false;
        const index = {
          eq(key, value) { checks.push(row => row[key] === value); return index; },
          gt(key, value) { checks.push(row => row[key] > value); return index; },
          gte(key, value) { checks.push(row => row[key] >= value); return index; },
          lt(key, value) { checks.push(row => row[key] < value); return index; },
          lte(key, value) { checks.push(row => row[key] <= value); return index; },
        };
        const query = {
          withIndex(_name, apply) { apply(index); return query; },
          order(value) { descending = value === 'desc'; return query; },
          async collect() { const found = rows[table].filter(row => checks.every(check => check(row))); return descending ? found.reverse() : found; },
          async take(count) { return (await query.collect()).slice(0, count); },
          async unique() { const found = await query.collect(); assert.ok(found.length <= 1); return found[0] ?? null; },
        };
        return query;
      },
      async insert(table, value) {
      const id = `${table === 'grokBotAssignments' ? table.toLowerCase() : table}-${++next}`;
        rows[table].push({ ...value, _id: id, _creationTime: now });
        return id;
      },
      async patch(id, value) { Object.assign(await get(id), value); },
      async delete(id) {
        const table = Object.keys(rows).find(table => id.startsWith(table + '-') || id.startsWith(table.toLowerCase() + '-'));
        rows[table] = rows[table].filter(row => row._id !== id);
      },
    },
    async runQuery(ref, args) { return invoke(getFunctionName(ref), args); },
    async runMutation(ref, args) { return invoke(getFunctionName(ref), args); },
  };
  const invoke = (name, args) => {
    const [module, fn] = name.split(':');
    return ({ grokBot: bot, mcpTasks: tasks, notifications })[module][fn]._handler(ctx, args);
  };
  const seed = (id, parentId, type = 'task', userId = 'alice', properties = {}) => rows.syncItems.push({
    _id: `syncItems-${++next}`, itemId: id, userId, updatedAt: now,
    payload: JSON.stringify({ id, type, parentId, text: id, order: 0, done: false, createdAt: now, ...properties }),
  });
  seed('label', null, 'section'); seed('mine', 'label'); seed('nested', 'mine');
  seed('other-label', null, 'section'); seed('other', 'other-label');
  seed('foreign-section', 'mine', 'section'); seed('foreign-nested', 'foreign-section');
  seed('another-user', 'label', 'task', 'bob');
  return {
    ctx, rows, jobs, seed, identify: user => { actor = user; }, setTime: time => { now = Date.parse(time); },
    call: (fn, args = {}) => invoke(`grokBot:${fn}`, args), invoke,
    http: (operation, args = {}, bearer = token) => grokBotHttp._handler(ctx, new Request('https://terminal.test/grok-bot', {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, args, userId: 'spoofed', labelId: 'other-label' }),
    })),
  };
}

const web = { expectedUserId: 'alice' };
const task = { userId: 'alice', taskId: 'mine' };
/** The smallest complete card: a free-text question. */
const infoCard = headline => ({ kind: 'info', headline, context: '判断の背景です。', checks: ['対象の範囲'] });
/** What a completion needs once it waits for review. */
const reviewed = { headline: '下書きを仕上げた', checks: ['見出しの表記'] };

test('label connections isolate credentials, questions, delegation and scheduled patrols', async t => {
  const f = fixture(t);
  delete process.env.GROK_BOT_PILOT;
  const connect = (labelId, name, token, route = labelId) => f.call('addAssignment', {
    ...web, labelId, name, token, webhookUrl: `https://api2.cursor.sh/automations/webhook/${route}`, webhookKey: `key-${labelId}`,
  });
  const keyA = 'b'.repeat(64);
  const keyB = 'c'.repeat(64);
  const keyC = 'd'.repeat(64);
  await assert.rejects(f.call('addAssignment', { ...web, labelId: 'label', name: 'Unsafe', token: keyA,
    webhookUrl: 'https://api2.cursor.sh@127.0.0.1/automations/webhook/evil', webhookKey: 'key' }));
  f.identify('bob');
  await assert.rejects(connect('label', 'Research Bot', keyA));
  f.identify('alice');
  await connect('label', 'Research Bot', keyA);
  await connect('other-label', 'Dev Bot', keyB);
  await assert.rejects(connect('label', 'Duplicate', keyC));
  const [research, dev] = f.rows.grokBotAssignments;
  assert.deepEqual(await f.call('assignments', web), [
    { id: research._id, labelId: 'label', name: 'Research Bot', connectorName: undefined, connectorConnected: false,
      webhookConfigured: true, connected: false, managed: true, skin: undefined, defaultMode: 'review' },
    { id: dev._id, labelId: 'other-label', name: 'Dev Bot', connectorName: undefined, connectorConnected: false,
      webhookConfigured: true, connected: false, managed: true, skin: undefined, defaultMode: 'review' },
  ]);
  assert.equal((await f.http('auth', {}, keyA)).status, 200);
  assert.equal((await f.http('auth', {}, keyB)).status, 200);
  assert.equal((await f.call('assignments', web))[0].connected, true);
  assert.equal((await f.http('assigned_tasks', { task_id: 'other' }, keyA)).status, 400);
  assert.equal((await f.http('assigned_tasks', { task_id: 'mine' }, keyB)).status, 400);
  const add = (title, key) => f.http('add_assigned_task', { title, idempotency_key: 'same-idempotency-key' }, key);
  assert.equal((await add('Research item', keyA)).status, 200);
  assert.equal((await add('Dev item', keyB)).status, 200);

  await f.call('setDelegation', { ...web, taskId: 'other', execute: true });
  const ask = (bearer, task_id) => f.http('request_decision', { task_id, ...infoCard('Which option?'), idempotency_key: 'ask' }, bearer);
  const question = await (await ask(keyB, 'other')).json();
  assert.equal((await ask(keyA, 'mine')).status, 200);
  assert.equal((await f.call('inbox', web)).pending.length, 2);

  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization, payload: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  });
  await f.call('reply', { ...web, id: question.id, answer: 'Option A' });
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  assert.deepEqual(calls[0], {
    url: 'https://api2.cursor.sh/automations/webhook/other-label', authorization: 'Bearer key-other-label',
    payload: { trigger: 'reply', task_id: 'other', question_id: question.id },
  });

  await f.call('saveSchedule', { ...web, labelId: 'label', enabled: true, time: '13:00' });
  await f.call('saveSchedule', { ...web, labelId: 'other-label', enabled: true, time: '14:00' });
  f.setTime('2026-11-13T13:00:00+11:00');
  await bot.dispatchDuePatrol(f.ctx, Date.now());
  await bot.dispatchDuePatrol(f.ctx, Date.now());
  assert.equal(f.jobs.length, 2);
  await f.invoke(f.jobs[1].name, f.jobs[1].args);
  f.setTime('2026-11-13T14:00:00+11:00');
  await bot.dispatchDuePatrol(f.ctx, Date.now());
  await f.invoke(f.jobs[2].name, f.jobs[2].args);
  assert.deepEqual(calls.slice(1).map(row => [row.url.split('/').at(-1), row.payload.trigger]), [['label', 'patrol'], ['other-label', 'patrol']]);

  await f.call('rotateAssignmentToken', { ...web, labelId: 'other-label', token: keyC });
  assert.equal((await f.http('auth', {}, keyB)).status, 401);
  assert.equal((await f.http('auth', {}, keyC)).status, 200);
  await f.call('removeAssignment', { ...web, labelId: 'other-label' });
  assert.equal((await f.http('auth', {}, keyC)).status, 401);
  assert.equal((await f.call('inbox', web)).answered.length, 0);
  await connect('other-label', 'New Dev Bot', keyB);
  const replacement = await (await f.http('assigned_tasks', { task_id: 'other' }, keyB)).json();
  assert.equal(replacement.bot_role, 'review');
  assert.deepEqual(replacement.work, []);
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'other' })).rows[0].canReply, false);
  assert.equal((await ask(keyB, 'other')).status, 200);
});

test('a nameless draft can verify the label before saving a working routine', async t => {
  const f = fixture(t);
  const args = { ...web, labelId: 'other-label' };
  const key = 'b'.repeat(64);
  const nextKey = 'c'.repeat(64);
  const webhookUrl = 'https://api2.cursor.sh/automations/webhook/dev';
  const connect = () => f.call('connectAssignmentWebhook', { ...args, webhookUrl, webhookKey: 'Authorization: Bearer dev-key' });
  const getAssignment = async () => (await f.call('assignments', web)).find(row => row.labelId === args.labelId);
  await f.call('addAssignment', { ...args, token: key });
  assert.equal(f.rows.grokBotAssignments[0].name, undefined);
  assert.equal((await getAssignment()).connectorName, 'Terminal · other-label · er-label');
  assert.equal((await f.http('auth', {}, key)).status, 200);
  assert.equal((await (await f.http('assigned_tasks', {}, key)).json()).label, 'other-label');
  const addTask = bearer => f.http('add_assigned_task', { title: 'Task', idempotency_key: 'key' }, bearer);
  assert.equal((await addTask(key)).status, 403);
  assert.equal((await getAssignment()).connectorConnected, true);
  assert.equal((await getAssignment()).connected, false);

  let status = 401;
  let rotateDuringCheck = false;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, webhookUrl);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer dev-key');
    assert.deepEqual(JSON.parse(init.body), { trigger: 'connection_check' });
    if (rotateDuringCheck) await f.call('rotateAssignmentToken', { ...args, token: nextKey });
    return new Response(null, { status });
  });
  f.identify('bob');
  await assert.rejects(connect());
  f.identify('alice');
  await assert.rejects(f.call('connectAssignmentWebhook', { ...args, webhookUrl: 'https://api2.cursor.sh@localhost/automations/webhook/dev', webhookKey: 'dev-key' }));
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(connect(), /一時停止/);
  assert.equal((await getAssignment()).webhookConfigured, false);
  status = 200;
  rotateDuringCheck = true;
  await assert.rejects(connect(), /接続設定が更新/);
  assert.equal((await getAssignment()).webhookConfigured, false);
  rotateDuringCheck = false;
  await connect();
  assert.equal((await getAssignment()).webhookConfigured, true);
  assert.equal((await getAssignment()).connected, false);
  assert.equal((await f.http('auth', {}, nextKey)).status, 200);
  assert.equal((await getAssignment()).connected, true);
  assert.equal((await addTask(nextKey)).status, 200);
});

test('guided OAuth authorizes only its label and rejects bad redirects, PKCE, expired and reused codes', async t => {
  const f = fixture(t);
  const previousSite = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = 'https://fixture.convex.site';
  t.after(() => {
    if (previousSite === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = previousSite;
  });
  const manual = 'b'.repeat(64);
  const assignment = await f.call('addAssignment', { ...web, labelId: 'other-label', token: manual });
  const origin = 'https://fixture.test';
  const endpoint = `${origin}/grok-bot/mcp/${assignment}`;
  const redirectUri = 'https://www.cursor.com/bot/mcp/oauth/callback';
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = 'a'.repeat(64);
  const approve = () => f.call('approveOAuth', { ...web, assignmentId: assignment, redirectUri, challenge,
    codeHash: createHash('sha256').update(code).digest('hex') });
  const redeem = (overrides = {}) => oauth.POST(new Request(`${origin}/grok-bot/token/${assignment}`, {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: 'grok-bot', code, code_verifier: verifier, redirect_uri: redirectUri, ...overrides,
    }),
  }));
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const request = new Request(url, init);
    return (new URL(url).pathname.endsWith('/token') ? grokBotOAuthToken : grokBotHttp)._handler(f.ctx, request);
  });
  const challengeResponse = await mcp.POST(new Request(endpoint));
  assert.equal(challengeResponse.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challengeResponse.headers.get('WWW-Authenticate'))[1];
  const metadata = await oauth.GET(new Request(metadataUrl)).json();
  assert.equal(metadata.resource, endpoint);
  const issuer = await oauth.GET(new Request(`${origin}/.well-known/oauth-authorization-server/grok-bot/oauth/${assignment}`)).json();
  assert.deepEqual(metadata.authorization_servers, [issuer.issuer]);
  assert.equal(issuer.token_endpoint, `${origin}/grok-bot/token/${assignment}`);
  const register = uris => oauth.POST(new Request(issuer.registration_endpoint, { method: 'POST', body: JSON.stringify({ redirect_uris: uris }) }));
  assert.equal((await register([redirectUri])).status, 201);
  assert.equal((await register(['https://www.cursor.com.attacker.test/bot/mcp/oauth/callback'])).status, 400);

  f.identify('bob');
  assert.equal(await f.call('oauthLabel', { expectedUserId: 'bob', assignment }), null);
  await assert.rejects(approve());
  f.identify('alice');
  assert.deepEqual(await f.call('oauthLabel', { ...web, assignment }), { id: assignment, name: 'other-label' });
  await approve();
  f.setTime('2026-11-13T12:03:00+11:00');
  assert.equal((await redeem()).status, 400);
  await approve();
  assert.equal((await redeem({ code_verifier: 'x'.repeat(43) })).status, 400);
  const response = await redeem();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { access_token: access } = await response.json();
  assert.match(access, /^[a-f0-9]{64}$/);
  assert.equal((await redeem()).status, 400);
  assert.equal((await f.http('auth', {}, manual)).status, 200);
  assert.equal((await f.http('auth', {}, access)).status, 401);
  const initialize = (url, bearer) => mcp.POST(new Request(url, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }),
  }));
  assert.equal((await initialize(endpoint, manual)).status, 401);
  assert.equal((await initialize(`${endpoint}2`, access)).status, 401);
  assert.equal((await initialize(endpoint, access)).status, 200);
  await f.call('rotateAssignmentToken', { ...web, labelId: 'other-label', token: 'c'.repeat(64) });
  assert.equal((await initialize(endpoint, access)).status, 401);
});

test('a Bot skin follows its assignment and can only be changed by its owner', async t => {
  const f = fixture(t);
  const skin = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfNTnYypiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB1ErxPNjOOsMAAAAASUVORK5CYII=';
  const args = { ...web, labelId: 'other-label', name: 'Dev Bot', token: 'b'.repeat(64),
    webhookUrl: 'https://api2.cursor.sh/automations/webhook/dev', webhookKey: 'dev-key' };
  await assert.rejects(f.call('addAssignment', { ...args, skin: 'https://tracker.test/avatar.png' }));
  await f.call('addAssignment', { ...args, skin });
  const [assigned] = await f.call('assignments', web);
  assert.equal(assigned.skin, skin);
  assert.equal((await f.call('assignments', web))[1].skin, undefined);
  f.identify('bob');
  await assert.rejects(f.call('setAssignmentSkin', { expectedUserId: 'bob', assignmentId: assigned.id, skin }));
  assert.deepEqual(await f.call('assignments', { expectedUserId: 'bob' }), []);
  f.identify('alice');
  await f.call('removeAssignment', { ...web, labelId: args.labelId });
  await f.call('addAssignment', args);
  const [replacement] = await f.call('assignments', web);
  assert.equal(replacement.skin, undefined);
  await assert.rejects(f.call('setAssignmentSkin', { ...web, assignmentId: assigned.id, skin }));
  await f.call('setAssignmentSkin', { ...web, assignmentId: replacement.id, skin });
  assert.equal((await f.call('assignments', web))[0].skin, skin);
});

test('the actual MCP route exposes only officer tools and cannot read or write outside the configured label', async t => {
  const f = fixture(t);
  const original = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = 'https://fixture.convex.site';
  t.after(() => {
    if (original === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = original;
  });
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url, 'https://fixture.convex.site/grok-bot');
    return grokBotHttp._handler(f.ctx, new Request(url, init));
  });
  async function rpc(method, params = {}, bearer = token) {
    const response = await mcp.POST(new Request('https://fixture.test/api/grok-bot', {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    const body = await response.text();
    return { status: response.status, payload: response.ok ? JSON.parse(body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: ')).slice(6) : body) : body };
  }
  assert.equal((await rpc('tools/list', {}, 'b'.repeat(43))).status, 401);
  assert.equal((await f.http('auth', {}, 'b'.repeat(43))).status, 401);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} });
  assert.equal(init.payload.result.serverInfo.name, 'bizencore-grok-bot');
  const { payload } = await rpc('tools/list');
  assert.deepEqual(payload.result.tools.map(tool => tool.name).sort(), ['add_assigned_task', 'assigned_tasks', 'claim_decision', 'propose', 'record_work_result', 'request_decision']);
  const schema = name => payload.result.tools.find(tool => tool.name === name).inputSchema.properties;
  assert.ok(['needs_review', 'assumptions', 'pr_head_sha'].every(key => key in schema('record_work_result')));
  assert.ok(['headline', 'checks'].every(key => key in schema('record_work_result')));
  assert.ok(['kind', 'headline', 'context', 'options', 'recommendation', 'checks', 'evidence'].every(key => key in schema('request_decision')));
  assert.deepEqual(payload.result.tools.find(tool => tool.name === 'request_decision').inputSchema.required.sort(), ['checks', 'context', 'headline', 'idempotency_key', 'kind', 'task_id']);
  const incomplete = await rpc('tools/call', { name: 'request_decision', arguments: { task_id: 'mine', kind: 'info', idempotency_key: 'k' } });
  assert.match(JSON.stringify(incomplete.payload), /headline.*one line .*context.*why this needs deciding now.*checks.*must actually look at/,
    'the Bot is told which fields are missing and what to write');
  assert.match(init.payload.result.instructions, /review_returned/);
  assert.match(init.payload.result.instructions, /review_approved.*--match-head-commit/);
  const data = await rpc('tools/call', { name: 'assigned_tasks', arguments: {} });
  const visible = JSON.parse(data.payload.result.content[0].text);
  assert.deepEqual(visible.tasks.map(row => row.id), ['mine', 'nested']);
  assert.ok(visible.tasks.every(row => row.bot_role === 'review'));
  for (const id of ['other', 'foreign-nested', 'another-user', 'label']) {
    assert.equal((await f.http('assigned_tasks', { task_id: id })).status, 400);
    assert.equal((await f.http('request_decision', { task_id: id, ...infoCard('Can I?'), idempotency_key: 'ask' })).status, 400);
  }
  assert.equal((await f.http('record_work_result', { task_id: 'mine', summary: 'Unsafe', links: ['javascript:alert(1)'], idempotency_key: 'bad' })).status, 400);
  const created = await (await f.http('add_assigned_task', { title: 'New issue', idempotency_key: 'found' })).json();
  assert.equal(JSON.parse(f.rows.syncItems.find(row => row.itemId === created.id).payload).parentId, 'label');
});

test('reply persists once, resumes by webhook, and applies a claimed answer with text-only work', async t => {
  const f = fixture(t);
  const question = await f.call('requestDecision', { ...task, ...infoCard('Proceed with A?'), key: 'ask' });
  assert.equal((await f.call('requestDecision', { ...task, ...infoCard('Proceed with A?'), key: 'ask' })).id, question.id);
  assert.equal((await f.call('inbox', web)).pending.length, 1);
  f.identify('bob');
  assert.equal(await f.call('inbox', web), null);
  await assert.rejects(f.call('reply', { ...web, id: question.id, answer: 'A' }));
  f.identify('alice');
  await f.call('reply', { ...web, id: question.id, answer: ' A ' });
  await f.call('reply', { ...web, id: question.id, answer: 'A' });
  assert.equal(f.jobs.length, 1);
  await assert.rejects(f.call('reply', { ...web, id: question.id, answer: 'B' }));
  const deliver = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, config.webhookUrl);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(init.body), { trigger: 'reply', task_id: 'mine', question_id: question.id });
    return new Response(null, { status: 500 });
  });
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  assert.equal((await f.call('inbox', web)).answered[0].wakeStatus, 'failed');
  deliver.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  f.setTime('2026-11-13T12:01:00+11:00');
  await f.call('retry', { ...web, id: question.id });
  await f.invoke(f.jobs[1].name, f.jobs[1].args);
  assert.equal((await f.call('inbox', web)).answered[0].wakeStatus, 'accepted');
  const claim = { ...task, questionId: question.id, claimKey: 'claim-one' };
  assert.deepEqual(await f.call('claimDecision', claim), { claimed: true, answer: 'A' });
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'claim-two' }), { claimed: false });
  const result = { ...task, summary: '再現手順を実行し、再発しないことを確認した。', links: [], complete: false, appliedQuestionId: question.id, claimKey: claim.claimKey, key: 'run1' };
  await assert.rejects(f.call('recordWorkResult', { ...result, claimKey: 'claim-two' }));
  const reported = await f.call('recordWorkResult', result);
  assert.equal((await f.call('recordWorkResult', result)).id, reported.id);
  assert.equal((await f.call('inbox', web)).answered.length, 0);
  const history = (await f.call('taskHistory', { ...web, taskId: task.taskId })).rows;
  assert.equal(history.find(row => row.id === question.id).status, 'applied');
  assert.equal(history.find(row => row.id === reported.id).text, result.summary);
  assert.deepEqual(history.find(row => row.id === reported.id).links, []);
});

test('completion uses the current version, respects child tasks and records a link only if provided', async t => {
  const f = fixture(t);
  const args = { ...task, taskId: 'nested', summary: '変更を反映しテストを実行。', links: ['https://example.test/pull/12'], complete: true, key: 'completion' };
  const version = (await f.call('assignedTasks', { userId: 'alice', taskId: 'nested' })).task_version;
  await assert.rejects(f.call('recordWorkResult', { ...args, expectedTaskVersion: version }), /review-only/);
  f.identify('bob');
  await assert.rejects(f.call('setDelegation', { ...web, taskId: 'nested', execute: true }));
  f.identify('alice');
  await f.call('setDelegation', { ...web, taskId: 'nested', execute: true });
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: true });
  assert.equal((await f.call('assignedTasks', { userId: 'alice', taskId: 'nested' })).bot_role, 'execute');
  await assert.rejects(f.call('recordWorkResult', { ...args, expectedTaskVersion: version - 1 }), /Task changed/);
  await assert.rejects(f.call('recordWorkResult', { ...args, taskId: 'mine', expectedTaskVersion: version }), /subtasks/);
  await f.call('setDelegation', { ...web, taskId: 'nested', execute: false });
  await assert.rejects(f.call('recordWorkResult', { ...args, expectedTaskVersion: version }), /review-only/);
  await f.call('setDelegation', { ...web, taskId: 'nested', execute: true });
  await f.call('recordWorkResult', { ...args, expectedTaskVersion: version });
  const { task: done, work } = await f.call('assignedTasks', { userId: 'alice', taskId: 'nested' });
  assert.equal(done.done, true);
  assert.deepEqual(work[0].links, args.links);
});

test('a user-set Melbourne time schedules one patrol per day and records webhook acceptance', async t => {
  const f = fixture(t);
  await assert.rejects(f.call('saveSchedule', { ...web, enabled: true, time: '25:00' }));
  await f.call('saveSchedule', { ...web, enabled: true, time: '03:15' });
  await f.invoke('notifications:collect');
  assert.equal(f.jobs.length, 0, 'saving after the selected time waits for the next day');
  f.setTime('2026-11-14T03:14:59+11:00');
  await f.invoke('notifications:collect');
  assert.equal(f.jobs.length, 0);
  f.setTime('2026-11-14T03:15:03+11:00');
  await f.invoke('notifications:collect');
  await f.invoke('notifications:collect');
  assert.equal(f.jobs.length, 1);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { trigger: 'patrol' });
    return new Response(null, { status: 200 });
  });
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await f.call('schedule', web), { timeZone: 'Australia/Melbourne', enabled: true, time: '03:15',
    times: ['03:15'], lastRunAt: Date.now(), lastStatus: 'accepted', nextCheckAt: undefined });
  await f.call('saveSchedule', { ...web, enabled: false, time: '06:45' });
  f.setTime('2026-11-15T06:45:05+11:00');
  await f.invoke('notifications:collect');
  assert.equal(f.jobs.length, 1);
});

test('morning notifications link to the inbox when there is an open decision', async t => {
  const f = fixture(t);
  f.setTime('2026-11-14T09:02:00+11:00');
  const deviceId = '662a5ff1-a990-4c90-a9bd-2a773844da3c';
  await f.invoke('notifications:save', { deviceId, platform: 'desktop', preferences: { morning: true, deadline: false, completion: false, morningTime: '09:00' } });
  await f.call('requestDecision', { ...task, ...infoCard('Proceed?'), key: 'ask' });
  await f.invoke('notifications:collect');
  const [notice] = await f.invoke('notifications:pending', { deviceId });
  assert.equal(notice.inbox, true);
  assert.equal(notice.title, '受信箱に対応待ちがあります');
  assert.equal(notice.body, '1件があなたの対応を待っています。');
});

const execute = (f, taskId, reviewCompletion) => f.call('setDelegation', { ...web, taskId, execute: true, ...(reviewCompletion ? { reviewCompletion } : {}) });
const versionOf = async (f, taskId, assignmentId) => (await f.call('assignedTasks', { userId: 'alice', assignmentId, taskId })).task_version;
const itemOf = (f, id) => JSON.parse(f.rows.syncItems.find(row => row.itemId === id).payload);

test('direct completion is unchanged while needs_review and always-review completions wait for approval', async t => {
  const f = fixture(t);
  for (const id of ['direct', 'judged', 'checked']) f.seed(id, 'label');
  for (const id of ['direct', 'judged']) await execute(f, id);
  await execute(f, 'checked', true);
  const done = { ...task, summary: '確認済み。', links: [], complete: true };
  await f.call('recordWorkResult', { ...done, taskId: 'direct', key: 'direct', expectedTaskVersion: await versionOf(f, 'direct') });
  assert.equal(itemOf(f, 'direct').done, true);
  assert.equal(itemOf(f, 'direct').completedBy, 'ai');

  const judged = { ...done, taskId: 'judged', links: ['https://example.test/pull/7'], expectedTaskVersion: await versionOf(f, 'judged') };
  await assert.rejects(f.call('recordWorkResult', { ...judged, needsReview: true, key: 'judged' }), /assumptions/);
  const response = await f.http('record_work_result', { task_id: 'judged', summary: judged.summary, links: judged.links, complete: true, ...reviewed,
    needs_review: true, assumptions: '締切が未記載のため今週末と仮定した。', expected_task_version: judged.expectedTaskVersion, idempotency_key: 'judged' });
  const submitted = await response.json();
  assert.equal(submitted.status, 'review');
  assert.equal(itemOf(f, 'judged').done, false);
  const args = { ...judged, ...reviewed, needsReview: true, assumptions: '締切が未記載のため今週末と仮定した。', key: 'judged' };
  assert.equal((await f.call('recordWorkResult', args)).id, submitted.id, 'a retry with the same key is idempotent');
  await assert.rejects(f.call('recordWorkResult', { ...args, key: 'judged-again' }), /awaiting the user’s review/);
  const listed = (await f.call('assignedTasks', { userId: 'alice' })).tasks.find(row => row.id === 'judged');
  assert.deepEqual([listed.awaiting_review, listed.review_required], [1, false]);
  const [pending] = (await f.call('inbox', web)).pending;
  assert.deepEqual([pending.id, pending.status, pending.assumptions, pending.links], [submitted.id, 'review', args.assumptions, judged.links]);

  await assert.rejects(f.call('recordWorkResult', { ...done, taskId: 'checked', key: 'bare', expectedTaskVersion: await versionOf(f, 'checked') }), /needs headline .* and checks/);
  const checked = await f.call('recordWorkResult', { ...done, ...reviewed, taskId: 'checked', key: 'checked', expectedTaskVersion: await versionOf(f, 'checked') });
  assert.equal(checked.status, 'review');
  assert.equal((await f.call('assignedTasks', { userId: 'alice', taskId: 'checked' })).review_required, true);
  assert.deepEqual((await f.call('taskHistory', { ...web, taskId: 'checked' })).reviewRequired, true);
  assert.equal(itemOf(f, 'checked').done, false);

  f.identify('bob');
  await assert.rejects(f.call('approveReview', { expectedUserId: 'bob', id: submitted.id }));
  f.identify('alice');
  f.seed('judged-child', 'judged');
  await assert.rejects(f.call('approveReview', { ...web, id: submitted.id }), /サブタスク/);
  assert.equal(itemOf(f, 'judged').done, false);
  await f.invoke('mcpTasks:complete', { userId: 'alice', taskId: 'judged-child' });
  await f.call('approveReview', { ...web, id: submitted.id });
  await f.call('approveReview', { ...web, id: submitted.id });
  assert.equal(itemOf(f, 'judged').done, true);
  assert.equal(itemOf(f, 'judged').completedBy, 'ai');
  assert.equal(f.rows.taskWork.find(row => row._id === submitted.id).status, 'approved');
  await assert.rejects(f.call('returnReview', { ...web, id: submitted.id, comment: 'やり直し' }), /対応済み/);
  assert.deepEqual((await f.call('inbox', web)).pending.map(row => row.taskId), ['checked']);
  assert.equal(f.jobs.length, 0, 'approval does not wake the Bot');
});

test('a returned review wakes the Bot, is claimed by one run and applied by the resubmission', async t => {
  const f = fixture(t);
  f.seed('draft', 'label');
  await execute(f, 'draft', true);
  const submit = async (key, extra = {}) => f.call('recordWorkResult', { ...task, taskId: 'draft', summary: '下書きを作成。', links: [], complete: true, ...reviewed,
    key, expectedTaskVersion: await versionOf(f, 'draft'), ...extra });
  const first = await submit('first');
  await assert.rejects(f.call('returnReview', { ...web, id: first.id, comment: '  ' }), /差し戻し/);
  f.identify('bob');
  await assert.rejects(f.call('returnReview', { expectedUserId: 'bob', id: first.id, comment: '見出しを直して' }));
  f.identify('alice');
  await f.call('returnReview', { ...web, id: first.id, comment: '見出しを直して' });
  await f.call('returnReview', { ...web, id: first.id, comment: '見出しを直して' });
  await assert.rejects(f.call('approveReview', { ...web, id: first.id }), /対応済み/);
  assert.equal(f.jobs.length, 1);
  const deliver = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { trigger: 'review_returned', task_id: 'draft', question_id: first.id });
    return new Response(null, { status: 500 });
  });
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  const inbox = await f.call('inbox', web);
  assert.deepEqual([inbox.pending.length, inbox.answered[0].status, inbox.answered[0].wakeStatus], [0, 'returned', 'failed']);
  deliver.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  await f.call('retry', { ...web, id: first.id });
  await f.invoke(f.jobs[1].name, f.jobs[1].args);
  assert.equal((await f.call('inbox', web)).answered[0].wakeStatus, 'accepted');

  const listed = (await f.call('assignedTasks', { userId: 'alice' })).tasks.find(row => row.id === 'draft');
  assert.deepEqual([listed.awaiting_review, listed.returned], [0, 1]);
  const feedback = (await f.call('assignedTasks', { userId: 'alice', taskId: 'draft' })).work.find(row => row.id === first.id);
  assert.deepEqual([feedback.status, feedback.answer, feedback.text], ['returned', '見出しを直して', '下書きを作成。']);
  await assert.rejects(submit('unapplied'), /Resolve pending decisions/);
  const claim = { ...task, taskId: 'draft', questionId: first.id };
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'run-one' }), { claimed: true, answer: '見出しを直して' });
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'run-two' }), { claimed: false });
  await assert.rejects(submit('stolen', { appliedQuestionId: first.id, claimKey: 'run-two' }), /active claim/);
  const second = await submit('second', { appliedQuestionId: first.id, claimKey: 'run-one' });
  assert.equal(second.status, 'review');
  assert.equal(f.rows.taskWork.find(row => row._id === first.id).status, 'revised');
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'run-one' }), { claimed: false });
  assert.deepEqual((await f.call('inbox', web)).pending.map(row => row.id), [second.id]);
});

test('a decision card names every problem at once, keeps options consistent and appears in every view', async t => {
  const f = fixture(t);
  const ask = (key, card) => f.call('requestDecision', { ...task, key, ...card });
  const rejects = (card, ...patterns) => assert.rejects(ask('bad', card), error => patterns.every(pattern => pattern.test(error.data)));
  const week = { label: ' 今週 ', consequence: '今週金曜に告知ページを公開します。', irreversible: true };
  const later = { label: '来週', consequence: '来週月曜まで下書きのままにします。' };
  const choice = { kind: 'choice', headline: '告知ページの公開日', context: '公開日が未定のまま告知文が仕上がりました。',
    options: [week, later], recommendation: { option: '来週', reason: '社内確認の時間が取れます。', confidence: 'medium' },
    checks: ['公開日の表記'], evidence: [{ url: 'https://example.test/draft', title: '下書き' }] };

  await rejects({}, /headline is missing/, /context is missing/, /checks must list 1 to 3/);
  await rejects({ ...choice, options: undefined, recommendation: undefined }, /options must be 2 to 4 for kind choice/, /recommendation is missing/);
  await rejects({ ...choice, options: [week, later, ...['a', 'b', 'c'].map(label => ({ label, consequence: 'x' }))] }, /2 to 4/);
  await rejects({ ...choice, kind: 'approval', options: [week, later, { label: '保留', consequence: 'x' }] }, /exactly 2 for kind approval/);
  await rejects({ ...choice, kind: 'info' }, /omitted for kind info/, /recommendation must be omitted/);
  await rejects({ ...choice, options: [week, { label: '来週' }] }, /options\[1\]\.consequence is missing/);
  await rejects({ ...choice, options: [week, { ...later, label: '今週' }] }, /distinct/);
  await rejects({ ...choice, recommendation: { option: '再来週', reason: 'r', confidence: 'low' } }, /must equal one of the option labels/);
  await rejects({ ...choice, recommendation: { option: '来週' } }, /recommendation\.reason is missing/, /confidence is missing/);
  await rejects({ ...choice, headline: 'あ'.repeat(81), checks: ['a', 'b', 'c', 'd'] }, /headline is 81 characters, at most 80/, /checks must list 1 to 3/);
  await rejects({ ...choice, evidence: [{ url: 'http://example.test/draft' }] }, /HTTPS/);
  assert.match((await json(f.http('request_decision', { task_id: 'mine', kind: 'info', context: '背景', checks: ['a'], idempotency_key: 'z' }))).body.error,
    /headline/, 'the route names the missing field');
  assert.equal((await f.http('request_decision', { task_id: 'mine', ...infoCard('Q'), kind: 'poll', idempotency_key: 'f' })).status, 400);
  assert.equal(f.rows.taskWork.length, 0, 'nothing incomplete reaches the user');

  const asked = await ask('choice', choice);
  assert.equal((await ask('choice', choice)).id, asked.id);
  await assert.rejects(ask('choice', { ...choice, checks: ['別の確認'] }), /Idempotency/);
  await assert.rejects(ask('again', choice), /already waiting/);
  const approval = await (await f.http('request_decision', { task_id: 'mine', kind: 'approval', headline: '告知文の公開', context: '文面が確定しました。',
    options: [{ label: '承認', consequence: '告知文を公開します。' }, { label: '却下', consequence: '下書きに戻します。' }],
    recommendation: { option: '承認', reason: '指摘はすべて反映済みです。', confidence: 'high' }, checks: ['見出し'], idempotency_key: 'approval' })).json();
  const info = await ask('info', infoCard('連絡先を教えてください'));
  const old = await f.ctx.db.insert('taskWork', { userId: 'alice', taskId: 'mine', key: 'old', text: '公開しますか。', status: 'waiting',
    kind: 'choice', options: ['今週', '来週'], recommendation: '来週', irreversible: true });

  const pick = row => ({ headline: row.headline, text: row.text, options: row.options, recommendation: row.recommendation, reason: row.recommendationReason,
    confidence: row.confidence, irreversible: row.irreversible, checks: row.checks, evidence: row.evidence });
  const expected = { headline: '告知ページの公開日', text: choice.context, options: [{ ...week, label: '今週' }, later], recommendation: '来週',
    reason: '社内確認の時間が取れます。', confidence: 'medium', irreversible: true, checks: ['公開日の表記'], evidence: choice.evidence };
  const work = (await f.call('assignedTasks', { userId: 'alice', taskId: 'mine' })).work;
  assert.deepEqual(pick(work.find(row => row.id === asked.id)), expected);
  assert.equal(work.find(row => row.id === approval.id).irreversible, undefined, 'no irreversible option, no irreversible card');
  assert.deepEqual(pick(work.find(row => row.id === info.id)), { ...pick({}), headline: '連絡先を教えてください', text: '判断の背景です。', checks: ['対象の範囲'] });
  assert.deepEqual(pick(work.find(row => row.id === old)), { ...pick({}), text: '公開しますか。', options: [{ label: '今週' }, { label: '来週' }],
    recommendation: '来週', irreversible: true }, 'an older row keeps its question and its question-level flag');
  assert.deepEqual(pick((await f.call('inbox', web)).pending.find(row => row.id === asked.id)), expected);
  assert.deepEqual(pick((await f.call('taskHistory', { ...web, taskId: 'mine' })).rows.find(row => row.id === asked.id)), expected);
  await f.call('reply', { ...web, id: asked.id, answer: '来週' });
  assert.deepEqual(await f.call('claimDecision', { ...task, questionId: asked.id, claimKey: 'run' }), { claimed: true, answer: '来週' });
});

test('a completion that becomes a review needs a headline and checks; other results do not', async t => {
  const f = fixture(t);
  f.seed('draft', 'label');
  await execute(f, 'draft', true);
  const result = async (key, extra) => f.call('recordWorkResult', { ...task, taskId: 'draft', summary: '下書きを作成。', links: [], key,
    expectedTaskVersion: await versionOf(f, 'draft'), ...extra });
  assert.equal((await result('progress', { complete: false })).status, 'progress');
  await assert.rejects(result('bare', { complete: true }), /needs headline .* and checks/);
  await assert.rejects(result('headline-only', { complete: true, headline: '下書きを仕上げた' }), /needs headline .* and checks/);
  await assert.rejects(result('long', { complete: true, ...reviewed, checks: ['a', 'b', 'c', 'd'] }), /checks must list 1 to 3/);
  const submitted = await result('review', { complete: true, ...reviewed });
  assert.equal(submitted.status, 'review');
  await assert.rejects(result('review', { complete: true, ...reviewed, checks: ['別の確認'] }), /Idempotency/);
  const [pending] = (await f.call('inbox', web)).pending;
  assert.deepEqual([pending.headline, pending.text, pending.checks], ['下書きを仕上げた', '下書きを作成。', ['見出しの表記']]);
});

test('the inbox puts a stalled label first, then larger open subtrees, then older requests', async t => {
  const f = fixture(t);
  delete process.env.GROK_BOT_PILOT;
  const connect = (labelId, key) => f.call('addAssignment', { ...web, labelId, token: key,
    webhookUrl: `https://api2.cursor.sh/automations/webhook/${labelId}`, webhookKey: 'key' });
  const first = await connect('label', 'b'.repeat(64));
  const second = await connect('other-label', 'c'.repeat(64));
  for (const id of ['x1', 'x2']) f.seed(id, 'label');
  f.seed('big', 'other-label');
  for (const id of ['big-1', 'big-2', 'big-3']) f.seed(id, 'big');
  for (const id of ['x1', 'other', 'big']) await execute(f, id);
  let minute = 0;
  const ask = (assignmentId, taskId) => {
    f.setTime(`2026-11-13T12:${String(++minute).padStart(2, '0')}:00+11:00`);
    return f.call('requestDecision', { userId: 'alice', assignmentId, taskId, ...infoCard(`${taskId}?`), key: taskId });
  };
  const order = async () => (await f.call('inbox', web)).pending.map(row => [row.taskId, row.stalled, row.openTasks]);
  await ask(second, 'big');
  await ask(first, 'mine');
  const x1 = await ask(first, 'x1');
  await ask(first, 'x2');
  assert.deepEqual(await order(), [['mine', true, 2], ['x1', true, 1], ['x2', true, 1], ['big', false, 4]]);
  f.setTime('2026-11-13T12:30:00+11:00');
  const review = await f.call('recordWorkResult', { userId: 'alice', assignmentId: second, taskId: 'other', summary: '済み', links: [], complete: true,
    ...reviewed, needsReview: true, assumptions: '仮定', key: 'other', expectedTaskVersion: await versionOf(f, 'other', second) });
  assert.equal(review.status, 'review');
  assert.deepEqual(await order(), [['big', true, 4], ['mine', true, 2], ['x1', true, 1], ['x2', true, 1], ['other', true, 1]]);
  await f.call('reply', { ...web, id: x1.id, answer: 'はい' });
  assert.deepEqual(await order(), [['big', true, 4], ['other', true, 1], ['mine', false, 2], ['x2', false, 1]]);
  const inbox = await f.call('inbox', web);
  assert.deepEqual(inbox.answered.map(row => row.taskId), ['x1']);
});

test('the inbox shows the next label patrol, never the VP one', async t => {
  const f = fixture(t);
  assert.equal((await f.call('inbox', web)).nextPatrolAt, null);
  await f.call('saveSchedule', { ...web, enabled: true, time: '15:00' });
  assert.equal((await f.call('inbox', web)).nextPatrolAt, Date.parse('2026-11-13T15:00:00+11:00'));
  await f.call('addAssignment', { ...web, vp: true, token: 'e'.repeat(64) });
  await f.call('saveSchedule', { ...web, vp: true, enabled: true, time: '13:00' });
  assert.equal((await f.call('inbox', web)).nextPatrolAt, Date.parse('2026-11-13T15:00:00+11:00'));
});

test('a patrol schedule defaults to 06:00 until a time is saved', async t => {
  const f = fixture(t);
  assert.equal((await f.call('schedule', web)).time, '06:00');
  await f.call('saveSchedule', { ...web, enabled: true, time: '03:15' });
  assert.equal((await f.call('schedule', web)).time, '03:15');
});

const proposal = (kind, extra = {}) => ({ kind, reason: '理由', idempotency_key: `${kind}-${extra.task_id ?? extra.title}`, ...extra });
const json = async pending => {
  const response = await pending;
  return { status: response.status, body: await response.json() };
};

test('a label Bot proposes only deletion or deferral of open tasks in its own label, once, and the user decides', async t => {
  const f = fixture(t);
  const propose = args => json(f.http('propose', args));
  for (const args of [proposal('move', { task_id: 'mine', label_id: 'other-label' }), proposal('new_task', { title: '新規' })]) {
    assert.match((await propose(args)).body.error, /Only the VP/);
  }
  for (const id of ['other', 'foreign-nested', 'another-user', 'label']) assert.equal((await propose(proposal('delete', { task_id: id }))).status, 400);
  assert.match((await propose(proposal('defer', { task_id: 'mine' }))).body.error, /until/);
  assert.match((await propose(proposal('delete', { task_id: 'mine', until: '2026-12-01' }))).body.error, /only for defer/);

  const removal = await propose(proposal('delete', { task_id: 'mine' }));
  assert.deepEqual([removal.status, removal.body.status, removal.body.kind], [200, 'pending', 'delete']);
  assert.equal((await propose(proposal('delete', { task_id: 'mine' }))).body.id, removal.body.id, 'a retry with the same key is idempotent');
  assert.match((await propose(proposal('delete', { task_id: 'mine', reason: '別の理由' }))).body.error, /Idempotency/);
  assert.match((await propose(proposal('delete', { task_id: 'mine', idempotency_key: 'again' }))).body.error, /already pending/);
  for (const until of ['2026-11-12', '2026-11-13']) {
    assert.match((await propose(proposal('defer', { task_id: 'nested', until, idempotency_key: until }))).body.error, /after today \(2026-11-13\)/);
  }
  const later = await propose(proposal('defer', { task_id: 'nested', until: '2026-11-20' }));
  assert.equal(later.body.status, 'pending');

  const inbox = await f.call('inbox', web);
  assert.equal(inbox.pending.length, 0, 'proposals never count as pending decisions');
  assert.deepEqual(inbox.proposals.map(row => [row.kind, row.taskId, row.proposer, row.vp, row.count]),
    [['delete', 'mine', 'label', false, 4], ['defer', 'nested', 'label', false, undefined]]);
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).proposals.map(row => [row.kind, row.status]), [['delete', 'pending'], ['defer', 'pending']]);

  f.identify('bob');
  await assert.rejects(f.call('adoptProposal', { expectedUserId: 'bob', id: removal.body.id }));
  await assert.rejects(f.call('dismissProposal', { expectedUserId: 'bob', id: removal.body.id }));
  f.identify('alice');
  await f.call('dismissProposal', { ...web, id: removal.body.id });
  await f.call('dismissProposal', { ...web, id: removal.body.id });
  await assert.rejects(f.call('adoptProposal', { ...web, id: removal.body.id }), /見送り/);
  assert.equal(itemOf(f, 'mine').deletedAt, undefined);
  assert.match((await propose(proposal('delete', { task_id: 'mine', reason: '言い換え', idempotency_key: 'reworded' }))).body.error, /dismissed/);
  const detail = await f.call('assignedTasks', { userId: 'alice', taskId: 'mine' });
  assert.deepEqual(detail.proposals.map(row => [row.kind, row.status]), [['delete', 'dismissed']]);
  assert.equal(f.jobs.length, 0, 'neither dismissing nor adopting wakes a Bot');

  assert.deepEqual(await f.call('adoptProposal', { ...web, id: later.body.id }), { status: 'adopted' });
  assert.deepEqual(await f.call('adoptProposal', { ...web, id: later.body.id }), { status: 'adopted' });
  assert.equal(f.jobs.length, 0);
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).tasks.map(row => row.id), ['mine']);
  assert.equal((await f.call('assignedTasks', { userId: 'alice', taskId: 'nested' })).deferred_until, '2026-11-20');
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'nested' })).deferredUntil, '2026-11-20');
  assert.match((await json(f.http('request_decision', { task_id: 'nested', ...infoCard('進めますか。'), idempotency_key: 'ask' }))).body.error, /deferred this task until 2026-11-20/);
  assert.match((await propose(proposal('defer', { task_id: 'nested', until: '2026-12-01', idempotency_key: 'longer' }))).body.error, /already deferred/);
  await f.call('setDelegation', { ...web, taskId: 'nested', execute: true });
  await assert.rejects(f.call('recordWorkResult', { ...task, taskId: 'nested', summary: '済み', links: [], complete: true, key: 'done',
    expectedTaskVersion: await versionOf(f, 'nested') }), /deferred/);

  f.setTime('2026-11-20T00:30:00+11:00');
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).tasks.map(row => row.id), ['mine', 'nested'], 'a deferral expires on its own');
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'nested' })).deferredUntil, null);
  const again = await propose(proposal('defer', { task_id: 'nested', until: '2026-12-01', idempotency_key: 'defer-2' }));
  await f.call('adoptProposal', { ...web, id: again.body.id });
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).tasks.map(row => row.id), ['mine']);
  await f.call('cancelDeferral', { ...web, taskId: 'nested' });
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).tasks.map(row => row.id), ['mine', 'nested']);
  assert.equal(f.rows.grokBotDeferrals.length, 0);
});

test('an adopted deletion removes the shown subtree only while it is unchanged', async t => {
  const f = fixture(t);
  for (const [id, parent] of [['old', 'label'], ['old-child', 'old'], ['stale', 'label'], ['stale-child', 'stale']]) f.seed(id, parent);
  const propose = async id => (await json(f.http('propose', proposal('delete', { task_id: id })))).body;
  const old = await propose('old');
  const stale = await propose('stale');
  assert.deepEqual((await f.call('inbox', web)).proposals.map(row => [row.taskId, row.count]), [['old', 2], ['stale', 2]]);
  assert.deepEqual(await f.call('adoptProposal', { ...web, id: old.id }), { status: 'adopted' });
  assert.ok(itemOf(f, 'old').deletedAt && f.rows.syncItems.find(row => row.itemId === 'old-child').deletedAt);
  f.seed('stale-grandchild', 'stale-child');
  assert.deepEqual(await f.call('adoptProposal', { ...web, id: stale.id }), { status: 'changed' });
  assert.equal(f.rows.syncItems.find(row => row.itemId === 'stale').deletedAt, undefined);
  assert.deepEqual((await f.call('inbox', web)).proposals, []);
  assert.deepEqual((await f.call('assignedTasks', { userId: 'alice' })).proposals.map(row => [row.task_id, row.status]),
    [['old', 'adopted'], ['stale', 'changed']]);
});

test('the VP reads every label and unsorted task, can only propose, and each kind applies on adoption', async t => {
  const f = fixture(t);
  const previousSite = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = 'https://fixture.convex.site';
  t.after(() => { if (previousSite === undefined) delete process.env.CONVEX_SITE_URL; else process.env.CONVEX_SITE_URL = previousSite; });
  const key = 'e'.repeat(64);
  const vpArgs = { ...web, vp: true };
  await assert.rejects(f.call('addAssignment', { ...vpArgs, labelId: 'label', token: key }));
  const vpId = await f.call('addAssignment', { ...vpArgs, token: key, webhookUrl: 'https://api2.cursor.sh/automations/webhook/vp', webhookKey: 'vp-key' });
  await assert.rejects(f.call('addAssignment', { ...vpArgs, token: 'f'.repeat(64) }), /VP/);
  assert.deepEqual((await f.call('assignments', web)).map(row => row.labelId), ['label'], 'the VP is not a label Bot');
  assert.deepEqual(await f.call('vp', web), { id: vpId, labelId: '', name: 'Grok Bot', connectorName: undefined, connectorConnected: false,
    webhookConfigured: true, connected: false, managed: true, skin: undefined, defaultMode: 'review' });
  f.identify('bob');
  assert.equal(await f.call('vp', { expectedUserId: 'bob' }), null);
  f.identify('alice');
  assert.deepEqual((await json(f.http('auth', {}, key))).body, { authorized: true, role: 'vp' });
  assert.equal((await f.call('vp', web)).connected, true);

  f.seed('loose', null); f.seed('loose-child', 'loose'); f.seed('loose-2', null); f.seed('closed', null, 'task', 'alice', { done: true });
  for (let i = 0; i < 50; i++) f.seed(`bulk-${i}`, 'other-label');
  const first = (await json(f.http('all_tasks', {}, key))).body;
  assert.deepEqual(first.labels.map(row => [row.id, row.has_bot]), [['label', true], ['other-label', false], ['foreign-section', false]]);
  assert.equal(first.tasks.length, 50);
  const rest = (await json(f.http('all_tasks', { offset: first.next_offset }, key))).body;
  assert.equal(rest.next_offset, null);
  const listed = new Map([...first.tasks, ...rest.tasks].map(row => [row.id, row]));
  assert.deepEqual([...listed.keys()].filter(id => !id.startsWith('bulk-')), ['mine', 'nested', 'other', 'foreign-nested', 'loose', 'loose-child', 'loose-2']);
  assert.deepEqual(['mine', 'other', 'foreign-nested', 'loose', 'loose-child'].map(id => {
    const row = listed.get(id);
    return [row.label_id, row.label, row.unsorted, row.bot_role];
  }), [['label', 'label', false, 'review'], ['other-label', 'other-label', false, null], ['foreign-section', 'foreign-section', false, null],
    [null, null, true, null], [null, null, false, null]]);
  const one = (await json(f.http('all_tasks', { task_id: 'other' }, key))).body;
  assert.deepEqual([one.task.id, one.label_id, one.deferred_until, one.work], ['other', 'other-label', null, []]);
  assert.equal((await f.http('all_tasks', { task_id: 'another-user' }, key)).status, 400);

  // Execution is refused on the server, both at the route and inside each function.
  for (const [operation, args] of [['assigned_tasks', {}], ['add_assigned_task', { title: 'X', idempotency_key: 'x' }],
    ['request_decision', { task_id: 'mine', ...infoCard('Q'), idempotency_key: 'q' }],
    ['claim_decision', { task_id: 'mine', question_id: 'taskWork-1', claim_key: crypto.randomUUID() }],
    ['record_work_result', { task_id: 'mine', summary: 'S', complete: true, idempotency_key: 'r' }]]) {
    assert.equal((await f.http(operation, args, key)).status, 403, operation);
  }
  const asVp = { userId: 'alice', assignmentId: vpId };
  await assert.rejects(f.call('assignedTasks', asVp), /unavailable/);
  await assert.rejects(f.call('addAssignedTask', { ...asVp, title: 'X', key: 'x' }), /unavailable/);
  await assert.rejects(f.call('requestDecision', { ...asVp, taskId: 'mine', ...infoCard('Q'), key: 'q' }), /unavailable/);
  await assert.rejects(f.call('claimDecision', { ...asVp, taskId: 'mine', questionId: 'taskWork-1', claimKey: 'c' }), /unavailable/);
  await assert.rejects(f.call('recordWorkResult', { ...asVp, taskId: 'mine', summary: 'S', links: [], complete: false, key: 'r' }), /unavailable/);
  assert.equal((await f.http('all_tasks', {})).status, 403, 'a label Bot cannot read across labels');
  await assert.rejects(f.call('allTasks', { userId: 'alice', assignmentId: 'grokbotassignments-999' }), /VP connection/);

  const propose = async args => json(f.http('propose', args, key));
  assert.match((await propose(proposal('move', { task_id: 'mine', label_id: 'other-label' }))).body.error, /unsorted/);
  assert.match((await propose(proposal('move', { task_id: 'loose-child', label_id: 'other-label' }))).body.error, /unsorted/);
  assert.match((await propose(proposal('move', { task_id: 'loose', label_id: 'mine' }))).body.error, /Label not found/);
  assert.match((await propose(proposal('new_task', { title: 'X', task_id: 'mine' }))).body.error, /title, not a task_id/);
  assert.match((await propose(proposal('delete', { task_id: 'closed' }))).body.error, /closed/);
  const ids = {};
  for (const [name, args] of Object.entries({
    move: proposal('move', { task_id: 'loose', label_id: 'other-label' }),
    stale: proposal('move', { task_id: 'loose-2', label_id: 'label' }),
    filed: proposal('new_task', { title: 'プレスキットを作る', note: '素材をまとめる', label_id: 'label' }),
    unsorted: proposal('new_task', { title: '請求書を整理する' }),
    removal: proposal('delete', { task_id: 'other' }),
    later: proposal('defer', { task_id: 'mine', until: '2026-12-01' }),
  })) {
    const { status, body } = await propose(args);
    assert.equal(status, 200, `${name}: ${body.error}`);
    ids[name] = body.id;
  }
  assert.match((await propose(proposal('new_task', { title: ' ﾌﾟﾚｽｷｯﾄを作る ', idempotency_key: 'dup' }))).body.error, /same new task/);
  const inbox = await f.call('inbox', web);
  assert.deepEqual(inbox.proposals.map(row => [row.kind, row.proposer, row.vp, row.taskTitle ?? row.title, row.labelName]), [
    ['move', 'VP', true, 'loose', 'other-label'], ['move', 'VP', true, 'loose-2', 'label'], ['new_task', 'VP', true, 'プレスキットを作る', 'label'],
    ['new_task', 'VP', true, '請求書を整理する', undefined], ['delete', 'VP', true, 'other', undefined], ['defer', 'VP', true, 'mine', undefined]]);

  assert.deepEqual(await f.call('adoptProposal', { ...web, id: ids.move }), { status: 'adopted' });
  assert.equal(itemOf(f, 'loose').parentId, 'other-label');
  await f.invoke('mcpTasks:move', { userId: 'alice', taskId: 'loose-2', label: 'other-label' });
  assert.deepEqual(await f.call('adoptProposal', { ...web, id: ids.stale }), { status: 'changed' });
  assert.equal(itemOf(f, 'loose-2').parentId, 'other-label');
  await f.call('adoptProposal', { ...web, id: ids.filed });
  await f.call('adoptProposal', { ...web, id: ids.unsorted });
  const created = f.rows.grokBotProposals.filter(row => row.createdTaskId).map(row => itemOf(f, row.createdTaskId));
  assert.deepEqual(created.map(item => [item.text, item.parentId, item.createdBy, item.note ?? null]),
    [['プレスキットを作る', 'label', 'ai', '素材をまとめる'], ['請求書を整理する', null, 'ai', null]]);
  await f.call('adoptProposal', { ...web, id: ids.removal });
  assert.ok(itemOf(f, 'other') && f.rows.syncItems.find(row => row.itemId === 'other').deletedAt);
  await f.call('adoptProposal', { ...web, id: ids.later });
  assert.ok(!(await json(f.http('all_tasks', {}, key))).body.tasks.some(row => row.id === 'mine'));
  assert.equal((await json(f.http('all_tasks', {}, key))).body.deferred_tasks, 1);
  assert.deepEqual((await json(f.http('all_tasks', { task_id: 'mine' }, key))).body.deferred_until, '2026-12-01');
  assert.ok(!(await f.call('assignedTasks', { userId: 'alice' })).tasks.some(row => row.id === 'mine'), 'hidden from the label Bot too');
  assert.deepEqual((await json(f.http('all_tasks', {}, key))).body.proposals.map(row => row.status).sort(),
    ['adopted', 'adopted', 'adopted', 'adopted', 'adopted', 'changed']);

  // MCP: the VP gets its own tools and instructions.
  t.mock.method(globalThis, 'fetch', (url, init) => grokBotHttp._handler(f.ctx, new Request(url, init)));
  const rpc = async (method, params = {}) => {
    const response = await mcp.POST(new Request('https://fixture.test/api/grok-bot', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    const body = await response.text();
    return JSON.parse(body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: ')).slice(6) : body);
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'bizencore-grok-bot-vp');
  assert.match(init.result.instructions, /idea slot/);
  assert.deepEqual((await rpc('tools/list')).result.tools.map(tool => tool.name).sort(), ['all_tasks', 'propose']);

  await f.call('removeAssignment', vpArgs);
  assert.equal(await f.call('vp', web), null);
  assert.equal(f.rows.grokBotProposals.length, 0);
  assert.equal((await f.http('auth', {}, key)).status, 401);
});

test('proposals are capped per Bot and the VP connects like a label Bot', async t => {
  const f = fixture(t);
  delete process.env.GROK_BOT_PILOT;
  const key = 'e'.repeat(64);
  const vpId = await f.call('addAssignment', { ...web, vp: true, token: key });
  assert.equal((await f.call('vp', web)).connectorName, 'Terminal · VP');
  assert.deepEqual(await f.call('oauthLabel', { ...web, assignment: vpId }), { id: vpId, name: 'VP', vp: true });
  assert.equal((await f.http('auth', {}, key)).status, 200);
  assert.equal((await f.http('all_tasks', {}, key)).status, 200, 'reading works before the routine is registered');
  assert.equal((await f.http('propose', proposal('delete', { task_id: 'mine' }), key)).status, 403);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  await f.call('connectAssignmentWebhook', { ...web, vp: true, webhookUrl: 'https://api2.cursor.sh/automations/webhook/vp', webhookKey: 'vp-key' });
  assert.equal((await f.call('vp', web)).connected, true);
  await f.call('saveSchedule', { ...web, vp: true, enabled: true, time: '13:00' });
  assert.equal((await f.call('schedule', { ...web, vp: true })).enabled, true);
  f.setTime('2026-11-13T13:00:00+11:00');
  await bot.dispatchDuePatrol(f.ctx, Date.now());
  assert.equal(f.jobs.length, 1);
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  assert.equal((await f.call('schedule', { ...web, vp: true })).lastStatus, 'accepted');

  for (let i = 0; i < 11; i++) f.seed(`cap-${i}`, null);
  for (let i = 0; i < 10; i++) assert.equal((await f.http('propose', proposal('delete', { task_id: `cap-${i}` }), key)).status, 200);
  assert.match((await json(f.http('propose', proposal('delete', { task_id: 'cap-10' }), key))).body.error, /10 pending/);
  await f.call('rotateAssignmentToken', { ...web, vp: true, token: 'f'.repeat(64) });
  assert.equal((await f.http('auth', {}, key)).status, 401);
  assert.deepEqual((await f.call('assignments', web)), []);
});

const { formatDuration, median, pullRequest } = await load('src/lib/grokBotWork.ts');
const shaA = 'a1b2c3d'.padEnd(40, '0');
const shaB = 'b2c3d4e'.padEnd(40, '1');
const prUrl = 'https://github.com/example/press-site/pull/128';

test('a pull request always waits for review, and approval asks the Bot to merge exactly that commit', async t => {
  const f = fixture(t);
  f.seed('code', 'label'); f.seed('other-code', 'label');
  await execute(f, 'code', true);
  await execute(f, 'other-code');
  const submit = async (key, extra = {}) => f.call('recordWorkResult', { ...task, taskId: 'code', summary: 'PRを作成。', complete: true, key, ...reviewed,
    links: ['https://example.test/preview', prUrl], prHeadSha: shaA, expectedTaskVersion: await versionOf(f, 'code'), ...extra });
  await assert.rejects(submit('upper', { prHeadSha: shaA.toUpperCase() }), /40-character/);
  await assert.rejects(submit('short', { prHeadSha: shaA.slice(0, 7) }), /40-character/);
  await assert.rejects(submit('progress', { complete: false }), /only for a completion/);
  await assert.rejects(submit('no-pr', { links: ['https://example.test/pull/12'] }), /pull request link/);
  await assert.rejects(submit('files', { links: [`${prUrl}/files`] }), /pull request link/);
  assert.equal((await f.http('record_work_result', { task_id: 'code', summary: 'PR', complete: true, links: [prUrl], pr_head_sha: shaA.toUpperCase(),
    expected_task_version: await versionOf(f, 'code'), idempotency_key: 'zod' })).status, 400);
  assert.deepEqual([pullRequest(prUrl).label, pullRequest(`${prUrl}/files`), pullRequest('https://github.com.evil.test/a/b/pull/1')], ['example/press-site#128', null, null]);

  // No needs_review and no assumptions: a pull request is still a review.
  const submitted = await submit('pr');
  assert.equal(submitted.status, 'review');
  assert.equal((await submit('pr')).id, submitted.id, 'a retry with the same key is idempotent');
  await assert.rejects(submit('pr', { prHeadSha: shaB }), /Idempotency/);
  assert.equal(itemOf(f, 'code').done, false);
  const [pending] = (await f.call('inbox', web)).pending;
  assert.deepEqual([pending.id, pending.prUrl, pending.prHeadSha, pending.assumptions], [submitted.id, prUrl, shaA, undefined]);
  assert.equal((await f.call('assignedTasks', { userId: 'alice', taskId: 'code' })).work.find(row => row.id === submitted.id).prHeadSha, shaA);

  // Approval does not complete the task; it wakes the Bot to merge.
  await f.call('approveReview', { ...web, id: submitted.id });
  await f.call('approveReview', { ...web, id: submitted.id });
  assert.equal(itemOf(f, 'code').done, false);
  assert.equal(f.rows.taskWork.find(row => row._id === submitted.id).status, 'merging');
  assert.equal(f.jobs.length, 1, 'approving twice wakes once');
  const deliver = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { trigger: 'review_approved', task_id: 'code', question_id: submitted.id });
    return new Response(null, { status: 500 });
  });
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  let inbox = await f.call('inbox', web);
  assert.deepEqual([inbox.pending.length, inbox.answered[0].id, inbox.answered[0].status, inbox.answered[0].wakeStatus], [0, submitted.id, 'merging', 'failed']);
  deliver.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  await f.call('retry', { ...web, id: submitted.id });
  await f.invoke(f.jobs[1].name, f.jobs[1].args);
  assert.equal((await f.call('inbox', web)).answered[0].wakeStatus, 'accepted');
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'code' })).rows.find(row => row.id === submitted.id).status, 'merging');
  assert.equal((await f.call('assignedTasks', { userId: 'alice' })).tasks.find(row => row.id === 'code').approved_to_merge, 1);
  await assert.rejects(f.call('returnReview', { ...web, id: submitted.id, comment: 'やっぱり待って' }), /対応済み/);

  // While it waits for the merge, nothing else may complete or resubmit the task without applying it.
  await assert.rejects(submit('unrelated', { prHeadSha: shaB }), /approved a pull request/);
  await assert.rejects(submit('plain', { prHeadSha: undefined, links: [] }), /approved a pull request/);
  assert.equal((await submit('note', { complete: false, prHeadSha: undefined, links: [] })).status, 'progress', 'progress is still allowed');

  // Applying it needs this Bot's active claim on this task.
  const merged = { appliedQuestionId: submitted.id, prHeadSha: shaA, links: [] };
  await assert.rejects(submit('unclaimed', merged), /active claim/);
  const claim = { ...task, taskId: 'code', questionId: submitted.id };
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'run-one' }), { claimed: true, approved: true, pr_url: prUrl, pr_head_sha: shaA });
  assert.deepEqual(await f.call('claimDecision', { ...claim, claimKey: 'run-two' }), { claimed: false });
  assert.deepEqual(await f.call('claimDecision', { ...claim, taskId: 'other-code', claimKey: 'run-one' }), { claimed: false });
  await assert.rejects(submit('stolen', { ...merged, claimKey: 'run-two' }), /active claim/);
  await assert.rejects(f.call('recordWorkResult', { ...task, taskId: 'other-code', summary: 'マージ', links: [], complete: true, key: 'elsewhere',
    appliedQuestionId: submitted.id, claimKey: 'run-one', expectedTaskVersion: await versionOf(f, 'other-code') }), /active claim/);
  await assert.rejects(f.call('recordWorkResult', { ...task, assignmentId: 'grokbotassignments-999', taskId: 'code', summary: 'マージ', links: [], complete: true,
    key: 'other-bot', appliedQuestionId: submitted.id, claimKey: 'run-one', prHeadSha: shaA }));

  // A different head is never completed directly.
  await assert.rejects(submit('moved', { ...merged, prHeadSha: shaB, claimKey: 'run-one' }), /approved commit a1b2c3d/);
  await assert.rejects(submit('other-pr', { ...merged, links: ['https://github.com/example/press-site/pull/129'], claimKey: 'run-one' }), /approved pull request/);
  // A failed merge is reported as progress and leaves the approval in place.
  await submit('merge-failed', { ...merged, complete: false, prHeadSha: undefined, claimKey: 'run-one', summary: 'CIが失敗したためマージを中断。' });
  assert.equal(f.rows.taskWork.find(row => row._id === submitted.id).status, 'merging');

  // Merging the approved commit completes the task without a second review, even when every completion is checked.
  const done = await submit('merged', { ...merged, claimKey: 'run-one', summary: 'a1b2c3dをマージした。' });
  assert.equal(done.status, 'complete');
  assert.equal((await submit('merged', { ...merged, claimKey: 'run-one', summary: 'a1b2c3dをマージした。' })).id, done.id);
  assert.equal(itemOf(f, 'code').done, true);
  const row = f.rows.taskWork.find(row => row._id === submitted.id);
  assert.deepEqual([row.status, row.mergedAt, row.claimKey], ['merged', Date.now(), undefined]);
  inbox = await f.call('inbox', web);
  assert.deepEqual([inbox.pending.length, inbox.answered.length], [0, 0]);
  assert.equal(f.rows.taskWork.find(row => row._id === done.id).prUrl, prUrl);
});

test('a moved pull request head is resubmitted for review and supersedes the approval', async t => {
  const f = fixture(t);
  f.seed('site', 'label');
  await execute(f, 'site');
  const submit = async (key, extra = {}) => f.call('recordWorkResult', { ...task, taskId: 'site', summary: 'PRを更新。', complete: true, key, ...reviewed,
    links: [prUrl], prHeadSha: shaA, expectedTaskVersion: await versionOf(f, 'site'), ...extra });
  const first = await submit('first', { needsReview: true });
  await f.call('approveReview', { ...web, id: first.id });
  await f.call('claimDecision', { ...task, taskId: 'site', questionId: first.id, claimKey: 'run' });
  const applied = { appliedQuestionId: first.id, claimKey: 'run' };
  await assert.rejects(submit('direct', { ...applied, prHeadSha: shaB }), /approved commit/);
  const second = await submit('second', { ...applied, prHeadSha: shaB, needsReview: true, links: ['https://github.com/example/press-site/pull/130'] });
  assert.equal(second.status, 'review');
  assert.equal(f.rows.taskWork.find(row => row._id === first.id).status, 'superseded');
  assert.equal(itemOf(f, 'site').done, false);
  const inbox = await f.call('inbox', web);
  assert.deepEqual(inbox.pending.map(row => [row.id, row.prHeadSha, row.prUrl]), [[second.id, shaB, 'https://github.com/example/press-site/pull/130']]);
  assert.equal(inbox.answered.length, 0);
  assert.deepEqual(await f.call('claimDecision', { ...task, taskId: 'site', questionId: first.id, claimKey: 'run' }), { claimed: false });
  await f.call('approveReview', { ...web, id: second.id });
  await f.call('claimDecision', { ...task, taskId: 'site', questionId: second.id, claimKey: 'run-2' });
  await assert.rejects(submit('stale-approval', { appliedQuestionId: first.id, claimKey: 'run', prHeadSha: shaA }), /active claim/);
  assert.equal((await submit('merged', { appliedQuestionId: second.id, claimKey: 'run-2', prHeadSha: undefined, links: [] })).status, 'complete');
  assert.equal(itemOf(f, 'site').done, true);
  assert.equal(f.rows.taskWork.find(row => row._id === second.id).status, 'merged');
});

test('inbox metrics cover the last 7 days in the user’s time zone and leave out rows without timestamps', async t => {
  const f = fixture(t);
  const empty = { medianAnswerMs: null, answered: 0, returnRate: null, returned: 0, reviewed: 0, forwardWeek: 0, forwardToday: 0,
    rejectedWeek: 0, rejectedToday: 0, spawnedWeek: 0 };
  assert.deepEqual((await f.call('inbox', web)).metrics, empty);
  const at = time => Date.parse(time);
  let n = 0;
  const add = (status, created, answered, extra = {}) => f.rows.taskWork.push({ _id: `taskWork-m${++n}`, userId: 'alice', taskId: 'mine', key: `m${n}`, text: 'x',
    status, _creationTime: at(created), ...(answered ? { answeredAt: at(answered) } : {}), ...extra });
  // Now: 2026-11-13 12:00 Melbourne. The window starts 2026-11-07 00:00 Melbourne (2026-11-06 13:00 UTC).
  add('applied', '2026-11-13T09:00:00+11:00', '2026-11-13T09:10:00+11:00');
  add('answered', '2026-11-12T09:00:00+11:00', '2026-11-12T09:30:00+11:00');
  add('returned', '2026-11-10T09:00:00+11:00', '2026-11-10T11:00:00+11:00');
  add('applied', '2026-11-06T22:00:00+11:00', '2026-11-06T23:59:00+11:00', { note: 'answered just before the window' });
  add('approved', '2026-11-01T00:00:00+11:00', undefined, { note: 'legacy row without answeredAt' });
  add('answered', '2026-11-12T00:00:00+11:00', undefined);
  add('applied', '2026-11-13T09:00:00+11:00', '2026-11-13T09:00:00+11:00', { userId: 'bob' });
  const metrics = () => bot.workMetrics(f.ctx, 'alice', Date.now());
  assert.deepEqual(await metrics(), { ...empty, medianAnswerMs: 30 * 60_000, answered: 3, returnRate: 1, returned: 1, reviewed: 1 }, 'odd count: the middle value');
  add('approved', '2026-11-07T00:00:00+11:00', '2026-11-07T00:50:00+11:00');
  add('merged', '2026-11-08T00:00:00+11:00', '2026-11-08T01:00:00+11:00');
  add('merging', '2026-11-08T00:00:00+11:00', '2026-11-08T00:20:00+11:00');
  add('revised', '2026-11-09T00:00:00+11:00', '2026-11-09T08:00:00+11:00');
  add('superseded', '2026-11-09T00:00:00+11:00', '2026-11-09T00:40:00+11:00');
  // Even count (8): the mean of 40 and 50 minutes.
  const week = await metrics();
  assert.equal(week.medianAnswerMs, 45 * 60_000);
  assert.deepEqual([week.answered, week.returned, week.reviewed, week.returnRate], [8, 2, 6, 2 / 6]);
  assert.deepEqual([week.forwardWeek, week.forwardToday], [1, 0], 'only the non-PR approval completed a task so far');
  add('complete', '2026-11-13T00:05:00+11:00');   // today in Melbourne, still 2026-11-12 in UTC
  add('complete', '2026-11-12T23:55:00+11:00');   // yesterday
  add('complete', '2026-11-06T23:55:00+11:00');   // before the window
  add('progress', '2026-11-13T10:00:00+11:00');
  assert.deepEqual(await metrics().then(row => [row.forwardWeek, row.forwardToday]), [3, 1]);
  assert.deepEqual((await f.call('inbox', web)).metrics, await metrics());
  f.setTime('2026-11-20T12:00:00+11:00');
  assert.deepEqual(await metrics(), empty, 'a week later every row has left the window');
  assert.deepEqual([median([3, 1, 2]), median([4, 1, 3, 2]), median([])], [2, 2.5, null]);
  assert.deepEqual([0, 30_000, 60_000, 59 * 60_000, 80 * 60_000, 3 * 3_600_000, 26.4 * 3_600_000, 50 * 3_600_000, 72 * 3_600_000].map(formatDuration),
    ['1分未満', '1分未満', '1分', '59分', '1時間20分', '3時間', '26時間', '2.1日', '3日']);
});

const challengeCard = (extra = {}) => ({ task_id: 'mine', kind: 'challenge', artifact_kind: 'mock', headline: 'この機能は本当に必要？',
  context: '需要が確認できていません。モックで判断できます。', options: [{ label: 'ボツ', consequence: 'タスクを削除する' }, { label: '作る', consequence: '実装に進む' }],
  recommendation: { option: 'ボツ', reason: '需要が未確認', confidence: 'medium' }, checks: ['モック画面'], idempotency_key: 'challenge', ...extra });

test('challenge mode never completes and asks with a challenge card instead', async t => {
  const f = fixture(t);
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: false, mode: 'challenge' });
  const detail = await (await f.http('assigned_tasks', { task_id: 'mine' })).json();
  assert.deepEqual([detail.bot_role, detail.bot_mode, detail.review_required], ['review', 'challenge', false]);
  const done = await json(f.http('record_work_result', { task_id: 'mine', summary: 'done', complete: true, expected_task_version: detail.task_version, idempotency_key: 'c1' }));
  assert.equal(done.status, 400);
  assert.match(done.body.error, /challenge mode.*kind="challenge"/);
  assert.equal((await f.http('record_work_result', { task_id: 'mine', summary: 'モックを作った', idempotency_key: 'c2' })).status, 200, 'progress is still recorded');
  assert.match((await json(f.http('request_decision', challengeCard({ options: [{ label: 'ボツ', consequence: '削除' }], idempotency_key: 'one' })))).body.error,
    /2 to 4 for kind challenge/);
  assert.equal((await f.http('request_decision', challengeCard())).status, 200);
  assert.equal((await f.http('request_decision', challengeCard())).status, 200, 'a retry with the same key is idempotent');
  const [pending] = (await f.call('inbox', web)).pending;
  assert.deepEqual([pending.kind, pending.artifactKind, pending.recommendation], ['challenge', 'mock', 'ボツ']);
  assert.deepEqual(await f.call('taskHistory', { ...web, taskId: 'mine' }).then(row => [row.botMode, row.mayExecute, row.reviewRequired]), ['challenge', false, false]);

  // Older callers and rows keep their meaning.
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: true, reviewCompletion: true });
  assert.deepEqual(await f.call('taskHistory', { ...web, taskId: 'mine' }).then(row => [row.botMode, row.mayExecute, row.reviewRequired]), ['checked', true, true]);
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: true });
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'mine' })).botMode, 'execute');
  f.rows.grokBotDelegations[0] = { ...f.rows.grokBotDelegations[0], mode: undefined, reviewCompletion: true };
  assert.equal((await f.call('assignedTasks', { userId: 'alice', taskId: 'mine' })).bot_mode, 'checked', 'a row saved before modes');
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: true, mode: 'review' });
  assert.equal(f.rows.grokBotDelegations.length, 0);
});

test('killing an idea removes the task, records why, and can spawn a follow-up and a norm', async t => {
  const f = fixture(t);
  const removed = id => !!f.rows.syncItems.find(row => row.itemId === id).deletedAt;
  // From a challenge card: with a follow-up and a kill criterion.
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: false, mode: 'challenge' });
  const card = await (await f.http('request_decision', challengeCard())).json();
  await assert.rejects(f.call('rejectTaskWithLearning', { ...web, reason: ' ' , workId: card.id }), /1〜2000/);
  await assert.rejects(f.call('rejectTaskWithLearning', { ...web, reason: '不要' }), /1つ選んで/);
  f.identify('bob');
  await assert.rejects(f.call('rejectTaskWithLearning', { expectedUserId: 'bob', workId: card.id, reason: '不要' }));
  f.identify('alice');
  const result = await f.call('rejectTaskWithLearning', { ...web, workId: card.id, reason: '需要の裏付けがない機能は作らない', spawnTitle: '需要を3人に聞く',
    spawnNote: 'インタビュー', alsoCreateNorm: true });
  assert.ok(removed('mine') && removed('nested'), 'the whole subtree is removed');
  const spawned = itemOf(f, result.spawnedTaskId);
  assert.deepEqual([spawned.text, spawned.parentId], ['需要を3人に聞く', 'label']);
  const work = f.rows.taskWork.find(row => row._id === card.id);
  assert.deepEqual([work.status, work.rejectionReason, work.spawnedTaskId], ['rejected', '需要の裏付けがない機能は作らない', result.spawnedTaskId]);
  const [rejection] = f.rows.taskRejections;
  assert.equal(rejection._id, result.rejectionId);
  assert.deepEqual([rejection.taskTitle, rejection.labelId, rejection.labelName, rejection.spawnedTitle], ['mine', 'label', 'label', '需要を3人に聞く']);
  assert.match(rejection.botArgument, /この機能は本当に必要？.*需要が未確認/);
  assert.deepEqual(f.rows.grokBotNorms.map(row => [row.kind, row.labelId, row.text, row.sourceRejectionId]),
    [['kill_criterion', 'label', '需要の裏付けがない機能は作らない', result.rejectionId]]);
  await assert.rejects(f.call('rejectTaskWithLearning', { ...web, workId: card.id, reason: 'again' }), /対応済み/);

  // From a review card, without a follow-up or norm.
  f.seed('draft', 'label');
  await f.call('setDelegation', { ...web, taskId: 'draft', execute: true, reviewCompletion: true });
  const version = (await f.call('assignedTasks', { userId: 'alice', taskId: 'draft' })).task_version;
  const review = await (await f.http('record_work_result', { task_id: 'draft', summary: '下書き', complete: true, expected_task_version: version,
    ...reviewed, idempotency_key: 'r' })).json();
  assert.equal(review.status, 'review');
  assert.equal((await f.call('rejectTaskWithLearning', { ...web, workId: review.id, reason: '方向性が違う' })).spawnedTaskId, undefined);
  assert.ok(removed('draft'));

  // From a deletion proposal.
  f.seed('old', 'label');
  const proposed = await (await f.http('propose', proposal('delete', { task_id: 'old' }))).json();
  await f.call('rejectTaskWithLearning', { ...web, proposalId: proposed.id, reason: '古い' });
  assert.ok(removed('old'));
  assert.equal(f.rows.grokBotProposals[0].status, 'adopted');

  // A locked task is never removed.
  f.seed('locked', 'label', 'task', 'alice', { locked: true });
  const locked = await (await f.http('request_decision', { task_id: 'locked', ...infoCard('進める？'), idempotency_key: 'l' })).json();
  await assert.rejects(f.call('rejectTaskWithLearning', { ...web, workId: locked.id, reason: '不要' }), /ロックを外して/);
  assert.ok(!removed('locked'));

  assert.equal(f.rows.grokBotNorms.length, 1);
  const metrics = await bot.workMetrics(f.ctx, 'alice', Date.now());
  assert.deepEqual([metrics.rejectedWeek, metrics.rejectedToday, metrics.spawnedWeek], [3, 3, 1]);
  const inbox = await f.call('inbox', web);
  assert.deepEqual(inbox.rejections.map(row => row.reason), ['古い', '方向性が違う', '需要の裏付けがない機能は作らない']);
  assert.deepEqual(inbox.norms.map(row => [row.text, row.labelName]), [['需要の裏付けがない機能は作らない', 'label']]);
  const list = await (await f.http('assigned_tasks')).json();
  assert.equal(list.recent_rejections.length, 3);
  assert.deepEqual(list.norms.map(row => row.kind), ['kill_criterion']);
  f.setTime('2026-11-14T12:00:00+11:00');
  assert.deepEqual(await bot.workMetrics(f.ctx, 'alice', Date.now()).then(row => [row.rejectedWeek, row.rejectedToday, row.spawnedWeek]), [3, 0, 1]);
});

test('norms are managed by the user and delivered to the Bots they apply to', async t => {
  const f = fixture(t);
  await assert.rejects(f.call('addNorm', { ...web, labelId: 'mine', text: 'x', kind: 'rule' }), /ラベル/);
  await assert.rejects(f.call('addNorm', { ...web, text: ' ', kind: 'rule' }), /1〜300/);
  await assert.rejects(f.call('addNorm', { ...web, text: 'x'.repeat(301), kind: 'rule' }), /1〜300/);
  const company = await f.call('addNorm', { ...web, text: '外部送信の前に必ず確認する', kind: 'autonomy' });
  f.setTime('2026-11-13T12:01:00+11:00');
  await f.call('addNorm', { ...web, labelId: 'label', text: '計測できない改善はボツ', kind: 'kill_criterion' });
  f.setTime('2026-11-13T12:02:00+11:00');
  await f.call('addNorm', { ...web, labelId: 'other-label', text: '別ラベルのルール', kind: 'rule' });
  assert.deepEqual((await f.call('norms', web)).map(row => [row.text, row.labelName ?? null]),
    [['別ラベルのルール', 'other-label'], ['計測できない改善はボツ', 'label'], ['外部送信の前に必ず確認する', null]]);
  assert.equal((await f.call('norms', { ...web, labelId: 'label' })).length, 2);
  const delivered = async () => (await (await f.http('assigned_tasks')).json()).norms.map(row => row.text).sort();
  assert.deepEqual(await delivered(), ['外部送信の前に必ず確認する', '計測できない改善はボツ']);
  f.identify('bob');
  await assert.rejects(f.call('toggleNorm', { expectedUserId: 'bob', id: company, active: false }));
  f.identify('alice');
  await f.call('toggleNorm', { ...web, id: company, active: false });
  assert.deepEqual(await delivered(), ['計測できない改善はボツ']);
  const key = 'e'.repeat(64);
  await f.call('addAssignment', { ...web, vp: true, token: key });
  assert.deepEqual((await json(f.http('all_tasks', {}, key))).body.norms.map(row => row.text).sort(), ['別ラベルのルール', '計測できない改善はボツ']);
  await f.call('deleteNorm', { ...web, id: company });
  assert.equal(f.rows.grokBotNorms.length, 2);
  for (let i = 0; i < 98; i++) f.rows.grokBotNorms.push({ _id: `grokBotNorms-cap${i}`, userId: 'alice', text: 'x', kind: 'rule', active: true, createdAt: 0, updatedAt: 0 });
  await assert.rejects(f.call('addNorm', { ...web, text: 'one more', kind: 'rule' }), /100件/);
});

test('an answer can greenlight execution in one step, and only lifts review or challenge', async t => {
  const f = fixture(t);
  const modeOf = taskId => f.rows.grokBotDelegations.find(row => row.taskId === taskId);
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: false, mode: 'challenge' });
  const card = await (await f.http('request_decision', challengeCard())).json();
  assert.equal((await f.call('inbox', web)).pending[0].botMode, 'challenge', 'the inbox card knows the task mode');
  await f.call('reply', { ...web, id: card.id, answer: '作る', promoteToExecution: true });
  assert.deepEqual([modeOf('mine').mode, modeOf('mine').reviewCompletion, modeOf('mine').labelId], ['checked', true, 'label']);
  assert.equal(f.rows.taskWork.find(row => row._id === card.id).status, 'answered');
  assert.ok(f.jobs.some(job => job.name === 'grokBot:wake' && job.args.id === card.id), 'the Bot is woken in the same step');

  // A task with no delegation (review) is promoted too; an already executing one is never narrowed.
  f.seed('plain', 'label');
  const plain = await (await f.http('request_decision', { task_id: 'plain', ...infoCard('どこまで？'), idempotency_key: 'p' })).json();
  assert.equal((await f.call('inbox', web)).pending.find(row => row.id === plain.id).botMode, 'review');
  await f.call('reply', { ...web, id: plain.id, answer: '全部', promoteToExecution: true });
  assert.equal(modeOf('plain').mode, 'checked');
  f.seed('running', 'label');
  await f.call('setDelegation', { ...web, taskId: 'running', execute: true, mode: 'execute' });
  const running = await (await f.http('request_decision', { task_id: 'running', ...infoCard('続ける？'), idempotency_key: 'r' })).json();
  await f.call('reply', { ...web, id: running.id, answer: 'はい', promoteToExecution: true });
  assert.equal(modeOf('running').mode, 'execute');
  // Without the opt-in nothing changes.
  f.seed('quiet', 'label');
  const quiet = await (await f.http('request_decision', { task_id: 'quiet', ...infoCard('どうする？'), idempotency_key: 'q' })).json();
  await f.call('reply', { ...web, id: quiet.id, answer: '保留' });
  assert.equal(modeOf('quiet'), undefined);
});

test('returned review feedback can become a standing rule of the label', async t => {
  const f = fixture(t);
  f.seed('draft', 'label');
  await f.call('setDelegation', { ...web, taskId: 'draft', execute: true, mode: 'checked' });
  const version = (await f.call('assignedTasks', { userId: 'alice', taskId: 'draft' })).task_version;
  const submit = key => f.http('record_work_result', { task_id: 'draft', summary: '下書き', complete: true, expected_task_version: version, ...reviewed, idempotency_key: key });
  const first = await (await submit('one')).json();
  await f.call('returnReview', { ...web, id: first.id, comment: '見出しは20字以内にする', alsoCreateNorm: true });
  assert.deepEqual(f.rows.grokBotNorms.map(row => [row.kind, row.labelId, row.text, row.sourceWorkId, row.active]),
    [['rule', 'label', '見出しは20字以内にする', first.id, true]]);
  assert.ok(f.jobs.some(job => job.name === 'grokBot:wake' && job.args.id === first.id));
  assert.deepEqual((await (await f.http('assigned_tasks')).json()).norms.map(row => row.text), ['見出しは20字以内にする']);
  // A plain return leaves the norms alone.
  f.rows.taskWork.find(row => row._id === first.id).status = 'revised';
  const second = await (await submit('two')).json();
  await f.call('returnReview', { ...web, id: second.id, comment: '今回だけ' });
  assert.equal(f.rows.grokBotNorms.length, 1);
});

test('each Bot clocks in at one to six daily times, once per slot, and can be clocked in by hand', async t => {
  const f = fixture(t);
  delete process.env.GROK_BOT_PILOT;
  const key = 'b'.repeat(64);
  await f.call('addAssignment', { ...web, labelId: 'label', token: key, webhookUrl: 'https://api2.cursor.sh/automations/webhook/label', webhookKey: 'key-label' });
  await f.call('addAssignment', { ...web, labelId: 'other-label', token: 'c'.repeat(64), webhookUrl: 'https://api2.cursor.sh/automations/webhook/other', webhookKey: 'key-other' });
  assert.equal((await f.http('auth', {}, key)).status, 200);
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); });
  const save = extra => f.call('saveSchedule', { ...web, labelId: 'label', enabled: true, time: '09:00', ...extra });
  for (const times of [[], ['09:00', '09:00'], ['09:00', '25:00'], ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00']]) {
    await assert.rejects(save({ times }), /1〜6件/);
  }
  await save({ times: ['18:00', '09:00'] });
  const saved = () => f.rows.grokBotSchedules.find(row => row.assignmentId === f.rows.grokBotAssignments[0]._id);
  const schedule = await f.call('schedule', { ...web, labelId: 'label' });
  assert.deepEqual([schedule.time, schedule.times, schedule.nextCheckAt], ['09:00', ['09:00', '18:00'], Date.parse('2026-11-13T18:00:00+11:00')]);
  assert.deepEqual((await f.call('inbox', web)).nextPatrol, { at: Date.parse('2026-11-13T18:00:00+11:00'), label: 'label', vp: false });

  const dispatch = time => { f.setTime(time); return bot.dispatchDuePatrol(f.ctx, Date.now()); };
  await dispatch('2026-11-13T17:59:00+11:00');
  assert.equal(f.jobs.length, 0);
  await dispatch('2026-11-13T18:00:20+11:00');
  await dispatch('2026-11-13T18:00:40+11:00');
  assert.equal(f.jobs.length, 1, 'one slot fires once');
  assert.deepEqual([saved().nextCheckAt, saved().lastSlotKey], [Date.parse('2026-11-14T09:00:00+11:00'), String(Date.parse('2026-11-13T18:00:00+11:00'))]);
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  assert.deepEqual([payloads, saved().lastStatus], [[{ trigger: 'patrol' }], 'accepted']);
  await dispatch('2026-11-14T09:00:00+11:00');
  assert.equal(f.jobs.length, 2);
  assert.equal(saved().nextCheckAt, Date.parse('2026-11-14T18:00:00+11:00'), 'the second clock-in of the day follows');

  // Clocking in by hand sends the same minimal patrol and leaves the schedule as it was.
  f.setTime('2026-11-14T10:30:00+11:00');
  await f.call('patrolNow', { ...web, labelId: 'label' });
  assert.equal(saved().nextCheckAt, Date.parse('2026-11-14T18:00:00+11:00'));
  await f.invoke(f.jobs.at(-1).name, f.jobs.at(-1).args);
  assert.deepEqual([payloads.at(-1), saved().lastRunAt, saved().lastStatus], [{ trigger: 'patrol' }, Date.now(), 'accepted']);
  await assert.rejects(f.call('patrolNow', { ...web, labelId: 'other-label' }), /接続/, 'a Bot that never connected is not called');
  await assert.rejects(f.call('patrolNow', { ...web, labelId: 'mine' }), /担当Bot/);
  // A disabled schedule still lets the human clock the Bot in.
  await save({ enabled: false });
  await f.call('patrolNow', { ...web, labelId: 'label' });
  await f.invoke(f.jobs.at(-1).name, f.jobs.at(-1).args);
  assert.equal(payloads.length, 3);

  // Saving without times is the single daily time again.
  await save({ time: '07:00' });
  assert.deepEqual(await f.call('schedule', { ...web, labelId: 'label' }).then(row => [row.time, row.times, row.nextCheckAt]),
    ['07:00', ['07:00'], Date.parse('2026-11-15T07:00:00+11:00')]);
});

/** Replaces the pilot with a connected label Bot on 'label' and returns its token. */
async function labelBot(f) {
  delete process.env.GROK_BOT_PILOT;
  const key = 'b'.repeat(64);
  await f.call('addAssignment', { ...web, labelId: 'label', name: 'Research Bot', token: key, webhookUrl: 'https://api2.cursor.sh/automations/webhook/label', webhookKey: 'key-label' });
  assert.equal((await f.http('auth', {}, key)).status, 200);
  return key;
}

test('a label default mode is inherited by every task until one overrides it, review included', async t => {
  const f = fixture(t);
  const key = await labelBot(f);
  const role = async taskId => {
    const body = await (await f.http('assigned_tasks', { task_id: taskId }, key)).json();
    return [body.bot_mode, body.review_required];
  };
  assert.deepEqual(await role('mine'), ['review', false]);
  await assert.rejects(f.call('setAssignmentDefaultMode', { ...web, labelId: 'other-label', defaultMode: 'execute' }), /割り当て/);
  await assert.rejects(f.call('setAssignmentDefaultMode', { ...web, labelId: 'mine', defaultMode: 'execute' }), /ラベル/);
  f.identify('bob');
  await assert.rejects(f.call('setAssignmentDefaultMode', { expectedUserId: 'bob', labelId: 'label', defaultMode: 'execute' }));
  f.identify('alice');

  await f.call('setAssignmentDefaultMode', { ...web, labelId: 'label', defaultMode: 'checked' });
  assert.equal((await f.call('assignments', web))[0].defaultMode, 'checked');
  assert.deepEqual(await role('mine'), ['checked', true], 'a task without an override inherits the label default');
  assert.equal((await f.call('taskHistory', { ...web, taskId: 'mine' })).botMode, 'checked');

  // Against a checked default, review is an override of its own and persists.
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: false, mode: 'review' });
  assert.deepEqual(f.rows.grokBotDelegations.map(row => [row.taskId, row.mode]), [['mine', 'review']]);
  assert.deepEqual(await role('mine'), ['review', false]);
  await f.call('setAssignmentDefaultMode', { ...web, labelId: 'label', defaultMode: 'execute' });
  assert.deepEqual([await role('mine'), await role('nested')], [['review', false], ['execute', false]]);
  // Choosing the default again returns the task to inheriting it.
  await f.call('setDelegation', { ...web, taskId: 'mine', execute: true, mode: 'execute' });
  assert.equal(f.rows.grokBotDelegations.length, 0);
  assert.deepEqual(await role('mine'), ['execute', false]);
});

test('Bot社員 lists every employee with its work and takes a goal, optionally clocking the Bot in now', async t => {
  const f = fixture(t);
  delete process.env.GROK_BOT_PILOT;
  assert.equal(await f.call('team', web), null);
  const key = await labelBot(f);
  await f.call('addAssignment', { ...web, labelId: 'other-label', name: 'Dev Bot', token: 'c'.repeat(64),
    webhookUrl: 'https://api2.cursor.sh/automations/webhook/other', webhookKey: 'key-other' });
  await f.call('addAssignment', { ...web, vp: true, token: 'e'.repeat(64) });
  assert.equal((await f.http('request_decision', { task_id: 'nested', ...infoCard('どちら？'), idempotency_key: 'q' }, key)).status, 200);
  f.identify('bob');
  assert.equal(await f.call('team', { expectedUserId: 'alice' }), null);
  f.identify('alice');

  const [research, dev, vp] = (await f.call('team', web)).employees;
  assert.deepEqual([research.name, research.labelName, research.connected, research.vp, research.defaultMode, research.counts],
    ['Research Bot', 'label', true, false, 'review', { openTasks: 2, waiting: 1, review: 0, completedRecent: 0 }]);
  assert.deepEqual(research.schedule, { enabled: false, times: ['06:00'], nextCheckAt: null, lastRunAt: null, lastStatus: null });
  assert.deepEqual(research.tasks.map(row => [row.id, row.waiting, row.botMode, row.inherited]),
    [['nested', 1, 'review', true], ['mine', 0, 'review', true]], 'tasks waiting on the human come first');
  assert.deepEqual([dev.labelName, dev.connected, dev.tasks.map(row => row.id)], ['other-label', false, ['other']]);
  assert.deepEqual([vp.labelName, vp.vp, vp.tasks], ['VP', true, []]);

  await assert.rejects(f.call('assignGoalToBot', { ...web, labelId: 'label', title: ' ' }), /1〜500/);
  await assert.rejects(f.call('assignGoalToBot', { ...web, labelId: 'label', title: 'x'.repeat(501) }), /1〜500/);
  await assert.rejects(f.call('assignGoalToBot', { ...web, labelId: 'label', title: 'x', note: 'x'.repeat(8001) }), /8000/);
  await assert.rejects(f.call('assignGoalToBot', { ...web, labelId: 'mine', title: 'x' }), /ラベル/);

  // A goal with its own mode is created in the label and overrides the default; nothing is sent yet.
  const { taskId } = await f.call('assignGoalToBot', { ...web, labelId: 'label', title: ' 申込フォームを公開する ', note: '朝までに', mode: 'checked' });
  assert.deepEqual([itemOf(f, taskId).text, itemOf(f, taskId).parentId, itemOf(f, taskId).note], ['申込フォームを公開する', 'label', '朝までに']);
  assert.deepEqual(f.rows.grokBotDelegations.map(row => [row.taskId, row.mode, row.reviewCompletion]), [[taskId, 'checked', true]]);
  assert.equal(f.jobs.length, 0);
  const goal = (await f.call('team', web)).employees[0].tasks.find(row => row.id === taskId);
  assert.deepEqual([goal.botMode, goal.inherited], ['checked', false]);

  // runNow clocks a connected Bot in at once; the default mode needs no override row.
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); });
  const second = await f.call('assignGoalToBot', { ...web, labelId: 'label', title: '価格表を更新する', mode: 'review', runNow: true });
  assert.equal(f.rows.grokBotDelegations.length, 1);
  assert.deepEqual(f.jobs.map(job => job.name), ['grokBot:runPatrol']);
  await f.invoke(f.jobs[0].name, f.jobs[0].args);
  const saved = f.rows.grokBotSchedules.find(row => row.assignmentId === research.id);
  assert.deepEqual([payloads, saved.lastStatus, saved.enabled], [[{ trigger: 'patrol' }], 'accepted', false]);
  assert.ok(second.taskId && second.taskId !== taskId);
  // A Bot that never connected gets the task but is not called.
  await f.call('assignGoalToBot', { ...web, labelId: 'other-label', title: '下書き', runNow: true });
  assert.equal(f.jobs.length, 1);
});

test('the inbox briefs what the Bots finished in the last 72 hours, newest first, one row per task', async t => {
  const f = fixture(t);
  for (const id of ['done-a', 'done-b', 'old']) f.seed(id, 'label');
  f.seed('done-c', 'other-label');
  const now = Date.now();
  const hour = 3_600_000;
  const work = (taskId, status, at, extra = {}) => f.rows.taskWork.push({ _id: `taskWork-${taskId}-${status}`, _creationTime: at, userId: 'alice',
    taskId, key: status, text: `${taskId}の要約`, status, ...extra });
  work('done-a', 'complete', now - 2 * hour, { headline: 'Aを仕上げた', links: ['https://example.test/a'] });
  work('done-b', 'approved', now - 80 * hour, { answeredAt: now - hour });
  work('done-c', 'merged', now - 50 * hour, { answeredAt: now - 49 * hour, mergedAt: now - 3 * hour, prUrl, prHeadSha: shaA });
  work('done-c', 'complete', now - 3 * hour + 1000);
  work('old', 'complete', now - 73 * hour);
  work('mine', 'review', now - hour);
  const { recentCompletions } = await f.call('inbox', web);
  assert.deepEqual(recentCompletions.map(row => [row.taskId, row.status, row.label, row.completedAt]), [
    ['done-b', 'approved', 'label', now - hour], ['done-a', 'complete', 'label', now - 2 * hour], ['done-c', 'complete', 'other-label', now - 3 * hour + 1000],
  ]);
  assert.deepEqual([recentCompletions[1].headline, recentCompletions[1].summary, recentCompletions[1].links, recentCompletions[1].title],
    ['Aを仕上げた', 'done-aの要約', ['https://example.test/a'], 'done-a']);
});

test('approving a review can also save an autonomy rule for its label', async t => {
  const f = fixture(t);
  const submit = async taskId => {
    f.seed(taskId, 'label');
    await f.call('setDelegation', { ...web, taskId, execute: true, mode: 'checked' });
    return (await f.http('record_work_result', { task_id: taskId, summary: '下書き', complete: true, expected_task_version: await versionOf(f, taskId),
      ...reviewed, idempotency_key: taskId })).json();
  };
  const first = await submit('draft');
  await assert.rejects(f.call('approveReview', { ...web, id: first.id, autonomyRule: 'x'.repeat(301) }), /300/);
  assert.equal(f.rows.taskWork.find(row => row._id === first.id).status, 'review');
  await f.call('approveReview', { ...web, id: first.id, autonomyRule: '  誤字の修正は聞かずに進めてよい ' });
  assert.equal(f.rows.taskWork.find(row => row._id === first.id).status, 'approved');
  assert.deepEqual(f.rows.grokBotNorms.map(row => [row.kind, row.labelId, row.text, row.sourceWorkId, row.active]),
    [['autonomy', 'label', '誤字の修正は聞かずに進めてよい', first.id, true]]);
  assert.deepEqual((await (await f.http('assigned_tasks')).json()).norms.map(row => [row.kind, row.text]), [['autonomy', '誤字の修正は聞かずに進めてよい']]);
  // A blank rule approves without adding a norm.
  const second = await submit('draft-2');
  await f.call('approveReview', { ...web, id: second.id, autonomyRule: '  ' });
  assert.equal(f.rows.grokBotNorms.length, 1);
});
