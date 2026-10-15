import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWorkFolder, folderFailure, agentLaunchFailure } from '../desktop/electron/launch-preflight.mjs';

test('work folders validate existence, type and access without creating files or granting permissions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'launch-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const linked = path.join(root, 'linked');
  await symlink(folder, linked);
  assert.equal(await checkWorkFolder(folder), await checkWorkFolder(linked));
  for (const invalid of ['', '.', 'bad\0path', null]) await assert.rejects(checkWorkFolder(invalid), /フォルダを選択/);
  await assert.rejects(checkWorkFolder(path.join(root, 'missing')), /見つかりません.*選び直して/);
  await writeFile(path.join(root, 'file.txt'), 'unchanged');
  await assert.rejects(checkWorkFolder(path.join(root, 'file.txt')), /フォルダが見つかりません/);
  await chmod(folder, 0o500);
  try {
    if (process.getuid?.() !== 0) await assert.rejects(checkWorkFolder(folder), /アクセスできません.*選び直して/);
    await checkWorkFolder(folder, { writable: false });
  } finally { await chmod(folder, 0o700); }
  await chmod(folder, 0);
  try {
    if (process.getuid?.() !== 0) await assert.rejects(checkWorkFolder(folder, { writable: false }), /アクセスできません/);
  } finally { await chmod(folder, 0o700); }
});

test('launch errors explain recovery without leaking child output or raw system paths', () => {
  for (const code of ['EACCES', 'EPERM']) {
    assert.match(folderFailure({ code }).message, /アクセスできません/);
    assert.match(agentLaunchFailure('codex', { code, message: 'SECRET' }).message, /Codex.*実行権限/);
  }
  assert.match(agentLaunchFailure('claude', { code: 'ENOENT' }).message, /Claude Code.*診断を更新/);
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN']) {
    assert.doesNotMatch(folderFailure({ code, message: '/private/SECRET' }).message, /SECRET|EACCES|EPERM/);
    assert.doesNotMatch(agentLaunchFailure('codex', { code, stderr: 'SECRET' }).message, /SECRET/);
  }
});
