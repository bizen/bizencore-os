import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: ['src/lib/mcpClientName.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { mcpClientName } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('known MCP clients have precise names without mislabelling embedded CLIs as desktop apps', () => {
  assert.equal(mcpClientName('desktop-codex', 'Codex'), 'Codex CLI（bizencore内）');
  assert.equal(mcpClientName('desktop-claude', 'Claude Code'), 'Claude Code CLI（bizencore内）');
  assert.equal(mcpClientName('https://antigravity.google/oauth/client-metadata.json'), 'Antigravity');
  assert.equal(mcpClientName('https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code'), 'Claude Code CLI');
  assert.equal(mcpClientName('6NYjoHO5P6IXohgZ', 'Cursor'), 'Cursor');
});

test('explicit CLI/Desktop identity wins over generic OAuth application names', () => {
  const id = 'https://chatgpt.com/oauth/codex/client.json';
  assert.equal(mcpClientName(id, 'Codex'), 'Codex（CLI／Desktop未判別）');
  assert.equal(mcpClientName(id, 'Codex', 'codex-cli'), 'Codex CLI');
  assert.equal(mcpClientName(id, 'Codex', 'Codex Desktop'), 'Codex Desktop');
  assert.equal(mcpClientName('https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude'), 'Claude（Web／Desktop未判別）');
  assert.equal(mcpClientName('https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude', 'Claude Desktop'), 'Claude Desktop');
  assert.equal(mcpClientName('custom', 'Claude Code Desktop'), 'Claude Code Desktop');
});

test('custom client names are preserved and lookalike URLs are not classified', () => {
  assert.equal(mcpClientName('https://chatgpt.com/oauth/client.json', 'ChatGPT Team'), 'ChatGPT Team');
  for (const id of ['__proto__', 'https://antigravity.google.evil.test/oauth/client-metadata.json']) assert.equal(mcpClientName(id), id);
  assert.equal(mcpClientName('custom', '  My client  '), 'My client');
});
