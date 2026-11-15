import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function validationEnabled(argv, config) {
  return argv.includes('--validate-runtime') &&
    config.convexUrl === 'https://dazzling-setter-393.convex.cloud' &&
    config.clerkHost === 'grown-gorilla-52.clerk.accounts.dev';
}

export function timingSample(value) {
  if (!value || !['key', 'event', 'input-frame', 'terminal-frame', 'composition'].includes(value.kind) ||
    !['task', 'terminal'].includes(value.surface) || !Number.isFinite(value.ms) || value.ms < 0 || value.ms > 30000) {
    throw new Error('Invalid validation sample');
  }
  const sample = { kind: value.kind, surface: value.surface, ms: Math.round(value.ms * 10) / 10 };
  if (value.start !== undefined) {
    if (!Number.isFinite(value.start) || value.start < 0) throw new Error('Invalid sample timestamp');
    sample.start = Math.round(value.start * 10) / 10;
  }
  return sample;
}

export function blockValidationRequest(offline, url) {
  return offline === true && /^https?:|^wss?:/.test(url) &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}

export function createRuntimeValidation() {
  const directory = mkdtempSync(path.join(tmpdir(), 'bizencore-runtime-validation-'));
  const file = path.join(directory, 'report.jsonl');
  let phase = 'baseline';
  let pauseRefresh = false;
  let offline = false;
  let samples = 0;
  const log = (kind, details = {}) => appendFileSync(file, `${JSON.stringify({ at: Date.now(), phase, kind, ...details })}\n`, { mode: 0o600 });
  log('started');
  return {
    file, log,
    state: () => ({ pauseRefresh, offline }),
    offline(value) { offline = value === true; log('offline', { value: offline }); },
    pause(value) { pauseRefresh = value; log('refresh-paused', { value }); },
    phase(value) { phase = value; log('phase'); },
    sample(value) { if (samples++ < 10000) log('timing', timingSample(value)); },
  };
}
