import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/lib/aiHandoff.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { AI_TARGETS, aiConversationLink, buildTaskHandoff, readHandoffPreferences, saveHandoffPreferences } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
);

function mockStorage(t, storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
}

test('handoff connection preferences persist without saving task intent or task data', t => {
  const store = new Map();
  mockStorage(t, { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) });
  assert.deepEqual(readHandoffPreferences(), { mode: 'mcp', destination: 'web' });
  saveHandoffPreferences({ mode: 'text', destination: 'desktop' });
  assert.deepEqual(readHandoffPreferences(), { mode: 'text', destination: 'desktop' });
  assert.deepEqual([...store.keys()], ['bizencore.aiHandoff']);
  assert.deepEqual(JSON.parse(store.get('bizencore.aiHandoff')), { mode: 'text', destination: 'desktop' });
});

test('corrupted or obsolete preferences safely return valid defaults', t => {
  let saved;
  mockStorage(t, { getItem: () => saved });
  for (saved of ['{', 'null', '42', '[]', '"text"', '{"mode":"invalid","destination":"invalid"}']) {
    assert.deepEqual(readHandoffPreferences(), { mode: 'mcp', destination: 'web' });
  }
  saved = '{"mode":"text","destination":"invalid"}';
  assert.deepEqual(readHandoffPreferences(), { mode: 'text', destination: 'web' });
});

test('unavailable preference storage does not break handoff', t => {
  mockStorage(t, { getItem: () => { throw new Error('storage blocked'); }, setItem: () => { throw new Error('storage blocked'); } });
  assert.deepEqual(readHandoffPreferences(), { mode: 'mcp', destination: 'web' });
  assert.doesNotThrow(() => saveHandoffPreferences({ mode: 'text', destination: 'desktop' }));
});

for (const target of AI_TARGETS.filter(target => target.kind === 'open')) {
  test(`${target.name} desktop link prefills the complete encoded prompt without sending`, () => {
    const prompt = '日本語の相談\n"quotes" & ? # / + %';
    for (const mode of ['mcp', 'text']) {
      const link = aiConversationLink(target, prompt, 'desktop', mode);
      const url = new URL(link.url);
      assert.equal(url.protocol, target.id === 'claude' ? 'claude:' : 'codex:');
      assert.equal(url.searchParams.get(target.id === 'claude' ? 'q' : 'prompt'), prompt);
      assert.equal(url.searchParams.has('send'), false);
      assert.equal(link.copyPrompt, false);
    }
  });

  test(`${target.name} Web behavior stays unchanged`, () => {
    const prompt = 'full prompt';
    const mcp = aiConversationLink(target, prompt, 'web', 'mcp');
    assert.equal(mcp.url, target.url(prompt));
    assert.equal(mcp.copyPrompt, false);
    const snapshot = aiConversationLink(target, prompt, 'web', 'text');
    assert.equal(snapshot.url, target.url(''));
    assert.equal(snapshot.copyPrompt, true);
  });

  test(`${target.name} oversized desktop links fall back to a full prompt copy and an empty chat`, () => {
    const link = aiConversationLink(target, '日本語'.repeat(5000), 'desktop', 'text');
    assert.equal(link.copyPrompt, true);
    assert.equal(link.url, target.desktopUrl(''));
  });
}

test('Claude prompt limit never silently truncates a snapshot', () => {
  const target = AI_TARGETS.find(target => target.id === 'claude');
  assert.equal(aiConversationLink(target, 'x'.repeat(14_000), 'desktop', 'text').copyPrompt, false);
  assert.equal(aiConversationLink(target, 'x'.repeat(14_001), 'desktop', 'text').copyPrompt, true);
});

test('CLI command copies retain shell quoting', () => {
  for (const target of AI_TARGETS.filter(target => target.kind === 'copy')) {
    assert.equal(target.command("a'b"), `${target.id === 'codex' ? 'codex' : 'claude'} 'a'\\''b'`);
  }
});

const task = {
  id: 'task-1', type: 'task', parentId: null, order: 0, text: 'Build the feature',
  note: 'Private working note', done: false, createdAt: 1, updatedAt: 1,
};

test('MCP handoff sends the ID but not a stale private snapshot', () => {
  const prompt = buildTaskHandoff(task, { [task.id]: task }, 'mcp');
  assert.match(prompt, /task_id "task-1"/);
  assert.match(prompt, /record_task_progress/);
  assert.doesNotMatch(prompt, /Private working note/);
  assert.match(prompt, /接続できない場合/);
  assert.match(prompt, /Wait for the user's answer before implementation or task changes/);
});

test('text handoff carries a snapshot and discloses that it cannot sync', () => {
  const withFile = { ...task, attachments: [{ id: 'file-1', kind: 'file', title: 'notes.pdf', storageId: 'file-id', by: 'human', createdAt: 1 }] };
  const prompt = buildTaskHandoff(withFile, { [task.id]: withFile }, 'text');
  assert.match(prompt, /Private working note/);
  assert.match(prompt, /自動反映はできません/);
  assert.match(prompt, /ファイルの実体を渡せません/);
  assert.doesNotMatch(prompt, /task_id/);
  assert.match(prompt, /Then ask one focused question/);
  assert.match(prompt, /Wait for the user's answer before implementation or task changes/);
});

test('text handoff discloses a locked persistent container rather than inviting its completion', () => {
  const locked = { ...task, locked: true };
  const prompt = buildTaskHandoff(locked, { [locked.id]: locked }, 'text');
  assert.match(prompt, /ロック: 完了不可/);
});

for (const mode of ['mcp', 'text']) {
  test(`${mode} consultation handoff carries confirmed intent without authorizing implementation`, () => {
    const prompt = buildTaskHandoff(task, { [task.id]: task }, mode, 'consult');
    assert.match(prompt, /検討・相談/);
    assert.match(prompt, /explicitly selected "検討する"/);
    assert.match(prompt, /without implementing/);
    assert.match(prompt, /only after the user later explicitly agrees/);
    assert.match(prompt, /Do not ask whether they want consultation or execution again/);
    assert.doesNotMatch(prompt, /Then ask one focused question|今回どう進めたいか確認/);
    if (mode === 'mcp') {
      assert.match(prompt, /task_id "task-1"/);
      assert.match(prompt, /attach_context|record_task_progress/);
      assert.doesNotMatch(prompt, /Private working note/);
    } else {
      assert.match(prompt, /Private working note/);
      assert.match(prompt, /自動反映はできません/);
      assert.doesNotMatch(prompt, /work_on_task tool with task_id/);
    }
  });

  test(`${mode} execution handoff proceeds while retaining clarification, verification and locks`, () => {
    const locked = { ...task, locked: true };
    const prompt = buildTaskHandoff(locked, { [task.id]: locked }, mode, 'execute');
    assert.match(prompt, /explicitly selected "実行する"/);
    assert.match(prompt, /Do the actual work within the agreed scope/);
    assert.match(prompt, /only when essential information is missing/);
    assert.match(prompt, /Verify the outcome against the completion criteria/);
    assert.doesNotMatch(prompt, /Then ask one focused question|今回どう進めたいか確認/);
    assert.match(prompt, mode === 'mcp' ? /do not complete them or try to unlock them/ : /ロック: 完了不可/);
  });
}
