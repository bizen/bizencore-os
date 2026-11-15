import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['api/_lib/mcpServer.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createBizencoreMcp } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('MCP initialization advertises the public Cirno app icon without accessing task data', async () => {
  const { handler } = createBizencoreMcp({ signingKey: new Uint8Array(32).fill(1), readApp: async () => '',
    fetchData: async () => { throw new Error('Initialization must not access task data'); } });
  for (const protocolVersion of ['2025-06-18', '2025-11-25']) {
    const response = await handler(new Request('https://fixture.test/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion, capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
      } }),
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: ')).slice(6) : text);
    const info = body.result.serverInfo;
    assert.equal(info.name, 'bizencore');
    assert.deepEqual(info.icons, [{ src: 'https://app.bizencore.com/icons/icon-512.png?v=cirno-1', mimeType: 'image/png', sizes: ['512x512'] }]);
    const png = await readFile(`public${new URL(info.icons[0].src).pathname}`);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
  }
});
