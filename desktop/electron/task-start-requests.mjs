import { randomUUID } from 'node:crypto';

// Acknowledge the renderer's validated assignment, never just delivery of an event.
export function createTaskStartRequests(send, timeoutMs = 5000) {
  const pending = new Map();
  return {
    request(paneId, assignment, signal) {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID(), expiresAt = Date.now() + timeoutMs;
        const finish = error => {
          clearTimeout(timer); signal.removeEventListener('abort', abort); pending.delete(requestId);
          if (error) reject(new Error(error)); else resolve({ assigned: true, task_id: assignment.taskId });
        };
        const abort = () => finish('このターミナルの接続は終了しました');
        const timer = setTimeout(() => finish('担当への反映を確認できませんでした。担当表示を確認してから再試行してください'), timeoutMs);
        pending.set(requestId, finish);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else send({ requestId, paneId, assignment, expiresAt });
      });
    },
    reply(requestId, error) {
      if (typeof requestId !== 'string' || (error !== null && typeof error !== 'string')) throw new Error('Invalid task start reply');
      pending.get(requestId)?.(error);
    },
  };
}
