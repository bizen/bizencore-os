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
      ...(modern ? { 'Mcp-Method': method, 'Mcp-Name': params.name } : {}),
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
