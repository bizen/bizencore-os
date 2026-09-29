import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['convex/mcpTasks.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { add, list } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);

function memoryContext() {
  const rows = { syncItems: [], mcpIdempotency: [], userPreferences: [] };
  let nextId = 0;
  const db = {
    query(table) {
      let filters = [];
      const query = {
        withIndex(_index, callback) {
          const q = { eq(field, value) { filters.push((row) => row[field] === value); return q; },
            lt(field, value) { filters.push((row) => row[field] < value); return q; } };
          callback(q);
          return query;
        },
        async unique() { return rows[table].filter((row) => filters.every((filter) => filter(row)))[0] ?? null; },
        async collect() { return rows[table].filter((row) => filters.every((filter) => filter(row))); },
        async take(count) { return rows[table].filter((row) => filters.every((filter) => filter(row))).slice(0, count); },
      };
      return query;
    },
    async insert(table, value) {
      const id = String(++nextId);
      rows[table].push({ _id: id, ...value });
      return id;
    },
    async patch(id, value) {
      for (const table of Object.values(rows)) {
        const row = table.find((entry) => entry._id === id);
        if (row) { Object.assign(row, value); return; }
      }
      throw new Error('missing row');
    },
    async delete(id) {
      for (const table of Object.values(rows)) {
        const index = table.findIndex((entry) => entry._id === id);
        if (index >= 0) { table.splice(index, 1); return; }
      }
      throw new Error('missing row');
    },
  };
  return { ctx: { db }, rows };
}

test('add_task returns the original task on retries, even if the caller changes its key', async () => {
  const { ctx, rows } = memoryContext();
  const input = { userId: 'user-1', text: 'Send report', dueDate: '2026-10-13', completionCriteria: 'Approved by owner' };
  const first = await add._handler(ctx, input);
  const retry = await add._handler(ctx, input);
  const changedKey = await add._handler(ctx, { ...input, idempotencyKey: 'retry-key' });
  assert.equal(retry.id, first.id);
  assert.equal(changedKey.id, first.id);
  assert.equal(rows.syncItems.length, 1);
  assert.equal(JSON.parse(rows.syncItems[0].payload).completionCriteria, 'Approved by owner');
  await assert.rejects(
    add._handler(ctx, { userId: 'user-1', text: 'Different task', idempotencyKey: 'retry-key' }),
    /idempotency_key was already used/
  );
  assert.equal(rows.syncItems.length, 1);
  const anotherUser = await add._handler(ctx, { ...input, userId: 'user-2' });
  assert.notEqual(anotherUser.id, first.id);
  assert.equal(rows.syncItems.length, 2);
});

test('add_task rejects invalid deadlines before writing', async () => {
  const { ctx, rows } = memoryContext();
  await assert.rejects(
    add._handler(ctx, { userId: 'user-1', text: 'Send report', dueDate: '2026-02-29' }),
    /due_date must be YYYY-MM-DD/
  );
  await assert.rejects(
    add._handler(ctx, { userId: 'user-1', text: 'Send report', dueTime: '14:30' }),
    /due_time needs due_date/
  );
  assert.equal(rows.syncItems.length, 0);
});

test('list_tasks today: true uses the saved account time zone', async () => {
  const { ctx, rows } = memoryContext();
  const timeZone = 'Australia/Melbourne';
  rows.userPreferences.push({ userId: 'user-1', timeZone, automatic: false });
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Date.now());
  const part = (type) => parts.find((entry) => entry.type === type).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  await add._handler(ctx, { userId: 'user-1', text: 'Due today' });
  const item = JSON.parse(rows.syncItems[0].payload);
  rows.syncItems[0].payload = JSON.stringify({ ...item, assignedDate: today });
  const result = await list._handler(ctx, { userId: 'user-1', today: true });
  assert.equal(result.today_date, today);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].text, 'Due today');
});
