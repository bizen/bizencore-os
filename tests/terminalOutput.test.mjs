import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalOutput } from '../desktop/electron/terminal-output.mjs';

function fixture() {
  const packets = [];
  const timers = new Map();
  let timerId = 0, pauses = 0, resumes = 0;
  const output = new TerminalOutput({
    send: (sequence, bytes) => packets.push({ sequence, bytes }),
    pause: () => pauses++, resume: () => resumes++,
    schedule: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    cancel: id => timers.delete(id),
  });
  return { output, packets, timers, get pauses() { return pauses; }, get resumes() { return resumes; },
    tick() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(callback => callback()); },
  };
}

test('terminal output coalesces bursts and preserves byte order across UTF-8 chunks', () => {
  const f = fixture();
  const expected = Buffer.from('日本語\r\n\x1b[32mOK\x1b[0m');
  for (const byte of expected) f.output.push(Buffer.from([byte]));
  assert.equal(f.timers.size, 1);
  assert.equal(f.packets.length, 0);
  f.tick();
  assert.equal(f.packets.length, 1);
  assert.deepEqual(f.packets[0].bytes, expected);
  f.output.acknowledge(1);
  assert.equal(f.output.inFlight, null);
});

test('terminal output permits only one bounded packet until the matching acknowledgement', () => {
  const f = fixture();
  const expected = Buffer.alloc(180000, 123);
  f.output.push(expected);
  f.tick();
  assert.equal(f.packets[0].bytes.length, 65536);
  f.output.acknowledge(999);
  f.tick();
  assert.equal(f.packets.length, 1);
  f.output.acknowledge(1);
  f.tick();
  f.output.acknowledge(1);
  f.tick();
  assert.equal(f.packets.length, 2, 'duplicate acknowledgements cannot drain newer packets');
  f.output.acknowledge(2);
  f.tick();
  f.output.acknowledge(3);
  assert.deepEqual(Buffer.concat(f.packets.map(packet => packet.bytes)), expected);
});

test('terminal output pauses backlog and resumes only below the low watermark', () => {
  const f = fixture();
  f.output.push(Buffer.alloc(300000));
  assert.equal(f.pauses, 1);
  f.tick();
  for (let sequence = 1; sequence <= 2; sequence++) { f.output.acknowledge(sequence); f.tick(); }
  assert.equal(f.resumes, 0);
  f.output.acknowledge(3);
  assert.equal(f.resumes, 1);
  f.tick();
  f.output.acknowledge(4); f.tick(); f.output.acknowledge(5);
  assert.equal(f.pauses, 1);
  assert.equal(f.output.queued, 0);
});

test('normal exit drains pending output before the exit event without resuming a dead PTY', () => {
  const f = fixture();
  f.output.push(Buffer.alloc(300000, 42));
  let completed = 0;
  f.output.finish(() => completed++);
  f.tick();
  assert.equal(completed, 0);
  for (let sequence = 1; sequence <= 5; sequence++) { f.output.acknowledge(sequence); f.tick(); }
  assert.equal(completed, 1);
  assert.equal(f.resumes, 0);
  assert.equal(Buffer.concat(f.packets.map(packet => packet.bytes)).length, 300000);
  f.output.finish(() => completed++);
  assert.equal(completed, 1);
});

test('stop or logout cancels pending timers and drops buffered output', () => {
  const f = fixture();
  f.output.push(Buffer.from('private output'));
  f.output.dispose();
  f.tick();
  f.output.push(Buffer.from('late output'));
  f.output.acknowledge(1);
  assert.equal(f.packets.length, 0);
  assert.equal(f.output.queued, 0);
  assert.equal(f.timers.size, 0);
});

test('normal exit without pending output completes immediately', () => {
  const f = fixture();
  let completed = 0;
  f.output.finish(() => completed++);
  assert.equal(completed, 1);
  assert.equal(f.timers.size, 0);
});
