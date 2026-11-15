import { execFileSync } from 'node:child_process';

export function parseProcessIdentities(text) {
  return text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3].replace(/\s+/g, ' '), executable: match[4] }] : [];
  });
}

export function processSnapshot() {
  return parseProcessIdentities(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  }));
}

const sameProcess = (left, right) => left?.pid === right?.pid && left?.started === right?.started && left?.executable === right?.executable;

export function retainProcessTree(rows, known) {
  const selected = new Map();
  for (const row of rows) if (sameProcess(row, known.get(row.pid))) selected.set(row.pid, row);
  let size;
  do {
    size = selected.size;
    for (const row of rows) if (selected.has(row.ppid)) selected.set(row.pid, row);
  } while (size !== selected.size);
  return selected;
}

export function stopProcessTree(known, snapshot = processSnapshot, signal = process.kill.bind(process)) {
  const stopped = new Set();
  let owned = known;
  // Freeze parents before rescanning: shell jobs may own separate process groups.
  try {
    for (let pass = 0; pass < 4; pass++) {
      owned = retainProcessTree(snapshot(), owned);
      let added = 0;
      for (const row of owned.values()) if (!stopped.has(row.pid)) {
        try { signal(row.pid, 'SIGSTOP'); stopped.add(row.pid); added++; } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      if (!added) break;
    }
  } finally {
    const current = new Map(snapshot().map(row => [row.pid, row]));
    for (const row of [...owned.values()].reverse()) if (sameProcess(row, current.get(row.pid))) {
      try { signal(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
