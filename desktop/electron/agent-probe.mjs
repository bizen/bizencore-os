import { execFile } from 'node:child_process';

// execFile's abort callback can run before close. Keep startup reserved until
// the probe has actually exited, including on abort and timeout.
export function runAgentProbe(file, args, options, execute = execFile) {
  return new Promise((resolve, reject) => {
    let outcome;
    let closed = false;
    const finish = () => {
      if (!closed || !outcome) return;
      if (outcome.error) reject(outcome.error);
      else resolve({ stdout: outcome.stdout, stderr: outcome.stderr });
    };
    const child = execute(file, args, { ...options, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      outcome = { error, stdout, stderr }; finish();
    });
    // Node's AbortSignal path uses SIGTERM even when killSignal is configured.
    const abort = () => { child.kill('SIGKILL'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('close', () => { options.signal?.removeEventListener('abort', abort); closed = true; finish(); });
  });
}
