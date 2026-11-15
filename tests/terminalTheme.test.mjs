import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['desktop/terminal-theme.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { readTerminalTheme } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const luminance = color => {
  const linear = color.slice(1).match(/../g).map(hex => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};
const ansiKeys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

for (const [theme, background, foreground, accent, rgb] of [
  ['white', '#f6f8fa', '#17212b', '#2864ba', '40, 100, 186'],
  ['black', '#0a0b0c', '#f1f2f2', '#8cb8ed', '140, 184, 237'],
  ['original', '#121620', '#e2e8f0', '#3b82f6', '59, 130, 246'],
]) test(`terminal ${theme} inherits workspace tokens and supplies an ANSI palette`, () => {
  const oldDocument = globalThis.document;
  const oldStyle = globalThis.getComputedStyle;
  const root = { dataset: { theme } };
  const tokens = { '--bg-color': background, '--text-primary': foreground, '--accent-color': accent, '--accent-rgb': rgb };
  globalThis.document = { documentElement: root };
  globalThis.getComputedStyle = element => {
    assert.equal(element, root);
    return { getPropertyValue: name => ` ${tokens[name]} ` };
  };
  try {
    const palette = readTerminalTheme();
    assert.equal(palette.background, background);
    assert.equal(palette.foreground, foreground);
    assert.equal(palette.cursor, accent);
    assert.equal(palette.cursorAccent, background);
    assert.equal(palette.selectionBackground, `rgba(${rgb}, ${theme === 'white' ? '0.22' : '0.3'})`);
    for (const key of ansiKeys) {
      assert.match(palette[key], /^#[\da-f]{6}$/i);
      if (theme === 'white') {
        const contrast = (luminance(background) + 0.05) / (luminance(palette[key]) + 0.05);
        assert.ok(contrast >= 4.5, `${key} must remain legible on a white terminal: ${contrast}`);
      }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldStyle;
  }
});
