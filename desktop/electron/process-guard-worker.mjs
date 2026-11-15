import { processSnapshot, retainProcessTree, stopProcessTree } from './process-tree.mjs';

const owner = process.ppid;
const roots = new Map();
let closing = false;
function reply(id, ok, error) {
  if (process.connected) process.send({ id, ok, error });
}
function reapAll() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  for (const known of roots.values()) try { stopProcessTree(known); } catch { /* Try the remaining trees. */ }
  roots.clear();
  process.exit(0);
}
process.on('message', message => {
  if (closing || !message || !Number.isSafeInteger(message.id)) return;
  try {
    if (message.command === 'register') {
      const rows = processSnapshot();
      const root = rows.find(row => row.pid === message.pid && row.ppid === owner);
      if (!root) throw Error('Agent process ownership could not be verified');
      roots.set(root.pid, retainProcessTree(rows, new Map([[root.pid, root]])));
    } else if (message.command === 'stop') {
      const known = roots.get(message.pid);
      if (known) { stopProcessTree(known); roots.delete(message.pid); }
    } else if (message.command === 'shutdown') {
      reapAll(); return;
    } else throw Error('Unknown process guard request');
    reply(message.id, true);
  } catch { reply(message.id, false, 'Agent process cleanup failed'); }
});
process.on('disconnect', reapAll);
process.on('SIGTERM', reapAll);
const timer = setInterval(() => {
  try {
    const rows = processSnapshot();
    for (const [pid, known] of roots) {
      const current = retainProcessTree(rows, known);
      if (!current.has(pid)) { stopProcessTree(current); roots.delete(pid); }
      else roots.set(pid, current);
    }
  } catch { reapAll(); }
}, 250);
if (process.connected) process.send({ ready: true });
else reapAll();
