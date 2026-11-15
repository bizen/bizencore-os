import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { blockValidationRequest, createRuntimeValidation, timingSample, validationEnabled } from '../desktop/electron/runtime-validation.mjs';

test('offline validation cancels remote requests but preserves local assets and MCP probes', () => {
  for (const url of ['https://example.com/query', 'wss://example.com/sync', 'http://example.com/', 'ws://example.com/']) {
    assert.equal(blockValidationRequest(true, url), true);
    assert.equal(blockValidationRequest(false, url), false);
  }
  for (const url of ['file:///tmp/index.html', 'bizencore://app/', 'http://127.0.0.1:5211/', 'http://localhost:5211/', 'http://[::1]:5211/']) {
    assert.equal(blockValidationRequest(true, url), false);
  }
  const report = createRuntimeValidation();
  assert.equal(report.state().offline, false);
  report.offline(true);
  assert.equal(report.state().offline, true);
  report.offline(false);
  assert.equal(report.state().offline, false);
});

test('runtime validation is explicit and restricted to pinned development services', () => {
  const config = { convexUrl: 'https://dazzling-setter-393.convex.cloud', clerkHost: 'grown-gorilla-52.clerk.accounts.dev' };
  assert.equal(validationEnabled([], config), false);
  assert.equal(validationEnabled(['--validate-runtime'], config), true);
  assert.equal(validationEnabled(['--validate-runtime'], { ...config, convexUrl: 'https://good-chinchilla-15.convex.cloud' }), false);
  assert.equal(validationEnabled(['--validate-runtime'], { ...config, clerkHost: 'clerk.bizencore.com' }), false);
});

test('timing reports retain only bounded metadata and no input contents', () => {
  assert.deepEqual(timingSample({ kind: 'event', surface: 'task', ms: 24, token: 'secret', text: 'private' }), { kind: 'event', surface: 'task', ms: 24 });
  for (const ms of [NaN, Infinity, -1, 30001]) assert.throws(() => timingSample({ kind: 'event', surface: 'task', ms }));
  assert.throws(() => timingSample({ kind: 'token', surface: 'task', ms: 1 }));
  const report = createRuntimeValidation();
  report.sample({ kind: 'event', surface: 'task', ms: 24, text: 'private' });
  assert.equal(readFileSync(report.file, 'utf8').includes('private'), false);
  assert.equal(statSync(report.file).mode & 0o777, 0o600);
});
