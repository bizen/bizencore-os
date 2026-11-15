import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const names = { claude: 'Claude Code', codex: 'Codex' };

function checkAgent(agent) {
  if (!Object.hasOwn(names, agent)) throw new Error('Unsupported agent');
}

// Main-process-only options. Resolve from the same environment used at launch;
// renderer-provided executable paths, environments or runners are never trusted.
export async function resolveAgentExecutable(agent, options = {}) {
  checkAgent(agent);
  const env = options.env ?? process.env;
  const userHome = options.homeDir ?? homedir();
  const candidates = options.executable !== undefined ? [options.executable] : [
    ...(env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).slice(0, 64).map(dir => path.join(dir, agent)),
    path.join(userHome, '.local', 'bin', agent), path.join(userHome, '.bun', 'bin', agent),
    path.join('/opt/homebrew/bin', agent), path.join('/usr/local/bin', agent),
    ...(agent === 'codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'] : []),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Missing/non-executable candidates are expected on first setup. */ }
  }
  return null;
}

/**
 * { agent, name, executable, version, status, authStatus: 'unchecked' }.
 * Only --version runs. No install, login, doctor, MCP commands or model request.
 * status is ready | missing | timeout | output-limit | invalid-version | failed.
 * No raw stdout/stderr/error message is returned (may contain local secrets).
 */
export async function diagnoseAgent(agent, options = {}) {
  checkAgent(agent);
  const executable = await resolveAgentExecutable(agent, options);
  const report = { agent, name: names[agent], executable, version: null, status: 'missing', authStatus: 'unchecked' };
  if (!executable) return report;
  const timeout = Number.isInteger(options.timeoutMs) ? Math.max(100, Math.min(5000, options.timeoutMs)) : 3000;
  try {
    const { stdout } = await (options.run ?? runFile)(executable, ['--version'], {
      env: options.env ?? process.env, cwd: options.cwd ?? homedir(), timeout, maxBuffer: 4096,
      encoding: 'utf8', windowsHide: true, shell: false, killSignal: 'SIGKILL',
    });
    const match = (typeof stdout === 'string' && stdout.length <= 4096) &&
      /^(?:codex-cli\s+)?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,64})?)(?:\s+\(Claude Code\))?\s*$/.exec(stdout);
    if (!match) return { ...report, status: 'invalid-version' };
    return { ...report, version: match[1], status: 'ready' };
  } catch (error) {
    const status = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' :
      error?.killed || error?.signal === 'SIGKILL' ? 'timeout' : 'failed';
    return { ...report, status };
  }
}

export async function diagnoseAgents(options = {}) {
  return Promise.all(['claude', 'codex'].map(agent => diagnoseAgent(agent, options)));
}
