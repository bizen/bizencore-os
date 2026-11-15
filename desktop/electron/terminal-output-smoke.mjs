import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as pty from '../../.electron-build/node_modules/node-pty/lib/index.js';
import { TerminalOutput } from './terminal-output.mjs';

const count = Number(process.argv[2] ?? '8');
if (!Number.isInteger(count) || count < 1 || count > 8) throw Error('Choose 1..8 PTYs');
const node = process.env.PTY_SMOKE_NODE;
if (!node?.startsWith('/')) throw Error('Set PTY_SMOKE_NODE to an absolute Node executable');
const block = Buffer.from('\x1b[32m日本語 terminal output 0123456789\x1b[0m\r\n'.repeat(64));
const repeats = 512;
const expected = createHash('sha256');
for (let i = 0; i < repeats; i++) expected.update(block);
const digest = expected.digest('hex');
const children = [];
try {
  const results = await Promise.all(Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const script = `const b=Buffer.from(${JSON.stringify(block.toString('base64'))},'base64'); let i=0; function emit(){while(i<${repeats}){i++; if(!process.stdout.write(b)){process.stdout.once('drain',emit);return;}}} emit();`;
    const terminal = pty.spawn(node, ['-e', script], { name: 'xterm-256color', cols: 80, rows: 24, encoding: null,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    children.push(terminal);
    const actual = createHash('sha256');
    let bytesRead = 0, packets = 0, paused = 0, peakPendingBytes = 0;
    const timeout = setTimeout(() => { output.dispose(); terminal.kill(); reject(Error(`PTY ${index} timed out`)); }, 20000);
    const output = new TerminalOutput({
      pause: () => { paused++; terminal.pause(); }, resume: () => terminal.resume(),
      send: (sequence, bytes) => {
        assert.ok(bytes.length <= 65536);
        actual.update(bytes); bytesRead += bytes.length; packets++;
        // Deliberately slower consumption exercises actual native PTY pause/resume.
        setTimeout(() => output.acknowledge(sequence), 12);
      },
    });
    const data = terminal.onData(bytes => {
      output.push(bytes);
      peakPendingBytes = Math.max(peakPendingBytes, output.queued + (output.inFlight?.size ?? 0));
    });
    const exit = terminal.onExit(({ exitCode }) => {
      data.dispose(); exit.dispose();
      output.finish(() => {
        clearTimeout(timeout);
        try {
          assert.equal(exitCode, 0);
          // PTYs translate LF to CRLF, including LF already preceded by CR.
          const translated = createHash('sha256');
          const translatedBlock = Buffer.from(block.toString().replaceAll('\n', '\r\n'));
          for (let i = 0; i < repeats; i++) translated.update(translatedBlock);
          assert.equal(bytesRead, translatedBlock.length * repeats);
          assert.equal(actual.digest('hex'), translated.digest('hex'));
          assert.ok(paused > 0, 'the native producer must encounter backpressure');
          assert.ok(peakPendingBytes <= 320 * 1024, 'PTY backlog stays near the watermark plus one read');
          resolve({ index, bytesRead, packets, pauses: paused, peakPendingBytes });
        } catch (error) { reject(error); }
      });
    });
  })));
  console.log(JSON.stringify({ ptys: count, sourceDigest: digest, results, scope: 'Native PTY transport only; not real AI agents or UI responsiveness.' }, null, 2));
} finally {
  for (const terminal of children) { try { terminal.kill('SIGKILL'); } catch { /* Already exited. */ } }
}
