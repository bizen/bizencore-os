import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/taskContextDrop.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { hasContextDrop, readContextDrop } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const data = (values, files = [], types = Object.keys(values)) => ({ files, types, getData: type => values[type] ?? '' });

test('URI lists handle comments, duplicates and canonical HTTP links', () => {
  assert.deepEqual(readContextDrop(data({ 'text/uri-list': '# source\r\nhttps://example.test\r\nhttps://example.test/\r\nhttps://example.test/two' })),
    { files: [], urls: ['https://example.test/', 'https://example.test/two'] });
});

test('plain text links are accepted without interpreting prose or HTML', () => {
  assert.deepEqual(readContextDrop(data({ 'text/plain': ' https://example.test/path?q=a ' })).urls, ['https://example.test/path?q=a']);
  for (const value of ['hello https://example.test', 'https://example.test\nnotes', '<a href="https://example.test">link</a>']) {
    assert.deepEqual(readContextDrop(data({ 'text/plain': value })).urls, []);
  }
  assert.deepEqual(readContextDrop(data({ 'text/html': '<img src="https://example.test/tracking"><a href="https://example.test">link</a>' })).urls, []);
});

test('unsafe schemes, embedded credentials, malformed URLs and excess text are rejected', () => {
  for (const url of ['file:///private/secret', 'javascript:alert(1)', 'data:text/html,test', 'https://', 'https://user:password@example.test', 'https://example.test/' + 'a'.repeat(100000)]) {
    assert.deepEqual(readContextDrop(data({ 'text/uri-list': url })).urls, []);
  }
});

test('files win over accompanying links and are copied synchronously', () => {
  const files = [{ name: 'screenshot.png' }, { name: 'notes.pdf' }];
  const result = readContextDrop(data({ 'text/uri-list': 'file:///tmp/screenshot.png', 'text/plain': 'https://example.test' }, files, ['Files', 'text/uri-list', 'text/plain']));
  files.pop();
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.urls, []);
  assert.deepEqual(readContextDrop(data({ 'text/plain': 'https://example.test' }, [], ['Files', 'text/plain'])), { files: [], urls: [] });
});

test('hover checks only exposed types, never reads protected drag data', () => {
  for (const type of ['Files', 'text/uri-list', 'text/plain']) assert.equal(hasContextDrop([type]), true);
  assert.equal(hasContextDrop(['text/html', 'application/x-internal-task']), false);
});
