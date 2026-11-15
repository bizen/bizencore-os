import assert from 'node:assert/strict';
import * as pty from '../../.electron-build/node_modules/node-pty/lib/index.js';

const terminal = pty.spawn('/bin/cat', [], { name: 'xterm-256color', cols: 80, rows: 24, encoding: null });
let output = Buffer.alloc(0);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PTY output timed out')), 5000);
    const input = terminal.onData(bytes => {
      output = Buffer.concat([output, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
      if (output.toString('utf8').includes('日本語の入力テスト')) { clearTimeout(timeout); input.dispose(); resolve(); }
    });
    terminal.write('日本語の入力テスト\n');
  });
  terminal.resize(100, 30);
  assert.equal(terminal.cols, 100);
  assert.equal(terminal.rows, 30);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PTY exit timed out')), 5000);
    terminal.onExit(() => { clearTimeout(timeout); resolve(); });
    terminal.kill('SIGKILL');
  });
  console.log('Passed: Electron ABI native PTY load, Japanese bytes, resize and process exit. No agent or AI request was started.');
} finally { try { terminal.kill('SIGKILL'); } catch { /* Already exited. */ } }
