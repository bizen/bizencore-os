import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProcesses, selectAppTree, cpuPercent, appProcessMetrics } from '../desktop/electron/measure-load.mjs';

test('load probe parses CPU time and selects only the app and descendants', () => {
  const rows = parseProcesses(`
    1 0 9999 00:10.00 /unrelated
    20 1 102400 01:02.50 /fixture/bizencore Electron Preview.app/Contents/MacOS/bizencore Electron Preview
    21 20 20480 00:04.00 /fixture/bizencore Electron Preview.app/Contents/Frameworks/Helper
    22 20 51200 00:03.00 /fixture/codex
    23 22 1024 00:00.20 /bin/tool
    24 1 9999 1-02:03:04.50 /unrelated
  `);
  assert.equal(rows[1].cpuSeconds, 62.5);
  assert.equal(rows[5].cpuSeconds, 93784.5);
  assert.equal(rows[1].rssMiB, 100);
  const tree = selectAppTree(rows);
  assert.deepEqual(tree.app.map(row => row.pid), [20, 21]);
  assert.deepEqual(tree.agents.map(row => row.pid), [22, 23]);
  assert.deepEqual(tree.sessions.map(row => row.pid), [22]);
});

test('load probe counts agent session roots, not their build tools or unrelated CLIs', () => {
  const rows = parseProcesses(`
    20 1 100 00:01.00 /fixture/bizencore Electron Preview.app/Contents/MacOS/bizencore Electron Preview
    21 20 100 00:01.00 /fixture/claude
    22 20 100 00:01.00 /fixture/codex
    23 22 100 00:01.00 /fixture/codex
    24 21 100 00:01.00 node
    25 1 100 00:01.00 /fixture/claude
  `);
  assert.deepEqual(selectAppTree(rows).sessions.map(row => row.pid), [21, 22]);
});

test('load CPU uses interval deltas and excludes newly observed processes', () => {
  assert.equal(cpuPercent([{ pid: 1, cpuSeconds: 12 }, { pid: 2, cpuSeconds: 500 }], [{ pid: 1, cpuSeconds: 10 }], 2), 100);
  assert.equal(cpuPercent([{ pid: 1, cpuSeconds: 1 }], [{ pid: 1, cpuSeconds: 10 }], 1), 0);
  assert.equal(cpuPercent([], [], 0), null);
});

test('per-process probe distinguishes renderer cost without exporting paths or arguments', () => {
  const rows = [{ pid: 42, executable: '/private/app/Helper (Renderer)', rssMiB: 123, cpuSeconds: 11 }];
  assert.deepEqual(appProcessMetrics(rows, [{ pid: 42, cpuSeconds: 10 }], 2), [{ pid: 42, name: 'Helper (Renderer)', rssMiB: 123, cpuPercent: 50 }]);
  assert.equal(appProcessMetrics(rows, undefined, 0)[0].cpuPercent, null);
});
