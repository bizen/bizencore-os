const keyName = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
export function validStorageRequest(value) {
  return value && Number.isSafeInteger(value.id) && value.id > 0 &&
    ['getItem', 'setItem', 'removeItem'].includes(value.method) && keyName(value.key) &&
    (value.method !== 'setItem' || (typeof value.value === 'string' && Buffer.byteLength(value.value) <= 128 * 1024));
}

export function serveAuthStorage(transport, storage, reject) {
  let queue = Promise.resolve(), lastId = 0, queued = 0;
  transport.on('message', input => {
    if (!validStorageRequest(input) || input.id <= lastId || queued >= 32) { reject(); return; }
    lastId = input.id; queued++;
    queue = queue.then(async () => {
      let reply;
      try {
        const value = await storage[input.method](input.key, input.value);
        reply = { id: input.id, ok: true, ...(input.method === 'getItem' ? { value } : {}) };
      } catch { reply = { id: input.id, ok: false }; }
      finally { queued--; }
      if (transport.connected) {
        try { transport.send(reply, () => {}); } catch { reject(); }
      }
    });
  });
}

// The OS may synchronously wait for Keychain approval. Keep that wait out of main.
export function createAuthStorageChannel({ start, register = async () => {}, timeoutMs = 120000, startupMs = 10000 }) {
  const pending = new Map();
  let worker, ready = false, registered = false, closed = false, sequence = 0, startup;
  let retiring = Promise.resolve();
  const failure = () => Error('保存済みログインを確認できませんでした。macOSの確認画面と通信を確認して再試行してください。');
  const retire = child => {
    const stopped = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) { resolve(); return; }
      child.once('exit', resolve);
    });
    // Only this owned helper is killed; no renderer, CLI or unrelated process.
    child.kill('SIGKILL');
    retiring = stopped;
  };
  const fail = child => {
    if (worker !== child) return;
    worker = undefined; ready = false; registered = false; clearTimeout(startup);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); }
    pending.clear();
    retire(child);
  };
  const flush = () => {
    if (!worker || !ready || !registered || closed) return;
    const child = worker;
    for (const [id, entry] of pending) {
      if (entry.sent) continue;
      entry.sent = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => fail(child), timeoutMs);
      try { child.send({ id, ...entry.input }, error => { if (error) fail(child); }); }
      catch { fail(child); break; }
    }
  };
  const launch = async () => {
    await retiring;
    if (worker || closed || !pending.size) return;
    let child;
    try { child = start(); }
    catch {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); }
      pending.clear(); return;
    }
    worker = child;
    startup = setTimeout(() => fail(child), startupMs);
    child.on('message', reply => {
      if (worker !== child || closed) return;
      if (reply?.ready === true) { ready = true; if (registered) clearTimeout(startup); flush(); return; }
      const entry = pending.get(reply?.id);
      if (!entry || !entry.sent) return;
      pending.delete(reply.id); clearTimeout(entry.timer);
      if (reply.ok === true && (entry.input.method !== 'getItem' || reply.value === null || (typeof reply.value === 'string' && Buffer.byteLength(reply.value) <= 128 * 1024))) entry.resolve(entry.input.method === 'getItem' ? reply.value : undefined);
      else entry.reject(failure());
    });
    child.on('error', () => fail(child));
    child.on('exit', () => fail(child));
    try { await register(child); }
    catch { fail(child); return; }
    if (worker !== child || closed) return;
    registered = true; if (ready) clearTimeout(startup); flush();
  };
  const request = (method, key, value) => {
    if (closed) return Promise.reject(failure());
    if (pending.size >= 32) return Promise.reject(failure());
    const id = ++sequence, input = { method, key, ...(method === 'setItem' ? { value } : {}) };
    if (!validStorageRequest({ id, ...input })) return Promise.reject(failure());
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (worker) fail(worker);
        else { pending.delete(id); reject(failure()); }
      }, timeoutMs + startupMs);
      pending.set(id, { input, resolve, reject, timer, sent: false });
    });
    if (worker) flush(); else void launch();
    return promise;
  };
  return {
    getItem: key => request('getItem', key),
    setItem: (key, value) => request('setItem', key, value),
    removeItem: key => request('removeItem', key),
    close() {
      closed = true;
      if (worker) fail(worker);
      else { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); } pending.clear(); }
      return retiring;
    },
  };
}
