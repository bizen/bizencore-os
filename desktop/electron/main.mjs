import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, net, Notification, powerMonitor, protocol, screen, shell } from 'electron';
import Store from 'electron-store';
import { createClerkBridge } from '@clerk/electron';
import * as pty from 'node-pty';
import { access, realpath, stat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccessState, checkedGrant, convexEndpoint, paneId, terminalSize, tokenClaims, trustedRenderer as acceptsRenderer } from './policy.mjs';
import { checkedRuntimeConfig } from './release-config.mjs';
import { createAuthStorage } from './auth-storage.mjs';
import { agentLaunchArgs, allocateAgentSession } from './agent-launch.mjs';
import { diagnoseAgents } from './agent-diagnostics.mjs';
import { createConversationRegistry } from './conversation-registry.mjs';
import { captureOwnedCodexProcessSession } from './conversations.mjs';
import { attachDesktopLifecycle, restoreWindowBounds } from './lifecycle.mjs';
import { createDesktopNotifications, externalWebUrl } from './notifications.mjs';
import { installMacAuthentication } from './mac-auth.mjs';
import { createDesktopMcp } from './dev-mcp.mjs';
import { isolatedMcpLaunch } from './mcp-launch.mjs';
import { TerminalOutput } from './terminal-output.mjs';
import { installRendererRecovery } from './renderer-recovery.mjs';
import { createProcessGuard } from './process-guard.mjs';
import { processSnapshot, retainProcessTree, stopProcessTree } from './process-tree.mjs';
import { blockValidationRequest, createRuntimeValidation, validationEnabled } from './runtime-validation.mjs';
import { checkWorkRequest, createTaskOperationGuard, runTaskProcess, taskTreeIds } from './task-runner.mjs';
import { checkOrchestration, orchestrationPrompt, reviewOrchestration } from './orchestration.mjs';
import { createShutdownBarrier } from './session-shutdown.mjs';
import { createDesktopUpdateCheck, DESKTOP_DOWNLOAD_URL } from './desktop-update.mjs';
import { desktopContentPolicy } from './content-policy.mjs';

// Runtime config contains only public Vite values, never a Clerk secret key.
const root = app.getAppPath();
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const profile = checkedRuntimeConfig(config);
const checkDesktopUpdate = createDesktopUpdateCheck({ channel: profile.channel, arch: config.arch,
  version: config.version, fetchRelease: (url, options) => net.fetch(url, options) });
const scheme = profile.scheme;
const rendererOrigin = `${scheme}://renderer`;
const trustedRenderer = (url, development = false) => acceptsRenderer(url, development, profile.channel);
const endpoint = convexEndpoint(config.convexUrl);
if (profile.channel === 'production' && process.argv.includes('--dev')) throw new Error('Production cannot use the preview development server');
const dev = profile.channel === 'preview' && !app.isPackaged && process.argv.includes('--dev');
app.setName(profile.name);
app.setPath('userData', path.join(app.getPath('appData'), profile.userData));
const clerk = createClerkBridge({
  renderer: { scheme, host: 'renderer' },
  storage: createAuthStorage(app.getPath('userData'), config.clerkHost),
});
let window;
const sessions = new Map();
const pendingStarts = new Map();
const orchestrations = new Map();
const stopping = new Set();
const shutdowns = createShutdownBarrier();
let processGuard;
const accessState = new AccessState();
let sessionToken;
let desktopMcp;
let lifecycle;
let taskOperation;
const windowPreferences = new Store({ cwd: app.getPath('userData'), name: 'window-preferences' });
const conversations = createConversationRegistry({ userData: app.getPath('userData'), environmentId: config.convexUrl,
  getAccess: () => ({ ...accessState.require(), generation: accessState.generation }) });
const notifications = createDesktopNotifications({ Notification,
  isFocused: () => Boolean(window && !window.isDestroyed() && window.isFocused()),
  focusPane: id => {
    try { accessState.require(); } catch { return; }
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); send('bizencore:focus-pane', id);
  },
});
const mcpSupported = config.convexUrl === profile.convexUrl && config.clerkHost === profile.clerkHost;
const validation = validationEnabled(process.argv, config) ? createRuntimeValidation() : null;
const send = (channel, ...args) => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, ...args);
};
function stopOwnedSession(id, session) {
  return shutdowns.run(id, async () => {
    stopping.add(session.terminal.pid);
    try {
      const owned = retainProcessTree(processSnapshot(), session.processIdentity);
      try { await processGuard.stop(session.terminal.pid); }
      catch (failure) {
        if (!owned.size) throw failure;
      }
      // A failed registration may make the guard treat this PID as unknown.
      // Independently verify the locally proven process identities as well.
      if (retainProcessTree(processSnapshot(), owned).size) {
        stopProcessTree(owned);
        const deadline = Date.now() + 2000;
        while (retainProcessTree(processSnapshot(), owned).size) {
          if (Date.now() >= deadline) throw Error('エージェントの停止を確認できませんでした');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    } finally { stopping.delete(session.terminal.pid); }
  });
}
function stopSession(id) {
  orchestrations.get(id)?.controller.abort();
  orchestrations.delete(id);
  const pending = pendingStarts.get(id);
  if (pending) {
    pending.controller.abort();
    if (pending.token) desktopMcp?.revoke(pending.token);
    if (!sessions.has(id) && !pending.exitSent) { pending.exitSent = true; send('bizencore:agent-event', id, { kind: 'exit', code: null }); }
  }
  const session = sessions.get(id);
  if (session) {
    clearInterval(session.captureTimer); sessions.delete(id);
    if (session.mcpToken) desktopMcp?.revoke(session.mcpToken);
    session.data.dispose(); session.exit.dispose(); session.output.dispose();
    void stopOwnedSession(id, session).catch(() => {});
    send('bizencore:agent-event', id, { kind: 'exit', code: null });
  }
  const stopped = Promise.all([pending?.finished, shutdowns.get(id)]);
  void stopped.catch(() => {});
  return stopped;
}
function lock() {
  validation?.log('lock', { running: sessions.size, pending: pendingStarts.size, generation: accessState.generation });
  sessionToken = undefined;
  notifications.clear();
  desktopMcp?.revokeAll();
  for (const binding of orchestrations.values()) binding.controller.abort();
  orchestrations.clear();
  accessState.revoke();
  taskOperation?.controller.abort();
  for (const id of pendingStarts.keys()) stopSession(id);
  for (const id of sessions.keys()) stopSession(id);
}
function sender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame || !trustedRenderer(event.senderFrame?.url, dev)) throw new Error('Invalid desktop window');
}
const nativeAuth = process.platform === 'darwin' ? installMacAuthentication({
  ipcMain, clerkHost: config.clerkHost, callbackScheme: scheme, checkSender: sender,
  executable: path.join(app.isPackaged ? process.resourcesPath : root, 'auth-session.app/Contents/MacOS/auth-session'),
  focusWindow: () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); } },
}) : null;
function sameAccess(event, generation) {
  sender(event); accessState.require();
  if (generation !== accessState.generation) throw new Error('サインインを確認してください');
}
function command(name, handler, authenticated = true) {
  ipcMain.handle(`bizencore:${name}`, (event, ...args) => {
    sender(event);
    if (authenticated) accessState.require();
    return handler(event, ...args);
  });
}
async function agentPath(agent) {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unsupported agent');
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(homedir(), '.local/bin'), path.join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const candidates = dirs.filter(Boolean).map(dir => path.join(dir, agent));
  if (agent === 'codex') candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try next install location. */ }
  }
  return null;
}
async function stopAgentsAndWait() {
  lock();
  const deadline = Date.now() + 10000;
  while (stopping.size || taskOperation || pendingStarts.size) {
    if (Date.now() >= deadline) throw new Error('エージェントの停止を確認できませんでした');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await shutdowns.wait();
}
async function captureConversation(id, session) {
  if (sessions.get(id) !== session || session.ended || session.captured || session.capturing) return;
  session.capturing = true;
  try {
    session.conversationScope.check();
    const record = await captureOwnedCodexProcessSession(session.conversationScope.cwd, {
      ...session.conversationScope, processIdentity: session.processIdentity, ownedSince: session.ownedSince,
    });
    if (!record) return;
    await conversations.enroll(record, () => {
      if (sessions.get(id) !== session || session.ended) throw new Error('Conversation process ended');
    });
    session.captured = true;
    clearInterval(session.captureTimer);
  } catch { /* Missing, ambiguous or stale CLI metadata never grants resume access. */ }
  finally { session.capturing = false; }
}
command('authorize', async (event, token) => {
  const generation = accessState.generation;
  try {
    const claims = tokenClaims(token);
    const response = await net.fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'accountDeletion:status', args: {}, format: 'json' }),
    });
    if (!response.ok || !response.body) throw new Error('Authentication rejected');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) throw new Error('Authentication response too large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const grant = checkedGrant(JSON.parse(Buffer.concat(chunks).toString()), claims);
    sender(event);
    accessState.install(generation, grant);
    sessionToken = token;
    validation?.log('authorized', { expiresAt: grant.expiresAt * 1000, generation });
    return grant;
  } catch {
    if (generation === accessState.generation) lock();
    throw new Error('ログインを確認できませんでした');
  }
}, false);
command('lock', () => lock(), false);
command('check-update', async event => {
  const generation = accessState.generation;
  const release = await checkDesktopUpdate();
  sameAccess(event, generation);
  return release;
});
command('open-update', async () => {
  await shell.openExternal(DESKTOP_DOWNLOAD_URL);
});
command('agents', async event => {
  const generation = accessState.generation;
  const agents = [];
  for (const [id, name] of [['claude', 'Claude Code'], ['codex', 'Codex']]) agents.push({ id, name, path: await agentPath(id) });
  sameAccess(event, generation);
  return agents;
});
command('agent-diagnostics', async event => {
  const generation = accessState.generation;
  const result = await diagnoseAgents();
  sameAccess(event, generation);
  const problems = { missing: '未インストール', timeout: 'バージョン確認がタイムアウトしました', 'output-limit': 'バージョン確認の応答が大きすぎます', 'invalid-version': 'バージョンを確認できません', failed: '起動できません' };
  return result.map(agent => ({ id: agent.agent, name: agent.name, path: agent.executable, version: agent.version,
    ...(agent.status === 'ready' ? {} : { problem: problems[agent.status] ?? '確認できません' }) }));
});
command('conversations', async (event, agent, cwd) => {
  const generation = accessState.generation;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Invalid work folder');
  const folder = await realpath(cwd);
  sameAccess(event, generation);
  const result = await conversations.list(agent, folder);
  sameAccess(event, generation);
  return result;
});
command('open-external', (_event, url) => shell.openExternal(externalWebUrl(url)));
command('notify', (_event, value) => notifications.notify(value));
command('folder', async event => {
  const generation = accessState.generation;
  const result = await dialog.showOpenDialog(window, { title: '作業フォルダを選択', properties: ['openDirectory'] });
  sameAccess(event, generation);
  return result.canceled ? null : result.filePaths[0] ?? null;
});
command('task-run', async (event, input) => {
  const request = checkWorkRequest(input);
  if (request.mode !== 'decompose') throw Error('オーケストレーションは通常CLIペインから開始してください');
  paneId(request.id);
  if (taskOperation || sessions.size || pendingStarts.size || stopping.size || shutdowns.size || !processGuard || !desktopMcp) throw Error('他のエージェントを停止してから実行してください');
  const generation = accessState.generation;
  const launchGuard = lifecycle.beginAgentLaunch();
  const operation = { id: request.id, controller: new AbortController() };
  taskOperation = operation;
  let capability;
  const { check, markStarted } = createTaskOperationGuard({
    validateAccess: () => sameAccess(event, generation), launchGuard, signal: operation.controller.signal,
  });
  try {
    if (!path.isAbsolute(request.cwd)) throw Error('作業フォルダを選択してください');
    const folder = await realpath(request.cwd);
    if (!(await stat(folder)).isDirectory() || folder === path.parse(folder).root || folder === homedir()) throw Error('専用の作業フォルダを選択してください');
    const detail = await desktopMcp.readTask(request.taskId, operation.controller.signal);
    check();
    if (detail.task.done) throw Error('このタスクは既に完了しています');
    const executable = await agentPath(request.agent);
    if (!executable) throw Error('エージェントが見つかりません');
    capability = desktopMcp.issue(request.id, request.agent, { taskIds: taskTreeIds(detail.task), readOnly: request.mode === 'decompose' });
    operation.controller.signal.addEventListener('abort', () => desktopMcp.revoke(capability.token), { once: true });
    const isolated = await isolatedMcpLaunch(request.agent, executable, folder, {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined,
      PATH: `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
    }, capability, undefined, operation.controller.signal, request.mode);
    check();
    let ownedIdentity;
    const stopWorker = async pid => {
      try { await processGuard.stop(pid); }
      catch (failure) { if (!ownedIdentity) throw failure; }
      finally { if (ownedIdentity) stopProcessTree(retainProcessTree(processSnapshot(), ownedIdentity)); }
    };
    const result = await runTaskProcess({ ...request, cwd: folder, executable, args: isolated.args, env: isolated.env, signal: operation.controller.signal,
      onSpawn: async pid => {
        const rows = processSnapshot();
        const root = rows.find(row => row.pid === pid && row.ppid === process.pid);
        if (!root) throw Error('Agent process ownership could not be verified');
        ownedIdentity = retainProcessTree(rows, new Map([[root.pid, root]]));
        operation.pid = pid; await processGuard.register(pid); markStarted();
      }, stopProcess: stopWorker,
    });
    check();
    const latest = await desktopMcp.readTask(request.taskId, operation.controller.signal);
    check();
    if (request.mode === 'decompose' && JSON.stringify(detail.task) !== JSON.stringify(latest.task)) throw Error('タスクが変更されました。最新の内容で再提案してください');
    return { result, taskDone: latest.task.done === true, sourceTask: latest.task };
  } finally {
    if (capability) desktopMcp.revoke(capability.token);
    if (taskOperation === operation) taskOperation = undefined;
  }
});
command('task-stop', (_event, id) => {
  paneId(id);
  if (taskOperation?.id === id) taskOperation.controller.abort();
});
command('task-review', async (event, id) => {
  paneId(id);
  const binding = orchestrations.get(id);
  if (!binding || !desktopMcp) throw Error('オーケストレーションの対象を確認できません');
  sameAccess(event, binding.generation);
  const latest = await desktopMcp.readTask(binding.taskId, binding.controller.signal);
  sameAccess(event, binding.generation);
  if (orchestrations.get(id) !== binding || latest.task.id !== binding.taskId) throw Error('実行対象が変更されました');
  return reviewOrchestration(latest.task, binding.taskIds);
});
command('start', async (event, args) => {
  if (taskOperation) throw Error('オーケストレーション・分解を停止してから起動してください');
  if (shutdowns.size) throw Error('エージェントの停止完了を確認してから起動してください');
  const generation = accessState.generation;
  const launchGuard = lifecycle.beginAgentLaunch();
  const { id, agent, cwd, cols, rows, handoff, resumeSessionId, orchestration } = args ?? {};
  const work = orchestration === undefined ? undefined : checkOrchestration(orchestration);
  if (work && (handoff !== undefined || resumeSessionId !== undefined)) throw Error('Invalid orchestration handoff');
  if (work && (sessions.size || pendingStarts.size || stopping.size)) throw Error('他のエージェントを停止してから実行してください');
  if (!work && ([...sessions.values()].some(session => session.orchestration) || [...pendingStarts.values()].some(pending => pending.orchestration))) throw Error('オーケストレーションを停止してから起動してください');
  let launchArgs = agentLaunchArgs(agent, handoff, resumeSessionId);
  paneId(id); terminalSize(cols, rows);
  if (!processGuard || sessions.has(id) || pendingStarts.has(id) || new Set([...sessions.keys(), ...pendingStarts.keys()]).size + stopping.size >= 8) throw new Error('Pane already running or eight-agent limit reached');
  let finishLaunch;
  const pending = { orchestration: Boolean(work), controller: new AbortController(), finished: new Promise(resolve => { finishLaunch = resolve; }) };
  pendingStarts.set(id, pending);
  const checkLaunch = () => {
    sameAccess(event, generation); launchGuard();
    if (shutdowns.hasOther(id)) throw Error('エージェントの停止完了を確認してから起動してください');
    if (pending.controller.signal.aborted || pendingStarts.get(id) !== pending) throw Error('エージェントの起動をキャンセルしました');
  };
  try {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Invalid work folder');
  const folder = await realpath(cwd);
  if (!(await stat(folder)).isDirectory()) throw new Error('作業フォルダを選択してください');
  let workIds;
  if (work) {
    if (folder === path.parse(folder).root || folder === homedir()) throw Error('専用の作業フォルダを選択してください');
    if (!desktopMcp) throw Error('MCPが利用できません');
    checkLaunch();
    const latest = await desktopMcp.readTask(work.taskId, pending.controller.signal);
    checkLaunch();
    if (latest.task.done) throw Error('このタスクは既に完了しています');
    workIds = taskTreeIds(latest.task);
    launchArgs = agentLaunchArgs(agent, { taskId: work.taskId, mode: 'mcp', intent: 'execute', prompt: orchestrationPrompt(work.taskId, work.reply) });
  }
  checkLaunch();
  const conversationScope = conversations.context(agent, folder);
  let allocated;
  if (resumeSessionId !== undefined) {
    await conversations.validate(agent, folder, resumeSessionId);
    checkLaunch();
  } else {
    allocated = allocateAgentSession(agent);
    if (allocated.sessionId) {
      await conversations.enroll({ ...conversationScope, sessionId: allocated.sessionId }, checkLaunch);
      checkLaunch();
      launchArgs = [...allocated.args, ...launchArgs];
    }
  }
  const executable = await agentPath(agent);
  checkLaunch();
  if (!executable) throw new Error('エージェントが見つかりません');
  let capability;
  let childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    PATH: `${homedir()}/.local/bin:${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` };
  // Isolate every native agent launch, even without a task handoff.
  if (!mcpSupported || !desktopMcp) throw new Error('MCPが利用できません');
  try {
    capability = desktopMcp.issue(id, agent, work ? { taskIds: workIds, readOnly: false } : undefined);
    pending.token = capability.token;
    const isolated = await isolatedMcpLaunch(agent, executable, folder, childEnv, capability, undefined, pending.controller.signal);
    childEnv = isolated.env;
    launchArgs = [...isolated.args, ...launchArgs];
    checkLaunch();
  } catch (error) { if (capability) desktopMcp.revoke(capability.token); throw error; }
  if (sessions.has(id) || sessions.size >= 8) { desktopMcp.revoke(capability.token); throw new Error('Pane already running or eight-agent limit reached'); }
  let terminal;
  checkLaunch();
  const ownedSince = Date.now();
  try { terminal = pty.spawn(executable, launchArgs, {
    name: 'xterm-256color', cols, rows, cwd: folder, encoding: null,
    env: childEnv,
  }); } catch (error) { desktopMcp.revoke(capability.token); throw error; }
  let processIdentity;
  try {
    const rows = processSnapshot();
    const root = rows.find(row => row.pid === terminal.pid && row.ppid === process.pid);
    if (!root) throw Error('Agent process ownership could not be verified');
    processIdentity = retainProcessTree(rows, new Map([[root.pid, root]]));
  } catch (error) {
    desktopMcp.revoke(capability.token);
    if (processIdentity) stopProcessTree(processIdentity);
    else try { terminal.kill('SIGKILL'); } catch { /* Already exited. */ }
    throw error;
  }
  const session = { terminal, processIdentity, conversationScope, ownedSince, mcpToken: capability.token, cols, rows, ended: false, streamId: randomUUID(), orchestration: Boolean(work) };
  session.output = new TerminalOutput({
    send: (sequence, bytes) => {
      if (sessions.get(id) !== session) return;
      if (accessState.expired()) { lock(); send('bizencore:access-expired'); return; }
      send('bizencore:agent-event', id, { kind: 'data', streamId: session.streamId, sequence, bytes: Array.from(bytes) });
    },
    pause: () => { if (!session.ended) terminal.pause(); },
    resume: () => { if (!session.ended) terminal.resume(); },
  });
  session.data = terminal.onData(bytes => {
    if (sessions.get(id) !== session) return;
    if (accessState.expired()) { lock(); send('bizencore:access-expired'); return; }
    session.output.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  });
  session.exit = terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== session) return;
    session.ended = true;
    clearInterval(session.captureTimer);
    session.data.dispose(); session.exit.dispose();
    desktopMcp.revoke(session.mcpToken);
    const stopped = stopOwnedSession(id, session);
    session.output.finish(() => {
      void stopped.then(() => {
        if (sessions.get(id) !== session) return;
        sessions.delete(id);
        send('bizencore:agent-event', id, { kind: 'exit', code: exitCode });
      }).catch(() => {
        if (sessions.get(id) !== session) return;
        sessions.delete(id);
        send('bizencore:agent-event', id, { kind: 'exit', code: null });
      });
    });
  });
  sessions.set(id, session);
  try {
    await processGuard.register(terminal.pid);
    checkLaunch();
    if (work) orchestrations.set(id, { taskId: work.taskId, taskIds: workIds, generation, controller: new AbortController() });
  } catch (error) {
    if (sessions.get(id) === session) stopSession(id);
    else void processGuard.stop(terminal.pid).catch(() => {});
    throw error;
  }
  if (agent === 'codex' && !resumeSessionId) {
    session.captureTimer = setInterval(() => { void captureConversation(id, session); }, 5000);
    session.captureTimer.unref();
    void captureConversation(id, session);
  }
  return terminal.pid;
  } finally { if (pendingStarts.get(id) === pending) pendingStarts.delete(id); finishLaunch(); }
});
command('write', (_event, id, data) => {
  paneId(id);
  if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error('Invalid terminal input');
  const session = sessions.get(id);
  if (session && !session.ended) session.terminal.write(data);
});
command('resize', (_event, id, cols, rows) => {
  paneId(id); terminalSize(cols, rows);
  const session = sessions.get(id);
  if (!session || session.ended || (session.cols === cols && session.rows === rows)) return;
  session.terminal.resize(cols, rows);
  session.cols = cols; session.rows = rows;
});
command('ack-output', (_event, id, streamId, sequence) => {
  paneId(id); paneId(streamId);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid output acknowledgement');
  const session = sessions.get(id);
  if (session?.streamId === streamId) session.output.acknowledge(sequence);
});
command('stop', (_event, id) => { paneId(id); return stopSession(id); }, false);
if (validation) {
  command('validation-state', () => validation.state(), false);
  command('validation-sample', (_event, value) => validation.sample(value));
}

function validationMenu() {
  if (!validation) return;
  let capability;
  const probe = async () => {
    let authorized = false;
    try { accessState.require(); authorized = true; } catch { /* Expected after expiry. */ }
    let staleStatus = null;
    if (capability) {
      const response = await fetch(capability.url, {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${capability.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'runtime-validation', version: '1' } } }),
      });
      staleStatus = response.status;
      await response.body?.cancel();
    }
    validation.log('access-probe', { authorized, staleStatus, running: sessions.size, pending: pendingStarts.size, stopping: stopping.size });
  };
  const base = Menu.getApplicationMenu();
  const template = base ? base.items.map(item => item) : [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
  template.push({ label: '検証', submenu: [
    { label: '通常負荷の計測', click: () => validation.phase('baseline') },
    { label: '高負荷の計測', click: () => validation.phase('load') },
    { label: 'このアプリをオフラインにする', type: 'checkbox', click: item => {
      const session = window.webContents.session;
      validation.offline(item.checked);
      if (item.checked) { session.enableNetworkEmulation({ offline: true }); void session.closeAllConnections(); }
      else session.disableNetworkEmulation();
    } },
    { label: '認証更新を止めて実際の期限切れを待つ', type: 'checkbox', click: item => validation.pause(item.checked) },
    { label: '現在のMCP権限を検証用に保持', click: () => {
      try { if (capability) desktopMcp.revoke(capability.token); capability = desktopMcp.issue(randomUUID(), 'codex'); validation.log('capability-held'); }
      catch { validation.log('capability-unavailable'); }
    } },
    { label: '認証と旧MCP権限を確認', click: () => void probe().catch(() => validation.log('probe-failed')) },
    { label: '再読み込み', click: () => window.webContents.reload() },
    { label: '計測レポートの保存先', click: () => void dialog.showMessageBox(window, { message: validation.file, buttons: ['OK'] }) },
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function csp() {
  return desktopContentPolicy(config, dev);
}
function applicationMenu() {
  app.setAboutPanelOptions({ applicationName: profile.name, applicationVersion: config.version });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: profile.name, submenu: [
      { role: 'about' },
      { label: '手動更新の案内', click: () => void dialog.showMessageBox(window, {
        type: 'info', title: '手動更新', message: `${profile.name} ${config.version}`,
        detail: '更新する際は、作業を終えるかエージェントを停止し、アプリを完全に終了してください。新しいZIPのチェックサムを確認し、旧版をバックアップしてから同じ場所へ入れ替えます。\n\nアカウントの保存データは削除しません。再起動したペインは未起動のままです。問題があれば、終了後に旧版へ戻してください。\n\nAppleの公証は受けていません。更新版でもmacOSが個別の起動許可を求める場合があります。自動インストールや作業中の強制終了は行いません。',
        buttons: ['閉じる', '配布ページを開く'], noLink: true,
      }).then(result => { if (result.response === 1) return shell.openExternal(DESKTOP_DOWNLOAD_URL); }).catch(() => {}) },
      { label: '第三者ライセンス', click: () => shell.showItemInFolder(path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')) },
      { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}
async function createWindow() {
  const rendererRoot = path.join(root, 'renderer');
  protocol.handle(scheme, async request => {
    if (!trustedRenderer(request.url)) return new Response('Not found', { status: 404 });
    let resolved;
    try { resolved = path.resolve(rendererRoot, `.${decodeURIComponent(new URL(request.url).pathname)}`); }
    catch { return new Response('Bad request', { status: 400 }); }
    const relative = path.relative(rendererRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    const file = path.extname(resolved) ? resolved : path.join(rendererRoot, 'index.html');
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp());
    return new Response(response.body, { status: response.status, headers });
  });
  window = new BrowserWindow({
    ...restoreWindowBounds(windowPreferences.get('bounds'), screen.getAllDisplays().map(display => display.workArea)), minWidth: 900, minHeight: 600,
    title: profile.name, backgroundColor: '#0a0b0c',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } } : {}),
    webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      additionalArguments: validation ? ['--bizencore-validation'] : [] },
  });
  window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(profile.name); });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedRenderer(url, dev)) {
      event.preventDefault();
      if (url.startsWith('https://')) { try { void shell.openExternal(externalWebUrl(url)).catch(() => {}); } catch { /* Invalid external link. */ } }
    }
  });
  window.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
    if (mainFrame && !trustedRenderer(url, dev)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) { try { void shell.openExternal(externalWebUrl(url)).catch(() => {}); } catch { /* Invalid external link. */ } }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { nativeAuth?.cancel(); lock(); } });
  installRendererRecovery({ window, cancelAuthentication: () => nativeAuth?.cancel(), revokeAccess: lock,
    showMessageBox: (...args) => dialog.showMessageBox(...args), quit: () => lifecycle.requestQuit() });
  lifecycle.attachWindow(window);
  const saveBounds = () => { if (!window.isDestroyed()) windowPreferences.set('bounds', window.getNormalBounds()); };
  let boundsTimer;
  const queueBounds = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 200); };
  window.on('resize', queueBounds); window.on('move', queueBounds);
  window.on('close', () => { clearTimeout(boundsTimer); saveBounds(); });
  window.on('closed', () => nativeAuth?.cancel());
  applicationMenu();
  validationMenu();
  if (validation) window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const cancel = blockValidationRequest(validation.state().offline, details.url);
    if (cancel) validation.log('network-blocked', { resourceType: details.resourceType });
    callback({ cancel });
  });
  if (dev) window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp()] } });
  });
  await window.loadURL(dev ? 'http://127.0.0.1:5211/' : `${rendererOrigin}/`);
}
const watchdog = setInterval(() => { if (accessState.expired()) { validation?.log('expired'); lock(); send('bizencore:access-expired'); } }, 1000);
watchdog.unref();
app.on('before-quit', () => {
  if (lifecycle && !lifecycle.canExit()) return;
  nativeAuth?.cancel(); lock(); processGuard?.close(); clerk.cleanup();
  void desktopMcp?.close().catch(() => {});
});
if (clerk.isPrimaryInstance) app.whenReady().then(async () => {
  if (process.argv.includes('--check-auth-storage')) {
    const { checkAuthStorage } = await import('./storage-smoke.mjs');
    const result = await checkAuthStorage(config.clerkHost);
    console.log(JSON.stringify(result));
    app.exit(Object.values(result).every(Boolean) ? 0 : 2);
    return;
  }
  processGuard = await createProcessGuard(path.join(app.isPackaged ? process.resourcesPath : root, 'process-guard-worker.mjs'), { onFailure: () => { nativeAuth?.cancel(); lock(); } });
  lifecycle = attachDesktopLifecycle({ app, powerMonitor, getWindow: () => window,
    runningCount: () => sessions.size + stopping.size + (taskOperation ? 1 : 0), pendingCount: () => pendingStarts.size,
    showMessageBox: (...args) => dialog.showMessageBox(...args), stopAgents: stopAgentsAndWait,
    checkAuthorization: () => { try { accessState.require(); return true; } catch { return false; } }, revokeAccess: lock,
    onResume: state => { send('bizencore:resume', state); if (!state.authorized) send('bizencore:access-expired'); },
    onError: () => { if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', message: '処理を完了できませんでした', detail: 'エージェントの状態を確認してから、もう一度お試しください。' }); },
  });
  if (mcpSupported) desktopMcp = await createDesktopMcp({
    convexUrl: profile.convexUrl,
    readApp: path.join(root, 'dist-mcp/index.html'),
    fetchData: (url, options) => net.fetch(url, options),
    access: () => {
      const grant = accessState.require();
      if (!sessionToken) throw new Error('Desktop MCP access expired');
      return { ...grant, generation: accessState.generation, token: sessionToken };
    },
  });
  await createWindow();
}).catch(() => {
  dialog.showErrorBox(profile.name, 'デスクトップを起動できませんでした。ビルド設定を確認してください。');
  app.quit();
});
