import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('terminal timing follows the visible viewport rather than the TUI footer cursor', async () => {
  const samples = [];
  const callbacks = [];
  const previous = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.window = { bizencoreDesktop: { validation: { sample: async value => samples.push(value) } } };
  globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
  try {
    const { outputFiles } = await build({ entryPoints: ['desktop/validation.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
    const { validateTerminalInput } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
    let render;
    let key;
    let disposed = false;
    const rows = ['> ', 'footer'];
    const terminal = {
      rows: 2, buffer: { active: { baseY: 0, cursorY: 1, getLine: row => ({ translateToString: () => rows[row] }) } },
      onRender: callback => { render = callback; return { dispose: () => { disposed = true; } }; },
    };
    const host = { addEventListener: (_name, callback) => { key = callback; }, removeEventListener: () => {} };
    const validation = validateTerminalInput(terminal, host);
    key({ isTrusted: true, timeStamp: performance.now() });
    validation.input('a');
    render();
    assert.equal(callbacks.length, 0, 'no sample before a visible update');
    rows[0] = '> a';
    render();
    while (callbacks.length) callbacks.shift()();
    assert.equal(samples.length, 1);
    assert.equal(samples[0].kind, 'terminal-frame');
    assert.equal(Object.values(samples[0]).includes('a'), false, 'no input contents in report');
    validation.input('\r');
    rows[0] = 'other output';
    render();
    assert.equal(callbacks.length, 0, 'commands/control keys are excluded');
    validation.dispose();
    assert.equal(disposed, true);
  } finally {
    globalThis.window = previous.window;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  }
});
