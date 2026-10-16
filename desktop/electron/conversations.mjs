import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { processSnapshot, retainProcessTree } from './process-tree.mjs';
import { homedir } from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDS = 256;
const MAX_ENTRIES = 4096;
const MAX_HEADER = 64 * 1024;
const MAX_INDEX = 512 * 1024;
const runFile = promisify(execFile);
export const isSessionId = value => typeof value === 'string' && value.length === 36 && UUID.test(value);

function agentCheck(agent) {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unsupported agent');
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Invalid conversation folder');
  return path.resolve(value);
}

function scope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

// Refuse symlinks at every component, including a configured CLI home.
async function safeStat(filename) {
  const resolved = absolute(filename);
  let cursor = path.parse(resolved).root;
  let result;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    result = await lstat(cursor);
    if (result.isSymbolicLink()) throw new Error('Symlink conversation path');
    if (cursor !== resolved && !result.isDirectory()) throw new Error('Invalid conversation path');
  }
  return result ?? await lstat(cursor);
}

async function metadata(filename, maxBytes, firstLine = false) {
  const before = await safeStat(filename);
  if (!before.isFile() || before.nlink !== 1 || (!firstLine && before.size > maxBytes)) return null;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    // Only the first session_meta record is parsed; no transcript records are searched.
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(1024, buffer.length - length), length);
      if (!bytesRead) break;
      const start = length;
      length += bytesRead;
      if (firstLine) {
        const newline = buffer.indexOf(10, start);
        if (newline >= 0 && newline < length) { length = newline; break; }
      }
    }
    if (length > maxBytes) return null;
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

function home(agent, options) {
  const env = options.env ?? process.env;
  return absolute(options.cliHome ?? (agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ?? path.join(homedir(), `.${agent}`));
}

/**
 * Pure ownership-index helper. Persist its returned array in authenticated app
 * storage, never renderer-provided state. A record contains only agent, sessionId,
 * cwd, cliHome, accountId and environmentId (no MCP token, prompts or transcript).
 * Record ONLY IDs proven to have been started by this app in that scope. Claude
 * can use an app-generated --session-id UUID. For Codex's auto-generated UUID,
 * use an owned process's session-start event, or a separate per-account/environment
 * CODEX_HOME and its newly-created rollout filename/session_meta header. A before/
 * after scan of a shared ~/.codex is NOT proof of ownership. Never auto-enroll all
 * discovered sessions. Rotate the scope on account or environment changes.
 */
export function recordOwnedSession(index, record) {
  if (!Array.isArray(index) || !record || !scope(record.accountId) || !scope(record.environmentId) || !isSessionId(record.sessionId)) {
    throw new Error('Invalid owned conversation');
  }
  agentCheck(record.agent);
  const entry = { agent: record.agent, sessionId: record.sessionId.toLowerCase(), cwd: absolute(record.cwd),
    cliHome: absolute(record.cliHome), accountId: record.accountId, environmentId: record.environmentId };
  const rest = index.filter(row => !(row?.agent === entry.agent && row?.sessionId === entry.sessionId &&
    row?.accountId === entry.accountId && row?.environmentId === entry.environmentId));
  return [...rest.slice(-(MAX_IDS - 1)), entry];
}

function scopedIndex(records, identity) {
  if (!scope(identity?.accountId) || !scope(identity?.environmentId) || !Array.isArray(records)) throw new Error('Invalid conversation index scope');
  let result = [];
  for (const row of records.slice(-MAX_IDS)) {
    if (row?.accountId !== identity.accountId || row?.environmentId !== identity.environmentId) continue;
    try { result = recordOwnedSession(result, row); } catch { /* Invalid records grant no access. */ }
  }
  return result;
}

/** Parent chooses a userData/environment/userId path; only metadata is persisted. */
export async function readOwnedSessionIndex(filename, identity) {
  scopedIndex([], identity);
  try {
    const stat = await safeStat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) return [];
    const index = await metadata(filename, MAX_INDEX);
    if (index?.version !== 1 || index.accountId !== identity.accountId || index.environmentId !== identity.environmentId) return [];
    return scopedIndex(index.sessions, identity);
  } catch { return []; }
}

// Atomic replacement, 0600 file, 0700 new directories; refuses symlink/hardlink
// indexes. Main serializes updates and rechecks generation BEFORE each write.
export async function writeOwnedSessionIndex(filename, records, identity) {
  const sessions = scopedIndex(records, identity);
  const target = absolute(filename);
  const directory = path.dirname(target);
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await safeStat(cursor)).isDirectory()) throw new Error('Invalid conversation index directory');
  }
  try {
    const stat = await safeStat(target);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe conversation index');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path.join(directory, `.conversations-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    const body = JSON.stringify({ version: 1, accountId: identity.accountId, environmentId: identity.environmentId, sessions });
    if (Buffer.byteLength(body) > MAX_INDEX) throw new Error('Conversation index is too large');
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await safeStat(directory);
    await rename(temp, target);
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return sessions;
}

function permissions(agent, cwd, cliHome, options) {
  const ids = new Set();
  if (!scope(options.accountId) || !scope(options.environmentId)) return ids;
  const records = Array.isArray(options.ownedSessions) ? options.ownedSessions.slice(-MAX_IDS) : [];
  for (const row of records) {
    if (row?.agent === agent && row.cwd === cwd && row.cliHome === cliHome && row.accountId === options.accountId &&
      row.environmentId === options.environmentId && isSessionId(row.sessionId)) ids.add(row.sessionId.toLowerCase());
  }
  // An alternative for a parent-owned, already scoped store. Never accept this
  // allowlist, scope or CLI home from IPC/renderer arguments.
  if (Array.isArray(options.ownedIds)) {
    for (const id of options.ownedIds.slice(0, MAX_IDS)) if (isSessionId(id)) ids.add(id.toLowerCase());
  }
  return ids;
}

async function* entries(folder, budget) {
  if (!budget.remaining || !(await safeStat(folder)).isDirectory()) return;
  const directory = await opendir(folder);
  for await (const entry of directory) {
    if (!budget.remaining--) break;
    if (!entry.isSymbolicLink()) yield entry;
    if (!budget.remaining) break;
  }
}

function output(agent, cwd, id, modified) {
  return { agent, sessionId: id.toLowerCase(), cwd, title: `${agent === 'claude' ? 'Claude Code' : 'Codex'} conversation`,
    updatedAt: new Date(modified).toISOString() };
}

async function claudeConversations(cwd, cliHome, ids, options) {
  // Very long/custom project encodings require a trusted explicit directory name.
  const name = options.claudeProjectDirName ?? cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(name)) return [];
  const project = path.join(cliHome, 'projects', name);
  const result = [];
  let index;
  try { index = await metadata(path.join(project, 'sessions-index.json'), MAX_INDEX); } catch { /* Missing/stale indexes fail closed. */ }
  const rows = Array.isArray(index?.entries) ? index.entries.slice(0, MAX_ENTRIES) : [];
  for (const id of ids) {
    const row = rows.find(entry => isSessionId(entry?.sessionId) && entry.sessionId.toLowerCase() === id);
    if (row && (row.projectPath !== cwd || row.isSidechain !== false)) continue;
    // App-owned records also supply exact-cwd metadata when modern Claude no
    // longer writes sessions-index.json. Transcript contents are never read.
    const owned = Array.isArray(options.ownedSessions) && options.ownedSessions.slice(-MAX_IDS).some(entry => entry?.agent === 'claude' && isSessionId(entry.sessionId) && entry.sessionId.toLowerCase() === id &&
      entry.cwd === cwd && entry.cliHome === cliHome && entry.accountId === options.accountId && entry.environmentId === options.environmentId);
    if (!row && !owned) continue;
    try {
      const stat = await safeStat(path.join(project, `${id}.jsonl`));
      if (stat.isFile() && stat.nlink === 1 && (options.ownedSince === undefined || stat.birthtimeMs >= options.ownedSince)) result.push(output('claude', cwd, id, stat.mtimeMs));
    } catch { /* A missing or unsafe file is not resumable. */ }
  }
  return result;
}

async function codexConversations(cwd, cliHome, ids, options) {
  const result = [];
  // Owned IDs bound metadata reads; unrelated filenames must not consume their search budget.
  const budget = { remaining: Number.isInteger(options.maxEntries) ? Math.max(1, Math.min(MAX_ENTRIES, options.maxEntries)) : ids ? Infinity : MAX_ENTRIES, reads: MAX_IDS };
  const root = path.join(cliHome, 'sessions');
  async function walk(folder, depth) {
    try {
      for await (const entry of entries(folder, budget)) {
        if ((ids && result.length === ids.size) || !budget.reads) break;
        const filename = path.join(folder, entry.name);
        if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
          await walk(filename, depth + 1);
        } else if (depth === 3 && entry.isFile()) {
          const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
          if (!match || !isSessionId(match[1]) || (ids && !ids.has(match[1].toLowerCase())) || result.some(row => row.sessionId === match[1].toLowerCase())) continue;
          budget.reads--;
          try {
            const header = await metadata(filename, MAX_HEADER, true);
            const payload = header?.payload;
            if (header?.type !== 'session_meta' || payload?.id?.toLowerCase() !== match[1].toLowerCase() ||
              payload.cwd !== cwd || payload.source !== 'cli') continue;
            const stat = await safeStat(filename);
            if (options.ownedSince !== undefined && (stat.birthtimeMs < options.ownedSince ||
              !Number.isFinite(Date.parse(payload.timestamp)) || Date.parse(payload.timestamp) < options.ownedSince)) continue;
            if (options.cliVersion !== undefined && payload.cli_version !== options.cliVersion) continue;
            result.push(output('codex', cwd, payload.id, stat.mtimeMs));
          } catch { /* Malformed, missing and unsafe metadata fails closed. */ }
        }
      }
    } catch { /* Missing or unsafe history directories grant no additional access. */ }
  }
  await walk(root, 0);
  if (!ids && (!budget.remaining || !budget.reads)) return [];
  return result;
}

/**
 * Parent contract: listConversations(agent, canonicalCwd, { accountId,
 * environmentId, cliHome, ownedSessions OR ownedIds, ownedSince?, limit? }).
 * ownedIds MUST already be scoped to account/environment/agent/cwd/CLI home by
 * the parent. ownedSince is an optional epoch-ms lower bound, NEVER ownership.
 * Empty/missing ownership => []. Metadata is local and formats are internal;
 * unknown formats => []. IPC must recheck its authentication generation after
 * await, and use the SAME CLI home/environment for the subsequent launch.
 * Returns only { agent, sessionId, cwd, title, updatedAt }; no native file paths,
 * summary, prompt, transcript, permission history or credentials are exposed.
 */
export async function listConversations(agent, cwd, options = {}) {
  agentCheck(agent);
  const folder = absolute(cwd);
  const cliHome = home(agent, options);
  const ids = permissions(agent, folder, cliHome, options);
  if (!ids.size) return [];
  if (options.ownedSince !== undefined && (!Number.isFinite(options.ownedSince) || options.ownedSince <= 0)) return [];
  try { if (!(await safeStat(folder)).isDirectory()) return []; } catch { return []; }
  const rows = agent === 'claude' ? await claudeConversations(folder, cliHome, ids, options) : await codexConversations(folder, cliHome, ids, options);
  const unique = [...new Map(rows.map(row => [row.sessionId, row])).values()];
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(50, options.limit)) : 20;
  return unique.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);
}

// Call immediately before spawn, then recheck auth generation and MCP isolation.
export async function validateResumeSessionId(agent, cwd, sessionId, options = {}) {
  if (!isSessionId(sessionId)) throw new Error('Invalid resume session ID');
  const wanted = sessionId.toLowerCase();
  const rows = await listConversations(agent, cwd, { ...options, limit: 50,
    ownedIds: Array.isArray(options.ownedIds) ? options.ownedIds.slice(0, MAX_IDS).filter(id => isSessionId(id) && id.toLowerCase() === wanted) : [],
    ownedSessions: Array.isArray(options.ownedSessions) ? options.ownedSessions.slice(-MAX_IDS).filter(row => isSessionId(row?.sessionId) && row.sessionId.toLowerCase() === wanted) : [] });
  if (!rows.some(row => row.sessionId === wanted)) throw new Error('Conversation is not permitted for this folder');
  return wanted;
}

/**
 * Codex 0.162.0-alpha.2 --help has NO --session-id. Shared-home timestamp/CWD/
 * cli_version alone cannot link a rollout to our process, so return null there.
 * A parent may capture from a newly allocated, exclusive per-launch CODEX_HOME
 * after spawning exactly one verified app-owned CLI process there. The trusted
 * exclusiveCliHome flag attests that fact; never set it for shared ~/.codex or
 * accept it from IPC. Do not copy/import existing rollouts into that home.
 * This reads only session_meta and returns a sanitized record for persistence.
 * Unknown versions, ambiguous matches and paginated/new storage fail closed.
 */
export async function captureOwnedCodexSession(cwd, options = {}) {
  if (options.exclusiveCliHome !== true || !options.cliHome || !scope(options.accountId) || !scope(options.environmentId) ||
    !Number.isFinite(options.ownedSince) || options.ownedSince <= 0 || typeof options.cliVersion !== 'string' || !options.cliVersion) return null;
  const folder = absolute(cwd), cliHome = home('codex', options);
  try { if (!(await safeStat(folder)).isDirectory()) return null; } catch { return null; }
  const rows = await codexConversations(folder, cliHome, null, options);
  if (rows.length !== 1) return null;
  return recordOwnedSession([], { agent: 'codex', sessionId: rows[0].sessionId, cwd: folder, cliHome,
    accountId: options.accountId, environmentId: options.environmentId })[0];
}

/**
 * Validate an lsof candidate BEFORE enrollment. A valid header alone is NOT
 * proof of ownership; only discoverOwnedConversation or the parent may establish
 * the verified process link. Candidate paths never come from renderer IPC.
 */
export async function validateConversationCandidate(agent, cwd, filename, options = {}) {
  agentCheck(agent);
  if (agent !== 'codex' || !scope(options.accountId) || !scope(options.environmentId) || !options.cliHome ||
    !Number.isFinite(options.ownedSince) || options.ownedSince <= 0) return null;
  try {
    const folder = absolute(cwd), cliHome = home(agent, options);
    if (!(await safeStat(folder)).isDirectory() || typeof filename !== 'string' || /[\x00-\x1f\x7f]/.test(filename)) return null;
    const target = absolute(filename), root = path.join(cliHome, 'sessions');
    const relative = path.relative(root, target);
    const match = /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-([0-9a-f-]{36})\.jsonl$/i.exec(relative);
    if (!match || !isSessionId(match[1])) return null;
    const header = await metadata(target, MAX_HEADER, true), payload = header?.payload;
    const stat = await safeStat(target);
    if (header?.type !== 'session_meta' || !isSessionId(payload?.id) || payload.id.toLowerCase() !== match[1].toLowerCase() ||
      payload.cwd !== folder || payload.source !== 'cli' || stat.birthtimeMs < options.ownedSince ||
      !Number.isFinite(Date.parse(payload.timestamp)) || Date.parse(payload.timestamp) < options.ownedSince ||
      (options.cliVersion !== undefined && payload.cli_version !== options.cliVersion)) return null;
    return recordOwnedSession([], { agent, sessionId: payload.id, cwd: folder, cliHome,
      accountId: options.accountId, environmentId: options.environmentId })[0];
  } catch { return null; }
}

function identities(value) {
  return value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
}

function sameIdentity(a, b) {
  return a?.pid === b?.pid && typeof a?.started === 'string' && a.started === b?.started &&
    typeof a?.executable === 'string' && a.executable === b?.executable;
}

/**
 * Main-process-only API: { pid, processIdentities: Map<pid,{pid,ppid,started,
 * executable}>, cliHome, accountId, environmentId, ownedSince: launchEpochMs,
 * cliVersion?, timeoutMs?, signal?, snapshot?, runlsof? }. Saved identities MUST
 * come from the parent's verified app-owned CLI tree, not an arbitrary ps list.
 * Fresh ps snapshots verify start time/executable before AND after each lsof
 * call and after metadata reads; PID reuse or lost ancestry aborts capture.
 * lsof runs with -a -p <pid> -Fn (no shell), 1s timeout and 64KiB output cap.
 * A verified Node/Bun launcher may own the native Codex child. Only Codex
 * identities in that live ownership tree are queried, at most 8 per pass.
 * Returns one sanitized ownership record or null, at most 5s. Parent rechecks
 * accessState generation/userId before persisting; abort on logout/pane stop.
 * No sessions are enumerated or enrolled from shared-home before/after scans.
 */
export async function discoverOwnedConversation(agent, cwd, options = {}) {
  agentCheck(agent);
  if (agent !== 'codex' || !Number.isSafeInteger(options.pid) || options.pid <= 0 || !options.cliHome ||
    !scope(options.accountId) || !scope(options.environmentId) || !Number.isFinite(options.ownedSince) || options.ownedSince <= 0) return null;
  let known = new Map(identities(options.processIdentities).slice(0, 256)
    .filter(row => Number.isSafeInteger(row?.pid) && row.pid > 0 && typeof row.started === 'string' && path.isAbsolute(row.executable ?? ''))
    .map(row => [row.pid, row]));
  const root = known.get(options.pid);
  if (!root || !path.isAbsolute(root.executable ?? '') || !['codex', 'node', 'nodejs', 'bun'].includes(path.basename(root.executable)) || !root.started) return null;
  const duration = Number.isInteger(options.timeoutMs) ? Math.max(1, Math.min(5000, options.timeoutMs)) : 5000;
  const deadline = performance.now() + duration;
  const snapshot = options.snapshot ?? processSnapshot;
  const probeOptions = () => ({ encoding: 'utf8', shell: false, timeout: Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now()))),
    maxBuffer: 64 * 1024, killSignal: 'SIGKILL', signal: options.signal });
  async function verified() {
    if (options.signal?.aborted || performance.now() >= deadline) return null;
    let rows;
    try { rows = identities(await snapshot(probeOptions())); } catch { return null; }
    const live = new Map(rows.map(row => [row?.pid, row]));
    if (!sameIdentity(root, live.get(root.pid))) return null;
    known = retainProcessTree(rows, known);
    const selected = [];
    for (const saved of known.values()) {
      if (!Number.isSafeInteger(saved?.pid) || saved.pid <= 0 || path.basename(saved.executable ?? '') !== 'codex' || !sameIdentity(saved, live.get(saved.pid))) continue;
      let row = live.get(saved.pid), hops = 0;
      while (row.pid !== root.pid && hops++ < 256) {
        const parent = live.get(row.ppid);
        if (!parent || !sameIdentity(known.get(parent.pid), parent)) break;
        row = parent;
      }
      if (row.pid === root.pid) selected.push(saved);
    }
    return selected.slice(0, 8);
  }
  while (performance.now() < deadline && !options.signal?.aborted) {
    const processes = await verified();
    if (!processes?.length) return null;
    const records = new Map();
    for (const process of processes) {
      if (performance.now() >= deadline || options.signal?.aborted) return null;
      let stdout;
      try {
        ({ stdout } = await (options.runlsof ?? runFile)('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Fn'], probeOptions()));
      } catch { continue; }
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 64 * 1024) return null;
      const stillOwned = await verified();
      if (!stillOwned?.some(row => sameIdentity(row, process))) return null;
      // p records bind each n filename to the requested process, even if a
      // replacement/fake lsof returns records for additional processes.
      let reportedPid;
      let candidates = 0;
      for (const field of stdout.split('\n')) {
        if (/^p\d+$/.test(field)) reportedPid = Number(field.slice(1));
        if (field[0] !== 'n' || reportedPid !== process.pid || !field.includes('/rollout-') || !field.endsWith('.jsonl')) continue;
        if (++candidates > 16) return null;
        const record = await validateConversationCandidate(agent, cwd, field.slice(1), options);
        if (record) records.set(record.sessionId, { record, process });
      }
    }
    if (records.size > 1) return null;
    if (records.size === 1) {
      const alive = await verified();
      const candidate = [...records.values()][0];
      if (!alive?.some(row => sameIdentity(row, candidate.process))) return null;
      return candidate.record;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    try { await delay(Math.min(200, remaining), undefined, { signal: options.signal }); } catch { return null; }
  }
  return null;
}

/**
 * Registry contract: captureOwnedCodexProcessSession(cwd, { processIdentity:
 * Map<pid,{pid,ppid,started,executable}>, cliHome, accountId, environmentId,
 * ownedSince: launchEpochMs }) => Promise<metadataRecord|null>.
 * processIdentity is the parent's verified LIVE app-owned tree, with one root.
 * Optional signal, timeoutMs (max 5000), cliVersion, snapshot and runlsof are
 * main-only hooks; the last two support fixtures. No enrollment happens here.
 * Registry serializes writeOwnedSessionIndex, checks authenticated userId and
 * generation plus live pane ownership immediately before enrollment.
 */
export async function captureOwnedCodexProcessSession(cwd, options = {}) {
  if (!(options.processIdentity instanceof Map) || !options.processIdentity.size || options.processIdentity.size > 256) return null;
  const roots = [...options.processIdentity.values()].filter(row => !options.processIdentity.has(row?.ppid));
  if (roots.length !== 1) return null;
  return discoverOwnedConversation('codex', cwd, { ...options, pid: roots[0].pid, processIdentities: options.processIdentity });
}
