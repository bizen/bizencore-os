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
const { deleteWithConfirmation, withResolvedLabel, workOnTask } = await import(
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
    return Response.json(typeof routes[path] === 'function' ? routes[path](calls.at(-1).body) : routes[path]);
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

test('work_on_task presents readable choices and re-fetches the selected task by ID', async () => {
  const mock = mockConvex({
    list: { tasks: [{ id: 'task-1', text: 'Review mobile layout', label: 'Build' }], total_matching: 1 },
    get: { task: { id: 'task-1', text: 'Review mobile layout', done: false, note: 'Fresh details' }, path: [] },
  });
  try {
    const picker = await workOnTask(context());
    assert.equal(picker.resultType, 'input_required');
    const choice = picker.inputRequests.task.params.requestedSchema.properties.task.enum[0];
    assert.match(choice, /Review mobile layout/);
    assert.equal(mock.calls[0].path, 'list');

    const selected = await workOnTask(context({ task: { action: 'accept', content: { task: choice } } }, stateOf(picker)));
    const payload = JSON.parse(selected.content[0].text);
    assert.equal(payload.task.note, 'Fresh details');
    assert.match(payload.next_action, /record_task_progress/);
    assert.deepEqual(mock.calls.map((call) => call.path), ['list', 'get']);
    assert.equal(mock.calls[1].body.taskId, 'task-1');

    const forged = await workOnTask(context({ task: { action: 'accept', content: { task: 'Other task' } } }, stateOf(picker)));
    assert.equal(forged.isError, true);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('work_on_task supports exact IDs without elicitation and rejects completed tasks', async () => {
  const mock = mockConvex({ get: { task: { id: 'task-1', text: 'Done', done: true } } });
  try {
    const result = await workOnTask(context(), 'task-1');
    assert.equal(result.isError, true);
    assert.deepEqual(mock.calls.map((call) => call.path), ['get']);
  } finally {
    mock.restore();
  }
});

test('work_on_task can page through all tasks and search within the form', async () => {
  const all = Array.from({ length: 31 }, (_, index) => ({ id: `task-${index}`, text: `Task ${index}` }));
  const mock = mockConvex({
    list: (body) => {
      const matching = body.query ? all.filter((task) => task.text.includes(body.query)) : all;
      return { tasks: matching.slice(body.offset ?? 0, (body.offset ?? 0) + 30), total_matching: matching.length,
        ...((body.offset ?? 0) + 30 < matching.length ? { next_offset: (body.offset ?? 0) + 30 } : {}) };
    },
    get: { task: { id: 'task-30', text: 'Task 30', done: false }, path: [] },
  });
  try {
    const first = await workOnTask(context());
    assert.equal(first.resultType, 'input_required');
    assert.equal(mock.calls[0].body.flat, true);
    const choices = first.inputRequests.task.params.requestedSchema.properties.task.enum;
    assert.equal(choices.length, 31);
    const next = await workOnTask(context({ task: { action: 'accept', content: { task: '次の30件 →' } } }, stateOf(first)));
    assert.equal(next.resultType, 'input_required');
    assert.equal(mock.calls[1].body.offset, 30);
    const lastChoice = next.inputRequests.task.params.requestedSchema.properties.task.enum[0];
    assert.match(lastChoice, /Task 30/);
    const selected = await workOnTask(context({ task: { action: 'accept', content: { task: lastChoice } } }, stateOf(next)));
    assert.equal(JSON.parse(selected.content[0].text).task.id, 'task-30');

    const search = await workOnTask(context({ task: { action: 'accept', content: { search: 'Task 30' } } }, stateOf(first)));
    assert.equal(search.resultType, 'input_required');
    assert.equal(mock.calls.at(-1).body.query, 'Task 30');
    assert.equal(search.inputRequests.task.params.requestedSchema.properties.task.enum.length, 2);

    const emptySearch = await workOnTask(context({ task: { action: 'accept', content: { search: 'No match' } } }, stateOf(first)));
    assert.equal(emptySearch.resultType, 'input_required');
    assert.deepEqual(emptySearch.inputRequests.task.params.requestedSchema.properties.task.enum, ['検索を解除して全件を見る']);
    const reset = await workOnTask(context({ task: { action: 'accept', content: { task: '検索を解除して全件を見る' } } }, stateOf(emptySearch)));
    assert.equal(reset.resultType, 'input_required');
    assert.equal(mock.calls.at(-1).body.query, undefined);
  } finally {
    mock.restore();
  }
});
