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
const { add, addMany, attach, updateContext, complete, get, list, taskView, previewDelete, recordProgress, remove } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);

test('MCP documents are readable and replace/append without accumulating attachments', async () => {
  const { ctx, rows } = memoryContext();
  const task = await add._handler(ctx, { userId: 'user-1', text: 'Plan' });
  const input = { userId: 'user-1', taskId: task.id, title: 'Design', text: '# Design\n' + '文章'.repeat(5000) };
  const first = await attach._handler(ctx, input);
  assert.equal((await attach._handler(ctx, input)).id, first.id);
  await assert.rejects(attach._handler(ctx, { ...input, text: 'Different content' }), /use update_context/);
  assert.equal((await get._handler(ctx, { userId: 'user-1', taskId: task.id })).task.attachments[0].text, input.text);
  assert.equal((await list._handler(ctx, { userId: 'user-1' })).tasks[0].attachments[0].revision, 0);
  const preview = (await list._handler(ctx, { userId: 'user-1' })).tasks[0].attachments[0];
  assert.equal(preview.text.length, 4000);
  assert.equal(preview.text_truncated, true);
  assert.equal(preview.text_length, input.text.length);
  const update = { userId: 'user-1', taskId: task.id, attachmentId: first.id, text: 'Current design', mode: 'replace', expectedRevision: 0 };
  assert.equal((await updateContext._handler(ctx, update)).revision, 1);
  const append = { ...update, text: 'Supplement', mode: 'append', expectedRevision: 1 };
  assert.equal((await updateContext._handler(ctx, append)).revision, 2);
  const before = JSON.stringify(rows.syncItems);
  await assert.rejects(updateContext._handler(ctx, append), /revision conflict/);
  await assert.rejects(updateContext._handler(ctx, { ...append, userId: 'other' }), /task not found/);
  await assert.rejects(updateContext._handler(ctx, { ...append, expectedRevision: 2, text: 'x'.repeat(100001) }), /exceeds/);
  assert.equal(JSON.stringify(rows.syncItems), before);
  const view = await get._handler(ctx, { userId: 'user-1', taskId: task.id });
  assert.equal(view.task.attachments.length, 1);
  assert.equal(view.task.attachments[0].id, first.id);
  assert.equal(view.task.attachments[0].text, 'Current design\n\nSupplement');
});

test('MCP refuses missing, removed and non-document attachment updates', async () => {
  const { ctx, rows } = memoryContext();
  const task = await add._handler(ctx, { userId: 'user-1', text: 'Task' });
  const link = await attach._handler(ctx, { userId: 'user-1', taskId: task.id, url: 'https://example.com', title: 'Link' });
  const input = { userId: 'user-1', taskId: task.id, attachmentId: link.id, text: 'New', mode: 'replace', expectedRevision: 0 };
  await assert.rejects(updateContext._handler(ctx, input), /document not found/);
  const row = rows.syncItems[0];
  const payload = JSON.parse(row.payload);
  payload.attachments[0] = { ...payload.attachments[0], kind: 'text', text: 'Old', deletedAt: 5 };
  row.payload = JSON.stringify(payload);
  await assert.rejects(updateContext._handler(ctx, input), /document not found/);
  await assert.rejects(attach._handler(ctx, { userId: 'user-1', taskId: task.id, text: 'x'.repeat(100001) }), /exceeds/);
});

test('progress updates reuse one status document instead of creating a journal', async () => {
  const { ctx } = memoryContext();
  const task = await add._handler(ctx, { userId: 'user-1', text: 'Work' });
  const input = { userId: 'user-1', taskId: task.id, completedSubtaskIds: [], remainingSubtasks: [], progressNote: 'First step' };
  await recordProgress._handler(ctx, input);
  const first = (await get._handler(ctx, { userId: 'user-1', taskId: task.id })).task.attachments[0];
  await recordProgress._handler(ctx, { ...input, progressNote: 'Second step' });
  await recordProgress._handler(ctx, { ...input, progressNote: 'Second step' });
  const taskView = (await get._handler(ctx, { userId: 'user-1', taskId: task.id })).task;
  assert.equal(taskView.attachments.length, 1);
  assert.equal(taskView.attachments[0].id, first.id);
  assert.equal(taskView.attachments[0].title, '作業状況');
  assert.equal(taskView.attachments[0].text, 'Second step');
  assert.equal(taskView.attachments[0].revision, 1);
  assert.equal(taskView.done, false);
});

test('MCP exposes lock state and rejects direct or ancestor completion before any writes', async () => {
  const { ctx, rows } = memoryContext();
  const ancestor = await add._handler(ctx, { userId: 'user-1', text: 'Projects' });
  const container = await add._handler(ctx, { userId: 'user-1', parentId: ancestor.id, text: 'Reading list' });
  const child = await add._handler(ctx, { userId: 'user-1', parentId: container.id, text: 'Read chapter' });
  const row = rows.syncItems.find((row) => row.itemId === container.id);
  row.payload = JSON.stringify({ ...JSON.parse(row.payload), locked: true });
  const before = JSON.stringify(rows.syncItems);
  await assert.rejects(complete._handler(ctx, { userId: 'user-1', taskId: container.id }), /locked/);
  await assert.rejects(complete._handler(ctx, { userId: 'user-1', taskId: ancestor.id }), /locked/);
  await assert.rejects(recordProgress._handler(ctx, { userId: 'user-1', taskId: ancestor.id, completedSubtaskIds: [child.id, container.id], remainingSubtasks: [] }), /locked/);
  assert.equal(JSON.stringify(rows.syncItems), before);
  assert.equal((await get._handler(ctx, { userId: 'user-1', taskId: container.id })).task.locked, true);
  assert.equal((await list._handler(ctx, { userId: 'user-1', flat: true })).tasks.find((task) => task.id === container.id).locked, true);
  assert.equal((await list._handler(ctx, { userId: 'user-1' })).tasks[0].subtasks[0].locked, true);
  assert.equal((await taskView._handler(ctx, { userId: 'user-1' })).items.find((item) => item.id === container.id).locked, true);
  await recordProgress._handler(ctx, { userId: 'user-1', taskId: container.id, completedSubtaskIds: [child.id], remainingSubtasks: [] });
  assert.equal(JSON.parse(rows.syncItems.find((row) => row.itemId === child.id).payload).done, true);
  assert.equal(JSON.parse(row.payload).done, false);
  row.payload = JSON.stringify({ ...JSON.parse(row.payload), locked: false });
  await complete._handler(ctx, { userId: 'user-1', taskId: ancestor.id });
  assert.equal(JSON.parse(row.payload).done, true);
});

function memoryContext() {
  const rows = { syncItems: [], mcpIdempotency: [], userPreferences: [], fileOwners: [] };
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

test('embedded view preserves labels, hierarchy and account time zone without exposing sync internals', async () => {
  const { ctx, rows } = memoryContext();
  rows.userPreferences.push({ userId: 'user-1', timeZone: 'Australia/Melbourne', automatic: false });
  rows.syncItems.push({ userId: 'user-1', itemId: 'label', updatedAt: 1, payload: JSON.stringify({ type: 'section', text: 'Build', note: 'Purpose', color: 'violet', order: 0 }) });
  const parent = await add._handler(ctx, { userId: 'user-1', label: 'Build', text: 'Launch', completionCriteria: 'Verified', dueDate: '2026-10-05', clientName: 'Codex' });
  await add._handler(ctx, { userId: 'user-1', parentId: parent.id, text: 'Test' });
  await add._handler(ctx, { userId: 'other-user', text: 'Private other account' });
  const result = await taskView._handler(ctx, { userId: 'user-1' });
  assert.equal(result.items.length, 3);
  assert.equal(result.time_zone, 'Australia/Melbourne');
  assert.equal(result.items.find((item) => item.id === 'label').color, 'violet');
  assert.equal(result.items.find((item) => item.id === 'label').note, 'Purpose');
  const task = result.items.find((item) => item.id === parent.id);
  assert.equal(task.parentId, 'label');
  assert.equal(task.completionCriteria, 'Verified');
  assert.equal(task.dueDate, '2026-10-05');
  assert.equal(task.createdByClient, 'Codex');
  assert.equal('stamps' in task, false);
  assert.equal('attachments' in task, false);
  assert.equal('userId' in task, false);
  assert.equal(result.items.some((item) => item.text === 'Private other account'), false);
});

test('embedded view pages all rows and does not truncate a large account', async () => {
  const { ctx, rows } = memoryContext();
  for (let i = 0; i < 205; i++) rows.syncItems.push({ userId: 'user-1', itemId: `item-${i}`, updatedAt: i + 1, payload: JSON.stringify({ text: `Task ${i}`, order: i }) });
  const first = await taskView._handler(ctx, { userId: 'user-1' });
  const second = await taskView._handler(ctx, { userId: 'user-1', offset: first.next_offset });
  assert.equal(first.items.length, 200);
  assert.equal(second.items.length, 5);
  assert.equal(second.next_offset, undefined);
  assert.equal(first.total, 205);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 205);
  await assert.rejects(taskView._handler(ctx, { userId: 'user-1', offset: -1 }), /offset must be/);
});

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

test('list_tasks searches subtasks and returns bounded pages', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Launch plan' });
  const child = await add._handler(ctx, { userId: 'user-1', text: 'Review press kit', parentId: parent.id });
  await add._handler(ctx, { userId: 'user-1', text: 'Review schedule' });

  const first = await list._handler(ctx, { userId: 'user-1', query: 'REVIEW', limit: 1 });
  assert.equal(first.total_matching, 2);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].id, child.id);
  assert.equal(first.next_offset, 1);
  const second = await list._handler(ctx, { userId: 'user-1', query: 'review', limit: 1, offset: first.next_offset });
  assert.equal(second.tasks[0].text, 'Review schedule');
  assert.equal(second.next_offset, undefined);

  await assert.rejects(list._handler(ctx, { userId: 'user-1', limit: 101 }), /limit must be 1-100/);
  await assert.rejects(list._handler(ctx, { userId: 'user-1', offset: -1 }), /offset must be a non-negative integer/);
  assert.equal(rows.syncItems.length, 3);
});

test('flat task pages include subtasks so every unfinished task can be selected', async () => {
  const { ctx } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Launch' });
  const child = await add._handler(ctx, { userId: 'user-1', text: 'Check copy', parentId: parent.id });
  const first = await list._handler(ctx, { userId: 'user-1', flat: true, limit: 1 });
  assert.equal(first.total_matching, 2);
  assert.equal(first.tasks[0].id, parent.id);
  const second = await list._handler(ctx, { userId: 'user-1', flat: true, limit: 1, offset: first.next_offset });
  assert.equal(second.tasks[0].id, child.id);
  assert.equal(second.tasks[0].parent_task, 'Launch');
  assert.equal(second.next_offset, undefined);
});

test('unknown labels never silently add tasks at the top level', async () => {
  const { ctx, rows } = memoryContext();
  await assert.rejects(add._handler(ctx, { userId: 'user-1', text: 'File report', label: 'Unknown' }), /label not found/);
  await assert.rejects(add._handler(ctx, { userId: 'user-1', text: 'File report', label: '   ' }), /label is empty/);
  assert.equal(rows.syncItems.length, 0);
});

test('delete checks the confirmed task snapshot before removing its subtree', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Launch plan' });
  await add._handler(ctx, { userId: 'user-1', text: 'Review press kit', parentId: parent.id });
  const preview = await previewDelete._handler(ctx, { userId: 'user-1', taskId: parent.id });
  assert.deepEqual(preview, { id: parent.id, text: 'Launch plan', count: 2 });
  await assert.rejects(remove._handler(ctx, {
    userId: 'user-1', taskId: parent.id, expectedText: preview.text, expectedCount: 1,
  }), /task changed/);
  assert.equal(rows.syncItems.filter((row) => row.deletedAt).length, 0);
  const result = await remove._handler(ctx, {
    userId: 'user-1', taskId: parent.id, expectedText: preview.text, expectedCount: preview.count,
  });
  assert.equal(result.deleted, 2);
  assert.equal(rows.syncItems.filter((row) => row.deletedAt).length, 2);
});

test('MCP completion marks changed tasks as AI-completed and clears the mark on reopen', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Ship release', clientName: 'Codex' });
  const child = await add._handler(ctx, { userId: 'user-1', text: 'Run checks', parentId: parent.id });
  await add._handler(ctx, { userId: 'user-1', text: 'Check migration', parentId: child.id });

  await complete._handler(ctx, { userId: 'user-1', taskId: parent.id, clientName: 'Claude Code' });
  for (const row of rows.syncItems) {
    const item = JSON.parse(row.payload);
    assert.equal(item.done, true);
    assert.equal(item.completedBy, 'ai');
    assert.equal(item.completedByClient, 'Claude Code');
    assert.equal(item.stamps.done > 0, true);
  }
  const result = await list._handler(ctx, { userId: 'user-1', includeDone: true });
  assert.equal(result.tasks[0].created_by, 'agent');
  assert.equal(result.tasks[0].created_by_client, 'Codex');
  assert.equal(result.tasks[0].completed_by, 'agent');
  assert.equal(result.tasks[0].completed_by_client, 'Claude Code');
  assert.equal(result.tasks[0].subtasks[0].completed_by_client, 'Claude Code');

  await complete._handler(ctx, { userId: 'user-1', taskId: child.id, done: false });
  const reopened = JSON.parse(rows.syncItems.find((row) => row.itemId === child.id).payload);
  assert.equal(reopened.done, false);
  assert.equal(reopened.completedBy, undefined);
  assert.equal(reopened.completedByClient, undefined);
  assert.equal(JSON.parse(rows.syncItems.find((row) => row.itemId === parent.id).payload).completedBy, 'ai');
});

test('bulk MCP creation records the client on parents and subtasks', async () => {
  const { ctx, rows } = memoryContext();
  await addMany._handler(ctx, {
    userId: 'user-1', clientName: ' Codex ',
    tasks: [{ text: 'Prepare launch', subtasks: [{ text: 'Check copy' }] }],
  });
  assert.equal(rows.syncItems.length, 2);
  for (const row of rows.syncItems) {
    const item = JSON.parse(row.payload);
    assert.equal(item.createdBy, 'ai');
    assert.equal(item.createdByClient, 'Codex');
  }
});

test('get_task reads the selected task by ID with its full nested progress and isolates users', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Ship launch', note: 'Check all assets', completionCriteria: 'Live and verified' });
  const child = await add._handler(ctx, { userId: 'user-1', text: 'Build page', parentId: parent.id });
  await add._handler(ctx, { userId: 'user-1', text: 'Run mobile checks', parentId: child.id });
  const parentRow = rows.syncItems.find((row) => row.itemId === parent.id);
  parentRow.payload = JSON.stringify({ ...JSON.parse(parentRow.payload), attachments: [{
    id: 'attachment-1', kind: 'text', text: 'Approved brief', by: 'human', createdAt: 1,
  }] });

  const detail = await get._handler(ctx, { userId: 'user-1', taskId: parent.id });
  assert.equal(detail.task.note, 'Check all assets');
  assert.equal(detail.task.completion_criteria, 'Live and verified');
  assert.equal(detail.task.attachments[0].text, 'Approved brief');
  assert.equal(detail.task.subtasks[0].subtasks[0].text, 'Run mobile checks');
  const childDetail = await get._handler(ctx, { userId: 'user-1', taskId: child.id });
  assert.deepEqual(childDetail.path, [{ id: parent.id, text: 'Ship launch', type: 'task' }]);
  await assert.rejects(get._handler(ctx, { userId: 'user-2', taskId: parent.id }), /task not found/);
});

test('record_task_progress checks only verified subtasks, adds remaining work once, and leaves parent open', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Ship launch' });
  const done = await add._handler(ctx, { userId: 'user-1', text: 'Build page', parentId: parent.id });
  const input = {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [done.id],
    remainingSubtasks: [{ text: 'Run mobile checks', note: 'Check 375px' }],
    progressNote: 'The page is built; mobile verification remains.', clientName: 'Codex',
  };
  const first = await recordProgress._handler(ctx, input);
  assert.equal(first.added_subtasks.length, 1);
  const retry = await recordProgress._handler(ctx, input);
  assert.equal(retry.added_subtasks.length, 0);
  assert.equal(retry.existing_subtasks[0].id, first.added_subtasks[0].id);
  assert.equal(rows.syncItems.length, 3);

  const detail = await get._handler(ctx, { userId: 'user-1', taskId: parent.id });
  assert.equal(detail.task.done, false);
  assert.equal(detail.task.subtasks[0].done, true);
  assert.equal(detail.task.subtasks[0].completed_by_client, 'Codex');
  assert.equal(detail.task.subtasks[1].done, false);
  assert.equal(detail.task.subtasks[1].note, 'Check 375px');
  assert.equal(detail.task.attachments.length, 1);
  await assert.rejects(recordProgress._handler(ctx, {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [],
    remainingSubtasks: [{ text: 'Build page' }],
  }), /already complete/);
});

test('record_task_progress can preserve a consultation blocker without inventing subtasks', async () => {
  const { ctx } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Share tasks with a partner' });
  const input = {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [], remainingSubtasks: [],
    progressNote: 'Need a decision on whether task attachments are visible to the partner.',
  };
  await recordProgress._handler(ctx, input);
  await recordProgress._handler(ctx, input);
  const detail = await get._handler(ctx, { userId: 'user-1', taskId: parent.id });
  assert.equal(detail.task.done, false);
  assert.deepEqual(detail.task.subtasks ?? [], []);
  assert.equal(detail.task.attachments.length, 1);
  assert.match(detail.task.attachments[0].text, /attachments are visible/);
});

test('record_task_progress rejects foreign children and premature parent-subtask completion', async () => {
  const { ctx, rows } = memoryContext();
  const parent = await add._handler(ctx, { userId: 'user-1', text: 'Ship launch' });
  const child = await add._handler(ctx, { userId: 'user-1', text: 'Build page', parentId: parent.id });
  const grandchild = await add._handler(ctx, { userId: 'user-1', text: 'Check mobile', parentId: child.id });
  const other = await add._handler(ctx, { userId: 'user-2', text: 'Private task' });
  await assert.rejects(recordProgress._handler(ctx, {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [other.id], remainingSubtasks: [],
  }), /must belong/);
  await assert.rejects(recordProgress._handler(ctx, {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [child.id], remainingSubtasks: [],
  }), /descendants first/);
  assert.equal(rows.syncItems.filter((row) => JSON.parse(row.payload).done).length, 0);
  await recordProgress._handler(ctx, {
    userId: 'user-1', taskId: parent.id, completedSubtaskIds: [child.id, grandchild.id], remainingSubtasks: [],
  });
  assert.equal((await get._handler(ctx, { userId: 'user-1', taskId: parent.id })).task.done, false);
});
