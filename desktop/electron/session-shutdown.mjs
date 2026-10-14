// Repeated stop requests and natural exits share one process-tree barrier.
// Failed barriers remain blocked; another launch must not assume cleanup worked.
export function createShutdownBarrier() {
  const entries = new Map();
  return {
    get size() { return entries.size; },
    get: id => entries.get(id),
    hasOther: id => [...entries.keys()].some(key => key !== id),
    run(id, action) {
      if (entries.has(id)) return entries.get(id);
      const promise = Promise.resolve().then(action);
      entries.set(id, promise);
      void promise.then(() => { if (entries.get(id) === promise) entries.delete(id); }, () => {});
      return promise;
    },
    wait: () => Promise.all([...entries.values()]),
  };
}
