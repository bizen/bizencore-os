import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, opendir, readFile, realpath, rm, stat, symlink, writeFile, utimes, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureOwnedCodexProcessSession, captureOwnedCodexSession, isSessionId, listConversations, readOwnedSessionIndex, recordOwnedSession, validateConversationCandidate, validateResumeSessionId, writeOwnedSessionIndex } from '../desktop/electron/conversations.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'conversation-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const cliHome = path.join(root, 'cli');
  await mkdir(cwd);
  await mkdir(cliHome);
  const options = { cliHome, accountId: 'account-a', environmentId: 'development' };
  return { root, cwd, cliHome, options };
}

async function codexFile(f, id, payload = {}) {
  const dir = path.join(f.cliHome, 'sessions', '2026', '10', '12');
  await mkdir(dir, { recursive: true });
  const filename = path.join(dir, `rollout-2026-10-12T00-00-00-${id}.jsonl`);
  await writeFile(filename, JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.cwd, source: 'cli', ...payload } }) +
    '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'SECRET TRANSCRIPT $(touch leaked)' } }) + '\n');
  return filename;
}

async function claudeIndex(f, rows) {
  const project = path.join(f.cliHome, 'projects', f.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'sessions-index.json'), JSON.stringify({ version: 1, entries: rows }));
  for (const row of rows) if (isSessionId(row.sessionId)) await writeFile(path.join(project, `${row.sessionId}.jsonl`), 'NOT JSON; SECRET TRANSCRIPT');
  return project;
}

test('UUID allowlist rejects CLI selectors, paths, control characters and non UUIDs', () => {
  assert.ok(isSessionId(randomUUID()));
  assert.ok(isSessionId('01a0eb80-b9ad-7a81-ba31-31e2da8c4ed6'));
  for (const id of ['--last', '../id', randomUUID() + '\n', randomUUID() + '\0', '00000000-0000-0000-0000-000000000000', null]) assert.equal(isSessionId(id), false);
});

test('Codex exposes only allowed, exact-folder, interactive metadata and validates resume independently of list limit', async t => {
  const f = await fixture(t);
  const good = randomUUID(), foreign = randomUUID(), subagent = randomUUID(), unowned = randomUUID();
  await codexFile(f, good, { instructions: 'SECRET INSTRUCTIONS', title: 'SECRET TITLE' });
  await codexFile(f, foreign, { cwd: f.cwd + '-other' });
  await codexFile(f, subagent, { source: { subagent: 'thread' } });
  await codexFile(f, unowned);
  const options = { ...f.options, ownedIds: [good, foreign, subagent] };
  const rows = await listConversations('codex', f.cwd, options);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agent', 'cwd', 'sessionId', 'title', 'updatedAt']);
  assert.equal(rows[0].sessionId, good);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|instructions|payload|\.jsonl/);
  assert.equal(await validateResumeSessionId('codex', f.cwd, good.toUpperCase(), { ...options, limit: 1 }), good);
  for (const id of [foreign, subagent, unowned]) await assert.rejects(validateResumeSessionId('codex', f.cwd, id, options), /not permitted/);
  await assert.rejects(validateResumeSessionId('codex', f.cwd, '--last', options), /Invalid resume/);
  assert.deepEqual(await listConversations('codex', f.cwd, { ...options, maxEntries: 1 }), []);
});

test('missing ownership fails closed and app index enforces account, environment, agent, home and cwd', async t => {
  const f = await fixture(t), id = randomUUID();
  await codexFile(f, id);
  const ownedSessions = recordOwnedSession([], { ...f.options, agent: 'codex', cwd: f.cwd, sessionId: id, prompt: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(ownedSessions), /prompt|SECRET/);
  const options = { ...f.options, ownedSessions };
  assert.equal((await listConversations('codex', f.cwd, options)).length, 1);
  for (const patch of [{ ownedSessions: [] }, { accountId: 'account-b' }, { environmentId: 'production' }, { accountId: undefined }, { cliHome: f.root }]) {
    assert.deepEqual(await listConversations('codex', f.cwd, { ...options, ...patch }), []);
  }
  assert.deepEqual(await listConversations('codex', f.cwd, { cliHome: f.cliHome }), []);
  assert.deepEqual(await listConversations('codex', f.cwd + '-other', options), []);
  assert.deepEqual(await listConversations('claude', f.cwd, options), []);
  assert.equal(recordOwnedSession(ownedSessions, ownedSessions[0]).length, 1);
  assert.throws(() => recordOwnedSession([], { ...ownedSessions[0], sessionId: '--last' }));
});

test('Claude reads the metadata index only and rejects sidechains and folder encoding collisions', async t => {
  const f = await fixture(t), good = randomUUID(), foreign = randomUUID(), sidechain = randomUUID();
  await claudeIndex(f, [
    { sessionId: good, projectPath: f.cwd, isSidechain: false, firstPrompt: 'SECRET PROMPT', summary: 'SECRET SUMMARY' },
    { sessionId: foreign, projectPath: f.cwd + '/elsewhere', isSidechain: false },
    { sessionId: sidechain, projectPath: f.cwd, isSidechain: true },
    { sessionId: 100, projectPath: f.cwd, isSidechain: false },
  ]);
  const options = { ...f.options, ownedIds: [good, foreign, sidechain] };
  const rows = await listConversations('claude', f.cwd, options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, good);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|firstPrompt|summary|\.jsonl/);
  assert.equal(await validateResumeSessionId('claude', f.cwd, good, options), good);
  await assert.rejects(validateResumeSessionId('claude', f.cwd, foreign, options));
});

test('Claude app-owned metadata works without native index and custom project names are bounded', async t => {
  const f = await fixture(t), id = randomUUID();
  const project = await claudeIndex(f, [{ sessionId: id }]);
  await rm(path.join(project, 'sessions-index.json'));
  assert.deepEqual(await listConversations('claude', f.cwd, { ...f.options, ownedIds: [id] }), []);
  const ownedSessions = recordOwnedSession([], { ...f.options, agent: 'claude', sessionId: id, cwd: f.cwd });
  assert.equal((await listConversations('claude', f.cwd, { ...f.options, ownedSessions })).length, 1);
  assert.deepEqual(await listConversations('claude', f.cwd, { ...f.options, ownedSessions, claudeProjectDirName: '../outside' }), []);
});

test('Codex malformed and oversized first records cannot fall back to transcript or later metadata', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = await codexFile(f, id);
  const options = { ...f.options, ownedIds: [id] };
  for (const content of ['invalid\n', JSON.stringify({ type: 'response_item', payload: { id, cwd: f.cwd, source: 'cli' } }) + '\n',
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.cwd, source: 'cli', instructions: 'x'.repeat(65536) } }) + '\n']) {
    await writeFile(filename, content);
    assert.deepEqual(await listConversations('codex', f.cwd, options), []);
  }
});

test('symlink files, ancestor directories, selected folders and hardlinks are excluded', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = await codexFile(f, id);
  const outside = path.join(f.root, 'outside.jsonl');
  const options = { ...f.options, ownedIds: [id] };
  await writeFile(outside, JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.cwd, source: 'cli' } }) + '\n');
  await rm(filename);
  await symlink(outside, filename);
  assert.deepEqual(await listConversations('codex', f.cwd, options), []);
  await rm(filename);
  await link(outside, filename);
  assert.deepEqual(await listConversations('codex', f.cwd, options), []);
  const alias = path.join(f.root, 'alias');
  await symlink(f.cliHome, alias);
  assert.deepEqual(await listConversations('codex', f.cwd, { ...options, cliHome: alias }), []);
  const folderAlias = path.join(f.root, 'folder-alias');
  await symlink(f.cwd, folderAlias);
  assert.deepEqual(await listConversations('codex', folderAlias, options), []);
});

test('Claude rejects symlinked index/transcript and oversize indexes', async t => {
  const f = await fixture(t), id = randomUUID();
  const project = await claudeIndex(f, [{ sessionId: id, projectPath: f.cwd, isSidechain: false }]);
  const index = path.join(project, 'sessions-index.json');
  const outside = path.join(f.root, 'outside-index');
  const options = { ...f.options, ownedIds: [id] };
  await writeFile(outside, JSON.stringify({ entries: [{ sessionId: id, projectPath: f.cwd, isSidechain: false }] }));
  await rm(index);
  await symlink(outside, index);
  assert.deepEqual(await listConversations('claude', f.cwd, options), []);
  await rm(index);
  await writeFile(index, ' '.repeat(512 * 1024 + 1));
  assert.deepEqual(await listConversations('claude', f.cwd, options), []);
  await writeFile(index, JSON.stringify({ entries: [{ sessionId: id, projectPath: f.cwd, isSidechain: false }] }));
  await rm(path.join(project, `${id}.jsonl`));
  await symlink(outside, path.join(project, `${id}.jsonl`));
  assert.deepEqual(await listConversations('claude', f.cwd, options), []);
});

test('results are recent-first, deduplicated and bounded while old selected IDs still validate', async t => {
  const f = await fixture(t), ids = [];
  for (let i = 0; i < 52; i++) {
    const id = randomUUID(); ids.push(id);
    const filename = await codexFile(f, id);
    await utimes(filename, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
  }
  const options = { ...f.options, ownedIds: ids };
  assert.equal((await listConversations('codex', f.cwd, options)).length, 20);
  const rows = await listConversations('codex', f.cwd, { ...options, limit: 1000 });
  assert.equal(rows.length, 50);
  assert.equal(rows[0].sessionId, ids.at(-1));
  assert.equal(await validateResumeSessionId('codex', f.cwd, ids[0], options), ids[0]);
});

test('ownedSince alone cannot grant ownership, and cannot capture from shared CLI homes', async t => {
  const f = await fixture(t), id = randomUUID(), ownedSince = Date.now() - 1000;
  await codexFile(f, id, { timestamp: new Date().toISOString(), cli_version: '0.162.0-alpha.2' });
  const options = { ...f.options, ownedSince, cliVersion: '0.162.0-alpha.2' };
  assert.deepEqual(await listConversations('codex', f.cwd, options), []);
  assert.equal(await captureOwnedCodexSession(f.cwd, options), null);
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: false }), null);
  const record = await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: true });
  assert.equal(record.sessionId, id);
  assert.doesNotMatch(JSON.stringify(record), /timestamp|cli_version|SECRET/);
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: true, cliVersion: 'different' }), null);
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: true, ownedSince: Date.now() + 10000 }), null);
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: true, maxEntries: 1 }), null);
  assert.equal((await listConversations('codex', f.cwd, { ...options, ownedIds: [id] })).length, 1);
  assert.deepEqual(await listConversations('codex', f.cwd, { ...options, ownedIds: [id], ownedSince: NaN }), []);
  await codexFile(f, randomUUID(), { timestamp: new Date().toISOString(), cli_version: options.cliVersion });
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...options, exclusiveCliHome: true }), null);
});

test('persistent ownership index is atomic 0600 metadata scoped to account/environment', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = path.join(f.root, 'app-user-data', 'development', 'account-a', 'conversations.json');
  const record = { ...f.options, agent: 'claude', sessionId: id, cwd: f.cwd, prompt: 'SECRET', token: 'SECRET' };
  const records = recordOwnedSession([], record);
  await writeOwnedSessionIndex(filename, records, f.options);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  assert.deepEqual(await readOwnedSessionIndex(filename, f.options), records);
  assert.doesNotMatch(await readFile(filename, 'utf8'), /SECRET|prompt|token/);
  assert.deepEqual(await readOwnedSessionIndex(filename, { ...f.options, accountId: 'account-b' }), []);
  assert.deepEqual(await readOwnedSessionIndex(filename, { ...f.options, environmentId: 'production' }), []);
  await chmod(filename, 0o644);
  assert.deepEqual(await readOwnedSessionIndex(filename, f.options), []);
  await writeOwnedSessionIndex(filename, records, f.options);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await writeOwnedSessionIndex(filename, [{ ...record, agent: 'codex' }], f.options);
  assert.equal((await readOwnedSessionIndex(filename, f.options))[0].agent, 'codex');
});

test('persistent index refuses links, unsafe parents and malformed/oversized JSON', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'index.json');
  await writeFile(filename, 'invalid', { mode: 0o600 });
  assert.deepEqual(await readOwnedSessionIndex(filename, f.options), []);
  await writeFile(filename, 'x'.repeat(512 * 1024 + 1));
  assert.deepEqual(await readOwnedSessionIndex(filename, f.options), []);
  const alias = path.join(f.root, 'alias-index');
  await symlink(filename, alias);
  assert.deepEqual(await readOwnedSessionIndex(alias, f.options), []);
  await assert.rejects(writeOwnedSessionIndex(alias, [], f.options), /Symlink/);
  const hardlink = path.join(f.root, 'linked-index');
  await link(filename, hardlink);
  assert.deepEqual(await readOwnedSessionIndex(hardlink, f.options), []);
  await assert.rejects(writeOwnedSessionIndex(hardlink, [], f.options), /Unsafe/);
  const parent = path.join(f.root, 'alias-dir');
  await symlink(f.cliHome, parent);
  await assert.rejects(writeOwnedSessionIndex(path.join(parent, 'index.json'), [], f.options), /Symlink/);
});

test('lsof capture validates only rollout files opened by the live app CLI identity', async t => {
  const f = await fixture(t), id = randomUUID(), ownedSince = Date.now() - 1000;
  const filename = await codexFile(f, id, { timestamp: new Date().toISOString(), cli_version: '0.162.0-alpha.2' });
  const root = { pid: 42000, ppid: 41999, started: 'Mon Oct 12 00:00:00 2026', executable: '/installed/codex' };
  const processIdentity = new Map([[root.pid, root]]);
  const calls = [];
  const options = { ...f.options, ownedSince, processIdentity, snapshot: () => [root],
    runlsof: async (...args) => { calls.push(args); return { stdout: `p${root.pid}\nf4\nn${filename}\n` }; } };
  const record = await captureOwnedCodexProcessSession(f.cwd, options);
  assert.equal(record.sessionId, id);
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/sbin/lsof', ['-a', '-p', '42000', '-Fn']]);
  assert.ok(calls[0][2].timeout <= 1000);
  assert.equal(calls[0][2].maxBuffer, 65536);
  assert.equal(calls[0][2].shell, false);
  assert.doesNotMatch(JSON.stringify(record), /SECRET|\.jsonl|processIdentity/);
  assert.equal((await validateConversationCandidate('codex', f.cwd, filename, options)).sessionId, id);
  assert.equal(await validateConversationCandidate('codex', f.cwd + '-other', filename, options), null);
  assert.equal(await validateConversationCandidate('codex', f.cwd, filename, { ...options, ownedSince: Date.now() + 10000 }), null);
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, snapshot: () => [{ ...root, started: 'reused PID' }] }), null);
  let snapshots = 0;
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, snapshot: () => ++snapshots === 1 ? [root] : [] }), null);
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, signal: AbortSignal.abort() }), null);
});

test('lsof capture fails closed on foreign PIDs, oversized output, unavailable lsof and ambiguous sessions', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = await codexFile(f, id, { timestamp: new Date().toISOString() });
  const root = { pid: 42000, ppid: 41999, started: 'Mon Oct 12 00:00:00 2026', executable: '/installed/codex' };
  const options = { ...f.options, ownedSince: Date.now() - 1000, processIdentity: new Map([[root.pid, root]]), snapshot: () => [root], timeoutMs: 20 };
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, runlsof: async () => ({ stdout: `p99999\nn${filename}\n` }) }), null);
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, runlsof: async () => ({ stdout: 'x'.repeat(65537) }) }), null);
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, runlsof: async () => { throw Error('unavailable'); } }), null);
  const other = await codexFile(f, randomUUID(), { timestamp: new Date().toISOString() });
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, timeoutMs: 5000,
    runlsof: async () => ({ stdout: `p${root.pid}\nn${filename}\nn${other}\n` }) }), null);
});

test('lsof capture retains only CLI descendants with verified ancestry before and after metadata reads', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = await codexFile(f, id, { timestamp: new Date().toISOString() });
  const root = { pid: 42000, ppid: 41999, started: 'Mon Oct 12 00:00:00 2026', executable: '/installed/codex' };
  const child = { ...root, pid: 42001, ppid: root.pid };
  const options = { ...f.options, ownedSince: Date.now() - 1000, processIdentity: new Map([[root.pid, root]]),
    snapshot: () => [root, child], runlsof: async (executable, args) => ({ stdout: args[2] === String(child.pid) ? `p${child.pid}\nn${filename}\n` : `p${root.pid}\n` }) };
  assert.equal((await captureOwnedCodexProcessSession(f.cwd, options)).sessionId, id);
  let snapshots = 0;
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options,
    snapshot: () => ++snapshots < 4 ? [root, child] : [root] }), null);
});

test('npm Node launcher capture proves ownership of the native Codex child and rejects foreign or detached processes', async t => {
  const f = await fixture(t), id = randomUUID();
  const filename = await codexFile(f, id, { timestamp: new Date().toISOString() });
  const root = { pid: 42000, ppid: 41999, started: 'Mon Oct 12 00:00:00 2026', executable: '/installed/node' };
  const child = { ...root, pid: 42001, ppid: root.pid, executable: '/npm/vendor/codex' };
  const foreign = { ...child, pid: 43000, ppid: 1 };
  const calls = [];
  const options = { ...f.options, ownedSince: Date.now() - 1000, timeoutMs: 5000, processIdentity: new Map([[root.pid, root]]),
    snapshot: () => [root, child, foreign], runlsof: async (_file, args) => {
      calls.push(args[2]); return { stdout: `p${child.pid}\nn${filename}\n` };
    } };
  assert.equal((await captureOwnedCodexProcessSession(f.cwd, options)).sessionId, id);
  assert.deepEqual(calls, [String(child.pid)], 'only the proven native child is queried, not Node or a foreign Codex');
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, snapshot: () => [root, { ...child, ppid: 1 }, foreign] }), null);
  let snapshots = 0;
  assert.equal(await captureOwnedCodexProcessSession(f.cwd, { ...options, snapshot: () => ++snapshots === 1 ? [root, child] : [root, { ...child, started: 'reused PID' }] }), null);
});

test('owned Codex conversations remain resumable after more than 4096 unrelated old history files', async t => {
  const f = await fixture(t), id = randomUUID();
  const sessions = path.join(f.cliHome, 'sessions');
  for (const year of ['2025', '2026']) await mkdir(path.join(sessions, year, '01', '01'), { recursive: true });
  const directory = await opendir(sessions);
  const firstYear = (await directory.read()).name;
  await directory.close();
  const old = path.join(sessions, firstYear, '01', '01');
  for (let offset = 0; offset < 4100; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 4100 - offset) }, (_, index) => writeFile(path.join(old, `old-${offset + index}.jsonl`), 'UNOWNED HISTORY')));
  }
  const recentYear = firstYear === '2025' ? '2026' : '2025';
  const filename = path.join(sessions, recentYear, '01', '01', `rollout-recent-${id}.jsonl`);
  await writeFile(filename, JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.cwd, source: 'cli' } }) + '\n');
  const options = { ...f.options, ownedIds: [id] };
  assert.equal((await listConversations('codex', f.cwd, options))[0]?.sessionId, id);
  assert.equal(await validateResumeSessionId('codex', f.cwd, id, options), id);
  assert.equal(await captureOwnedCodexSession(f.cwd, { ...f.options, exclusiveCliHome: true, ownedSince: 1, cliVersion: 'fixture' }), null, 'unscoped discovery still fails closed at its scan limit');
});
