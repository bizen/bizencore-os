import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseAgent, diagnoseAgents, resolveAgentExecutable } from '../desktop/electron/agent-diagnostics.mjs';

async function fixture(t, body = '') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-diagnostics-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\n${body}\n`);
  await chmod(executable, 0o700);
  return { root, executable };
}

test('diagnostics resolve the launch executable and run only bounded shell-free --version', async t => {
  const f = await fixture(t);
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: 'codex-cli 0.162.0-alpha.2\n' }; };
  const report = await diagnoseAgent('codex', { executable: f.executable, cwd: f.root, run, timeoutMs: 999999 });
  assert.deepEqual(report, { agent: 'codex', name: 'Codex', executable: f.executable, version: '0.162.0-alpha.2', status: 'ready', authStatus: 'unchecked' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [f.executable, ['--version']]);
  assert.equal(calls[0][2].timeout, 5000);
  assert.equal(calls[0][2].maxBuffer, 4096);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].killSignal, 'SIGKILL');
  const claude = await diagnoseAgent('claude', { executable: f.executable, run: async () => ({ stdout: '2.1.296 (Claude Code)\n' }) });
  assert.equal(claude.version, '2.1.296');
});

test('missing, non executable, directory and relative paths do not execute', async t => {
  const f = await fixture(t);
  const run = () => { throw new Error('Must not run'); };
  for (const executable of [path.join(f.root, 'missing'), f.root, './codex', 'bad\0path']) {
    assert.equal((await diagnoseAgent('codex', { executable, run })).status, 'missing');
  }
  await chmod(f.executable, 0o600);
  assert.equal(await resolveAgentExecutable('codex', { executable: f.executable }), null);
  await assert.rejects(diagnoseAgent('shell'), /Unsupported agent/);
});

test('resolution matches PATH precedence and ignores relative PATH components', async t => {
  const f = await fixture(t);
  const local = path.join(f.root, '.local', 'bin');
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, 'codex'), 'ignored');
  await chmod(path.join(local, 'codex'), 0o700);
  assert.equal(await resolveAgentExecutable('codex', { homeDir: f.root, env: { PATH: `.:${f.root}` } }), f.executable);
});

test('diagnostics redact malformed version output and command failure details', async t => {
  const f = await fixture(t);
  for (const stdout of ['SECRET TOKEN\n2.1.296', '2.1.296\nSECRET', '\x1b[31m2.1.296', 'x'.repeat(4097)]) {
    const report = await diagnoseAgent('claude', { executable: f.executable, run: async () => ({ stdout }) });
    assert.equal(report.status, 'invalid-version');
    assert.equal(report.version, null);
    assert.doesNotMatch(JSON.stringify(report), /SECRET|TOKEN/);
  }
  for (const [error, status] of [[{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output-limit'], [{ killed: true }, 'timeout'], [{ code: 'ENOENT' }, 'failed']]) {
    const report = await diagnoseAgent('codex', { executable: f.executable, run: async () => { throw { ...error, stderr: 'SECRET', message: 'SECRET' }; } });
    assert.equal(report.status, status);
    assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  }
});

test('real execFile kills a hanging probe and bounds stdout/stderr without touching native agents', async t => {
  const hanging = await fixture(t, 'setInterval(() => {}, 1000);');
  assert.equal((await diagnoseAgent('codex', { executable: hanging.executable, timeoutMs: 100 })).status, 'timeout');
  const loud = await fixture(t, 'process.stderr.write("SECRET".repeat(10000));');
  assert.equal((await diagnoseAgent('codex', { executable: loud.executable })).status, 'output-limit');
  const good = await fixture(t, 'console.log("codex-cli 0.162.0-alpha.2");');
  assert.equal((await diagnoseAgent('codex', { executable: good.executable })).status, 'ready');
});

test('combined first-setup diagnostics return both agents without auth mutation', async t => {
  const f = await fixture(t);
  const rows = await diagnoseAgents({ executable: f.executable, run: async () => ({ stdout: '1.2.3\n' }) });
  assert.deepEqual(rows.map(row => row.agent), ['claude', 'codex']);
  assert.ok(rows.every(row => row.authStatus === 'unchecked' && row.status === 'ready'));
});
