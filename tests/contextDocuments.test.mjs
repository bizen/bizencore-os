import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/attachments.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { attachmentFrom, coerceAttachments, mergeAttachments, updateDocument, contextStorageError, MAX_ATTACHMENT_TEXT } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const document = () => attachmentFrom({ title: '設計方針', text: '# 最新の設計\n\n本文' }, 'ai', 'doc-1', 1);

test('documents preserve long text and reject excess rather than truncating', () => {
  const text = 'あ'.repeat(MAX_ATTACHMENT_TEXT);
  const attachment = attachmentFrom({ text }, 'human', 'long', 1);
  assert.equal(attachment.text, text);
  assert.equal(coerceAttachments([attachment])[0].text, text);
  assert.equal(attachmentFrom({ text: text + 'あ' }, 'ai', 'invalid', 1), null);
});

test('replacement and append keep the ID, origin and creation time', () => {
  const original = document();
  const replacement = updateDocument(original, { text: 'Updated', title: '改訂版', mode: 'replace', expectedRevision: 0 }, 2);
  assert.deepEqual({ id: replacement.id, by: replacement.by, createdAt: replacement.createdAt }, { id: original.id, by: original.by, createdAt: original.createdAt });
  assert.equal(replacement.revision, 1);
  const appended = updateDocument(replacement, { text: '補足', mode: 'append', expectedRevision: 1 }, 3);
  assert.equal(appended.text, 'Updated\n\n補足');
  assert.equal(appended.title, '改訂版');
  assert.equal(appended.revision, 2);
  assert.throws(() => updateDocument(appended, { text: '補足', mode: 'append', expectedRevision: 1 }, 4), /revision conflict/);
});

test('invalid, removed and oversized updates cannot modify a document', () => {
  for (const revision of [-1, 0.5, Number.NaN]) assert.throws(() => updateDocument(document(), { text: 'x', mode: 'replace', expectedRevision: revision }, 2), /revision conflict/);
  assert.throws(() => updateDocument({ ...document(), deletedAt: 2 }, { text: 'x', mode: 'replace', expectedRevision: 0 }, 3), /not found/);
  assert.throws(() => updateDocument({ ...document(), kind: 'link' }, { text: 'x', mode: 'replace', expectedRevision: 0 }, 3), /not found/);
  assert.throws(() => updateDocument(document(), { text: 'x'.repeat(MAX_ATTACHMENT_TEXT), mode: 'append', expectedRevision: 0 }, 3), /exceeds/);
  assert.throws(() => updateDocument(document(), { text: 'x', title: ' ', mode: 'replace', expectedRevision: 0 }, 3), /title/);
});

test('offline merge prefers the latest revision even when old text sorts later', () => {
  const stale = { ...document(), text: 'zzzz' };
  const fresh = updateDocument(stale, { text: 'aaaa', mode: 'replace', expectedRevision: 0 }, 2);
  assert.deepEqual(mergeAttachments([stale], [fresh]), [fresh]);
  assert.deepEqual(mergeAttachments([fresh], [stale]), [fresh]);
  const other = attachmentFrom({ text: '別の資料' }, 'human', 'other', 2);
  assert.equal(mergeAttachments([stale, other], [fresh]).length, 2);
  assert.equal(mergeAttachments([{ ...stale, deletedAt: 3 }], [fresh])[0].deletedAt, 3);
  assert.equal(mergeAttachments([fresh], [{ ...stale, deletedAt: 3 }])[0].deletedAt, 3);
});

test('aggregate limits count UTF-8 bytes and retained tombstones', () => {
  const one = { ...document(), text: 'あ'.repeat(90000) };
  assert.equal(contextStorageError([one]), undefined);
  assert.match(contextStorageError([one, { ...one, id: 'second', deletedAt: 2 }]), /512 KB/);
});

test('task store keeps unsaved documents out of state when local persistence fails', async () => {
  const compiled = await build({ entryPoints: ['src/lib/taskStore.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { taskStore, flushPersist } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const original = globalThis.localStorage;
  let stored;
  try {
    globalThis.localStorage = { setItem: (_key, value) => { stored = value; } };
    const id = taskStore.insertAfter(null);
    assert.equal(taskStore.addAttachment(id, { text: '長文'.repeat(5000) }), true);
    assert.equal(JSON.parse(stored).find(item => item.id === id).attachments[0].text.length, 10000);
    const before = taskStore.getState();
    globalThis.localStorage = { setItem: () => { throw new Error('QuotaExceeded'); } };
    assert.equal(taskStore.addAttachment(id, { text: '保存できない資料' }), false);
    assert.equal(taskStore.getState(), before);
    assert.equal(taskStore.addAttachment(id, { text: 'x'.repeat(100001) }), false);
  } finally { flushPersist(); globalThis.localStorage = original; }
});
