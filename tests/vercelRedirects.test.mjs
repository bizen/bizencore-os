import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const { redirects } = JSON.parse(await readFile('vercel.json', 'utf8'));
const ruleFor = host => redirects.filter(rule => rule.has?.some(item => item.type === 'host' && item.value === host));

test('chrct.com and www.chrct.com move permanently to terminal.bizencore.com', () => {
  for (const host of ['chrct.com', 'www.chrct.com']) {
    const rules = ruleFor(host);
    assert.equal(rules.length, 1);
    assert.deepEqual([rules[0].source, rules[0].destination, rules[0].permanent], ['/:path*', 'https://terminal.bizencore.com/:path*', true]);
  }
  assert.deepEqual(ruleFor('terminal.bizencore.com'), []);
});

test('app.bizencore.com redirects pages but keeps serving MCP, OAuth, Grok Bot and worker paths', () => {
  const [rule, ...rest] = ruleFor('app.bizencore.com');
  assert.deepEqual(rest, []);
  assert.equal(rule.destination, 'https://terminal.bizencore.com/:path');
  assert.equal(rule.permanent, true);
  const pattern = new RegExp(`^${/^\/:path\((.*)\)$/.exec(rule.source)[1]}$`);
  const redirected = path => pattern.test(path.slice(1));
  for (const path of ['/', '/count', '/index.html', '/task-actions/request-1', '/mcp-guide', '/apis', '/grok-botx',
    '/manifest.webmanifest', '/icons/icon-512.png', '/well-known/x']) assert.equal(redirected(path), true, path);
  for (const path of ['/mcp', '/mcp/', '/api/mcp', '/api/grok-bot-oauth', '/grok-bot/mcp/a-1', '/grok-bot/token/a-1',
    '/grok-bot/register/a-1', '/grok-bot/authorize', '/grok-bot/oauth/a-1/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource/grok-bot/mcp/a-1', '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/grok-bot/oauth/a-1', '/notifications-sw.js', '/version.json']) {
    assert.equal(redirected(path), false, path);
  }
});
