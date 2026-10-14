import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { listConversations, readOwnedSessionIndex, recordOwnedSession, validateResumeSessionId, writeOwnedSessionIndex } from './conversations.mjs';

export function createConversationRegistry({ userData, environmentId, getAccess, env = process.env }) {
  let writes = Promise.resolve();
  function context(agent, cwd) {
    if (!['claude', 'codex'].includes(agent) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Invalid conversation scope');
    const access = getAccess();
    const identity = { accountId: access.userId, environmentId };
    const cliHome = path.resolve((agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) || path.join(homedir(), `.${agent}`));
    const digest = createHash('sha256').update(environmentId).update('\0').update(access.userId).digest('hex');
    const filename = path.join(userData, 'conversations', `${digest}.json`);
    const check = () => {
      const current = getAccess();
      if (current.userId !== access.userId || current.generation !== access.generation) throw new Error('Conversation access expired');
    };
    return { ...identity, cliHome, cwd, agent, filename, check };
  }
  async function options(scope) {
    await writes;
    scope.check();
    const ownedSessions = await readOwnedSessionIndex(scope.filename, scope);
    scope.check();
    return { ...scope, ownedSessions };
  }
  return {
    context,
    async list(agent, cwd) {
      const scope = context(agent, cwd);
      const result = await listConversations(agent, cwd, await options(scope));
      scope.check();
      return result.map(row => ({ id: row.sessionId, title: row.title, updatedAt: Date.parse(row.updatedAt) }));
    },
    async validate(agent, cwd, sessionId) {
      const scope = context(agent, cwd);
      const result = await validateResumeSessionId(agent, cwd, sessionId, await options(scope));
      scope.check();
      return result;
    },
    enroll(record, checkLive = () => {}) {
      const scope = context(record.agent, record.cwd);
      if (record.accountId !== scope.accountId || record.environmentId !== scope.environmentId || record.cliHome !== scope.cliHome) throw new Error('Conversation scope mismatch');
      const work = writes.then(async () => {
        scope.check(); checkLive();
        const previous = await readOwnedSessionIndex(scope.filename, scope);
        const next = recordOwnedSession(previous, record);
        scope.check(); checkLive();
        await writeOwnedSessionIndex(scope.filename, next, scope);
        scope.check();
      });
      writes = work.catch(() => {});
      return work;
    },
  };
}
