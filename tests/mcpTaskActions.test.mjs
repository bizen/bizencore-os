import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['api/_lib/mcpServer.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createBizencoreMcp } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const pending = { request_id: 'request-1', task_id: 'task-1', text: 'Delete fixture', count: 2, status: 'pending', expires_at: Date.now() + 600000 };

function server(options = {}) {
  const calls = [];
  let status = 'pending';
  const instance = createBizencoreMcp({ signingKey: new Uint8Array(32).fill(1), readApp: async () => '',
    fetchData: async (_ctx, path, body) => {
      calls.push({ path, body });
      if (path === 'respond-task-action') status = body.decision === 'approve' ? 'completed' : 'cancelled';
      return { ...pending, status, ...(status === 'completed' ? { deleted: 2 } : {}) };
    }, ...options });
  async function rpc(method, params, { modern = false, capabilities = {}, userId = 'alice', clientId = 'cli' } = {}) {
    const request = new Request('https://fixture.test/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(modern ? { 'Mcp-Method': method, ...((params.name ?? params.uri) ? { 'Mcp-Name': params.name ?? params.uri } : {}) } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': capabilities,
    } } : {}) } }) });
    request.auth = { clientId, extra: { userId } };
    const response = await instance.handler(request);
    const text = await response.text();
    const body = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: ')).slice(6) : text);
    return { status: response.status, ...body };
  }
  const call = (args = {}, transport = {}, extra = {}) => rpc('tools/call', { name: 'delete_task', arguments: { task_id: 'task-1', ...args }, ...extra }, transport);
  return { rpc, call, calls };
}

test('legacy initialization followed by deletion returns an actionable Web link instead of the elicitation failure', async () => {
  const f = server();
  await f.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'terminal', version: '1' } });
  const response = await f.call();
  assert.equal(response.status, 200); assert.ok(!response.result.isError);
  const action = JSON.parse(response.result.content[0].text);
  assert.equal(action.status, 'pending'); assert.equal(action.request_id, 'request-1');
  assert.equal(action.confirmation_url, 'https://app.bizencore.com/task-actions/request-1');
  assert.match(action.next_action, /Opening the link is not approval/);
  assert.deepEqual(f.calls.map(call => call.path), ['prepare-task-deletion']);
  const result = await f.call({ request_id: action.request_id });
  assert.equal(JSON.parse(result.result.content[0].text).status, 'pending');
  assert.equal(f.calls.at(-1).path, 'task-action-status');
});

test('modern requests select native forms only for declared form support', async () => {
  for (const capabilities of [{}, { elicitation: { url: {} } }, { elicitation: {} }, { elicitation: { form: {} } }]) {
    const f = server(); const response = await f.call({}, { modern: true, capabilities });
    assert.equal(response.status, 200); assert.ok(!response.error);
    if (capabilities.elicitation && !capabilities.elicitation.url) {
      assert.equal(response.result.resultType, 'input_required');
      assert.equal(response.result.inputRequests.confirm.method, 'elicitation/create');
    } else {
      assert.equal(JSON.parse(response.result.content[0].text).status, 'pending');
    }
    assert.equal(f.calls.length, 1);
  }
});

test('native confirmation completes only after an authentic, user-and-client-bound requestState round trip', async () => {
  const f = server(); const transport = { modern: true, capabilities: { elicitation: { form: {} } } };
  const initial = await f.call({}, transport);
  const extra = { requestState: initial.result.requestState, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } };
  for (const change of [{ userId: 'bob' }, { clientId: 'different' }]) {
    const forged = await f.call({}, { ...transport, ...change }, extra);
    assert.equal(forged.error.code, -32602); assert.equal(f.calls.length, 1);
  }
  const tampered = await f.call({}, transport, { ...extra, requestState: extra.requestState + 'tamper' });
  assert.equal(tampered.error.code, -32602); assert.equal(f.calls.length, 1);
  const completed = await f.call({}, transport, extra);
  assert.equal(JSON.parse(completed.result.content[0].text).status, 'completed');
  assert.deepEqual(f.calls.at(-1), { path: 'respond-task-action', body: { taskId: 'task-1', requestId: 'request-1', decision: 'approve' } });
});

test('unsupported transports cannot smuggle approval and an isolated deployment never links to production', async () => {
  const f = server({ confirmationOrigin: null });
  const response = await f.call();
  const action = JSON.parse(response.result.content[0].text);
  assert.equal(action.confirmation_url, undefined); assert.match(action.next_action, /no configured Web/);
  const forged = await f.call({}, {}, { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
  assert.equal(forged.result.isError, true);
  assert.equal(f.calls.length, 1);
});

test('confirmation origins reject credentials, insecure remote URLs and non-Web schemes', () => {
  for (const confirmationOrigin of ['http://remote.example', 'https://user:password@fixture.test', 'javascript:alert(1)', 'https://fixture.test/path', 'https://fixture.test/?token=secret']) {
    assert.throws(() => server({ confirmationOrigin }), /confirmationOrigin/);
  }
  assert.doesNotThrow(() => server({ confirmationOrigin: 'http://localhost:5173' }));
});

test('start_task is advertised only by its desktop host, with an explicit idempotent assignment contract', async () => {
  const ordinary = server();
  const ordinaryList = await ordinary.rpc('tools/list', {});
  assert.ok(!ordinaryList.result.tools.some(tool => tool.name === 'start_task'));
  const started = [];
  const desktop = server({ startTask: async (_ctx, taskId, intent) => {
    if (taskId === 'full') throw new Error('担当タスクは3件までです');
    started.push({ taskId, intent });
    return { assigned: true, task_id: taskId };
  } });
  const initialization = await desktop.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  assert.match(initialization.result.instructions, /If start_task is available/);
  const list = await desktop.rpc('tools/list', {});
  const tool = list.result.tools.find(tool => tool.name === 'start_task');
  assert.deepEqual(tool.inputSchema.required.sort(), ['intent', 'task_id']);
  assert.deepEqual(tool.inputSchema.properties.intent.enum, ['consult', 'execute']);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  const call = args => desktop.rpc('tools/call', { name: 'start_task', arguments: args });
  const first = await call({ task_id: 'task-1', intent: 'consult' });
  assert.deepEqual(JSON.parse(first.result.content[0].text), { assigned: true, task_id: 'task-1' });
  await call({ task_id: 'task-1', intent: 'execute' });
  assert.deepEqual(started, [{ taskId: 'task-1', intent: 'consult' }, { taskId: 'task-1', intent: 'execute' }]);
  const full = await call({ task_id: 'full', intent: 'execute' });
  assert.equal(full.result.isError, true);
  assert.match(full.result.content[0].text, /3件/);
  for (const args of [{ task_id: 'task-1', intent: 'automatic' }, { task_id: '../task', intent: 'execute' }, { task_id: 'task-1' }]) await call(args);
  assert.equal(started.length, 2, 'invalid requests never reach the desktop mutation');
});

test('work tool results and MCP prompts share the late-assignment instructions', async () => {
  const desktop = server({
    fetchData: async () => ({ task: { id: 'task-1', text: 'Fixture', done: false } }),
    startTask: async () => { throw new Error('reading must not start work'); },
  });
  const view = await desktop.rpc('tools/call', { name: 'work_on_task', arguments: { task_id: 'task-1' } });
  const prompt = await desktop.rpc('prompts/get', { name: 'work_on_task', arguments: { task_id: 'task-1' } });
  for (const text of [JSON.parse(view.result.content[0].text).next_action, prompt.result.messages[0].content.text]) {
    assert.match(text, /If start_task is available/);
    assert.match(text, /no task was assigned at launch/);
    assert.match(text, /If start_task is not offered/);
    assert.match(text, /consultation to execution/);
  }
});

test('MCP picker resource allows its bundled wordmark fonts without opening network connections', async () => {
  const app = '<style>@font-face{font-family:"Instrument Serif";src:url(data:font/ttf;base64,fixture)}</style>';
  const f = server({ readApp: async () => app });
  const listed = await f.rpc('resources/list', {}, { modern: true });
  const uri = listed.result.resources[0].uri;
  const response = await f.rpc('resources/read', { uri }, { modern: true });
  assert.ok(response.result, JSON.stringify(response));
  const resource = response.result.contents[0];
  assert.equal(resource.text, app);
  assert.ok(resource._meta.ui.csp.resourceDomains.includes('data:'));
  assert.equal(resource._meta.ui.csp.connectDomains, undefined);
});
