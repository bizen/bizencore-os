import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';

// Bounded CPU saturation, independent of AI API availability and permissions.
if (isMainThread) {
  const seconds = Number(process.argv[2] ?? 180);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) throw Error('Duration must be 10..600 seconds');
  const count = Math.min(8, availableParallelism());
  const end = Date.now() + seconds * 1000;
  const workers = Array.from({ length: count }, () => new Worker(new URL(import.meta.url), { workerData: { end }, resourceLimits: { maxOldGenerationSizeMb: 32 } }));
  let done = 0;
  console.log(JSON.stringify({ kind: 'load-started', pid: process.pid, workers: count, seconds, end }));
  for (const worker of workers) worker.once('message', rounds => {
    console.log(JSON.stringify({ kind: 'load-finished', rounds }));
    if (++done === count) process.exitCode = 0;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const worker of workers) void worker.terminate(); });
} else {
  const data = Buffer.alloc(1024 * 1024, 0x61);
  let rounds = 0;
  while (Date.now() < workerData.end) { createHash('sha256').update(data).digest(); rounds++; }
  parentPort.postMessage(rounds);
}
