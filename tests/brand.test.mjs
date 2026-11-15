import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(), loader: 'tsx',
    contents: "export { Brand } from './src/components/Brand'; export { SplashScreen } from './src/components/SplashScreen';",
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  jsx: 'automatic', loader: { '.png': 'dataurl' },
});
const { Brand, SplashScreen } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('web brand and splash retain their existing name without an exponent', () => {
  for (const component of [Brand, SplashScreen]) {
    const html = renderToStaticMarkup(createElement(component, {}));
    assert.ok(html.includes('aria-label="bizencore terminal"'));
    assert.ok(!html.includes('brand-power'));
  }
});

test('desktop header and splash use a superscript without changing the core italic', () => {
  for (const component of [Brand, SplashScreen]) {
    const html = renderToStaticMarkup(createElement(component, { desktop: true }));
    assert.ok(html.includes('aria-label="bizencore terminal squared"'));
    assert.ok(html.includes('<i>core</i>'));
    assert.ok(html.includes('terminal<sup class="brand-power" aria-hidden="true">2</sup>'));
  }
});
