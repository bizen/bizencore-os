import { isSessionId } from './conversations.mjs';
import { randomUUID } from 'node:crypto';

// Register this ID in authenticated scoped storage before spawn. Prefix args
// before agentLaunchArgs (which may contain the positional '--' delimiter).
// Installed Codex has no --session-id; capture requires proven process ownership.
export function allocateAgentSession(agent) {
  if (agent === 'codex') return { sessionId: null, args: [] };
  if (agent !== 'claude') throw new Error('Unsupported agent');
  const sessionId = randomUUID();
  return { sessionId, args: ['--session-id', sessionId] };
}

// The main process must await validateResumeSessionId before using a resume ID.
export function agentLaunchArgs(agent, handoff, resumeSessionId, newSessionId) {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unsupported agent');
  const args = agent === 'codex' ? ['--no-alt-screen', '--no-daemon'] : [];
  if (resumeSessionId !== undefined) {
    if (newSessionId !== undefined) throw new Error('Cannot resume and allocate a new session');
    if (!isSessionId(resumeSessionId)) throw new Error('Invalid resume session ID');
    return agent === 'claude' ? ['--resume', resumeSessionId] : [...args, 'resume', resumeSessionId];
  }
  if (newSessionId !== undefined) {
    if (agent !== 'claude' || !isSessionId(newSessionId)) throw new Error('Invalid new session ID');
    args.push('--session-id', newSessionId);
  }
  if (handoff === undefined) return args;
  if (!handoff || typeof handoff !== 'object' ||
    typeof handoff.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(handoff.taskId) ||
    !['consult', 'execute'].includes(handoff.intent) || !['mcp', 'text'].includes(handoff.mode) ||
    typeof handoff.prompt !== 'string' || !handoff.prompt.trim() ||
    handoff.prompt.includes('\0') || Buffer.byteLength(handoff.prompt) > 64 * 1024) {
    throw new Error('Invalid task handoff');
  }
  return [...args, '--', handoff.prompt];
}
