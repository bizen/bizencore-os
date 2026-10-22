import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/lib/mascotStyle.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { readMascotStyle, saveMascotStyle } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('mascot style defaults to matte, remembers both choices and tolerates unavailable storage', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let value;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => value,
    setItem: (key, next) => { assert.equal(key, 'bizencore.mascotStyle'); value = next; },
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  for (value of [undefined, 'invalid', '{}']) assert.equal(readMascotStyle(), 'matte');
  for (const style of ['flat', 'matte']) {
    saveMascotStyle(style);
    assert.equal(readMascotStyle(), style);
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
  assert.equal(readMascotStyle(), 'matte');
  assert.doesNotThrow(() => saveMascotStyle('flat'));
});
