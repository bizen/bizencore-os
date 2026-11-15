import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function parseProcesses(output) {
  return output.trim().split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?)\s+(.+)$/);
    if (!match) return [];
    const [days, time] = match[4].includes('-') ? match[4].split('-') : ['0', match[4]];
    const parts = time.split(':').map(Number);
    const cpuSeconds = Number(days) * 86400 + parts.reduce((sum, part) => sum * 60 + part, 0);
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssMiB: Number(match[3]) / 1024, cpuSeconds, executable: match[5] }];
  });
}

export function selectAppTree(rows) {
  const app = rows.filter(row => row.executable.includes('bizencore Electron Preview.app/Contents/'));
  const selected = new Set(app.map(row => row.pid));
  let previousSize;
  do {
    previousSize = selected.size;
    for (const row of rows) if (selected.has(row.ppid)) selected.add(row.pid);
  } while (previousSize !== selected.size);
  const descendants = rows.filter(row => selected.has(row.pid));
  const agents = descendants.filter(row => !app.includes(row));
  const appIds = new Set(app.map(row => row.pid));
  const sessions = agents.filter(row => appIds.has(row.ppid) && /(?:^|\/)(?:claude|codex)$/.test(row.executable));
  return { app, agents, sessions };
}

export function cpuPercent(current, previous, seconds) {
  if (seconds <= 0) return null;
  const before = new Map(previous.map(row => [row.pid, row.cpuSeconds]));
  return current.reduce((sum, row) => sum + (before.has(row.pid) ? Math.max(0, row.cpuSeconds - before.get(row.pid)) : 0), 0) / seconds * 100;
}

export function appProcessMetrics(current, previous, seconds) {
  return current.map(row => ({
    pid: row.pid,
    name: row.executable.split('/').at(-1),
    rssMiB: row.rssMiB,
    cpuPercent: previous ? cpuPercent([row], previous, seconds) : null,
  }));
}

async function main() {
  const [label = 'sample', durationText = '15', output] = process.argv.slice(2);
  const duration = Number(durationText);
  if (!Number.isFinite(duration) || duration < 2 || duration > 300) throw Error('Duration must be 2..300 seconds');
  const samples = [];
  const start = performance.now();
  let previous;
  do {
    const tree = selectAppTree(parseProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' })));
    if (!tree.app.length) throw Error('Packaged Electron Preview is not running');
    const elapsed = (performance.now() - start) / 1000;
    const groups = Object.fromEntries(['app', 'agents'].map(key => [key, {
      processCount: tree[key].length,
      rssMiB: tree[key].reduce((sum, row) => sum + row.rssMiB, 0),
      cpuPercent: previous ? cpuPercent(tree[key], previous.tree[key], elapsed - previous.elapsed) : null,
    }]));
    samples.push({ elapsedSeconds: elapsed, agentSessionCount: tree.sessions.length, ...groups,
      appProcesses: appProcessMetrics(tree.app, previous?.tree.app, previous ? elapsed - previous.elapsed : 0),
    });
    previous = { tree, elapsed };
    if (elapsed >= duration) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
  const report = {
    label, capturedAt: new Date().toISOString(), durationSeconds: samples.at(-1).elapsedSeconds,
    memoryMetric: 'Sum of process RSS; shared pages can be double-counted. Not physical footprint.',
    cpuMetric: 'CPU-time delta per wall second; 100% is one core. New/exited process intervals are excluded.',
    samples,
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const summary = Object.fromEntries(['app', 'agents'].map(key => [key, {
    processCount: samples.at(-1)[key].processCount,
    rssMeanMiB: samples.reduce((sum, sample) => sum + sample[key].rssMiB, 0) / samples.length,
    rssPeakMiB: Math.max(...samples.map(sample => sample[key].rssMiB)),
    cpuMeanPercent: samples.slice(1).reduce((sum, sample) => sum + sample[key].cpuPercent, 0) / (samples.length - 1),
    cpuPeakPercent: Math.max(...samples.slice(1).map(sample => sample[key].cpuPercent)),
  }]));
  console.log(JSON.stringify({ label, agentSessionCountRange: [Math.min(...samples.map(sample => sample.agentSessionCount)), Math.max(...samples.map(sample => sample.agentSessionCount))], ...summary, memoryMetric: report.memoryMetric, output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
