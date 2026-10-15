import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function folderFailure(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) {
    return new Error('作業フォルダにアクセスできません。読み書きできるフォルダを選び直してください。必要な場合だけ、システム設定の「プライバシーとセキュリティ」でこのアプリの許可を確認してください。');
  }
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
    return new Error('作業フォルダが見つかりません。移動・削除されていないか確認し、フォルダを選び直してください。');
  }
  return new Error('作業フォルダを確認できません。利用できるフォルダを選び直してください。');
}

export async function checkWorkFolder(cwd, { writable = true } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 4096) {
    throw new Error('作業フォルダを選択してください。');
  }
  try {
    const folder = await realpath(cwd);
    if (!(await stat(folder)).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    await access(folder, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
    return folder;
  } catch (error) { throw folderFailure(error); }
}

export function agentLaunchFailure(agent, error) {
  const name = agent === 'claude' ? 'Claude Code' : 'Codex';
  if (error?.code === 'ENOENT') return new Error(`${name}が見つかりません。インストール後に「診断を更新」で再確認してください。`);
  if (['EACCES', 'EPERM'].includes(error?.code)) return new Error(`${name}の起動が許可されていません。インストール先と実行権限を確認してください。アプリから権限を自動変更することはありません。`);
  return new Error(`${name}を起動できませんでした。エージェント診断を確認してから再試行してください。`);
}
