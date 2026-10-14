import { fork } from 'node:child_process';

export async function createProcessGuard(file, { onFailure = () => {} } = {}) {
  const child = fork(file, [], { execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const pending = new Map();
  let sequence = 0, closing = false;
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Agent process guard unavailable')); }
    pending.clear();
    if (!closing) onFailure();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.on('message', message => {
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.ok) entry.resolve(); else entry.reject(Error(message.error));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Agent process guard did not start')); }, 5000);
    const ready = message => { if (message?.ready) { clearTimeout(timer); child.off('message', ready); resolve(); } };
    child.on('message', ready);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Agent process guard exited')); });
  });
  function request(command, pid) {
    if (!child.connected || closing) return Promise.reject(Error('Agent process guard unavailable'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Agent process guard timed out')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, command, pid }, error => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
  }
  return {
    register: pid => request('register', pid), stop: pid => request('stop', pid),
    close: () => {
      if (closing) return;
      closing = true;
      if (child.connected) child.send({ id: ++sequence, command: 'shutdown' });
    },
  };
}
