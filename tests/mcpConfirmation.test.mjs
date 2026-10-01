import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_bG9jYWxob3N0JA==';
process.env.MCP_SHARED_SECRET = 'test-secret';
process.env.CONVEX_URL = 'https://test.convex.cloud';

const compiled = await build({
  entryPoints: ['api/mcp.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { deleteWithConfirmation, withResolvedLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
);

function context(inputResponses, state) {
  return {
    http: { authInfo: { clientId: 'unknown', extra: { userId: 'user-1' } } },
    mcpReq: { inputResponses, requestState: () => state },
  };
}

function stateOf(result) {
  return JSON.parse(Buffer.from(result.requestState.split('.')[1], 'base64url').toString()).p;
}

function mockConvex(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.split('/').at(-1);
    calls.push({ path, body: JSON.parse(options.body) });
    return Response.json(routes[path]);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('delete_task does not write until the exact task is confirmed', async () => {
  const mock = mockConvex({
    'preview-delete': { id: 'task-1', text: 'Parent', count: 3 },
    delete: { id: 'task-1', text: 'Parent', deleted: 3 },
  });
  try {
    const prompt = await deleteWithConfirmation(context(), 'task-1');
    assert.equal(prompt.resultType, 'input_required');
    assert.match(prompt.inputRequests.confirm.params.message, /サブタスク 2 件/);
    assert.deepEqual(mock.calls.map((call) => call.path), ['preview-delete']);

    const declined = await deleteWithConfirmation(context({ confirm: { action: 'decline' } }, stateOf(prompt)), 'task-1');
    assert.match(declined.content[0].text, /cancelled/);
    assert.deepEqual(mock.calls.map((call) => call.path), ['preview-delete', 'preview-delete']);

    const wrongTask = await deleteWithConfirmation(context({ confirm: { action: 'accept', content: { confirm: true } } }, stateOf(prompt)), 'task-2');
    assert.equal(wrongTask.isError, true);
    assert.equal(mock.calls.filter((call) => call.path === 'delete').length, 0);

    const confirmed = await deleteWithConfirmation(context({ confirm: { action: 'accept', content: { confirm: true } } }, stateOf(prompt)), 'task-1');
    assert.equal(JSON.parse(confirmed.content[0].text).deleted, 3);
    assert.equal(mock.calls.filter((call) => call.path === 'delete').length, 1);
    assert.deepEqual(mock.calls.at(-1).body, {
      taskId: 'task-1', expectedText: 'Parent', expectedCount: 3,
      userId: 'user-1', clientId: 'unknown',
    });
  } finally {
    mock.restore();
  }
});

test('unknown labels require an explicit choice before a write', async () => {
  const mock = mockConvex({ list: { labels: ['Work', 'Personal'], tasks: [] } });
  const written = [];
  const write = async (label) => {
    written.push(label);
    return { content: [{ type: 'text', text: label }] };
  };
  try {
    const blank = await withResolvedLabel(context(), '   ', 'add_task', write);
    assert.equal(blank.isError, true);
    assert.deepEqual(written, []);
    const prompt = await withResolvedLabel(context(), 'Wrok', 'add_task', write);
    assert.equal(prompt.resultType, 'input_required');
    assert.deepEqual(written, []);
    const selected = await withResolvedLabel(context({ label: { action: 'accept', content: { label: 'Work' } } }, stateOf(prompt)), 'Wrok', 'add_task', write);
    assert.equal(selected.content[0].text, 'Work');
    assert.deepEqual(written, ['Work']);

    const rejected = await withResolvedLabel(context({ label: { action: 'accept', content: { label: 'Invented' } } }, stateOf(prompt)), 'Wrok', 'add_task', write);
    assert.equal(rejected.isError, true);
    assert.deepEqual(written, ['Work']);
  } finally {
    mock.restore();
  }
});
