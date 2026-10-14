import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { desktopContentPolicy } from '../desktop/electron/content-policy.mjs';
import { profiles } from '../desktop/electron/release-config.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const profile = profiles.production;
const csp = desktopContentPolicy({ channel: 'production', convexUrl: profile.convexUrl, clerkHost: profile.clerkHost });
const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { TaskFileInput } from './src/components/task/TaskFileContext';
  function Fixture() {
    const [attachments, setAttachments] = useState([]);
    return <><TaskFileInput taskId="smoke-task" disabled={false} attachmentIds={attachments}
      onUploaded={file => { setAttachments(previous => [...previous, file.id]); return true; }} />
      <output>{attachments.length}</output></>;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
` }, bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: profile.convexUrl }) },
  plugins: [{ name: 'fixture-auth', setup(builder) {
    builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useAuth = () => ({ isSignedIn:true, userId:'fixture', sessionClaims:{aud:'convex'}, getToken:async()=> 'fixture-token' });` }));
  } }],
});
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  const page = await browser.newPage();
  let calls = 0; let policy = csp;
  await page.route('**/*', async route => {
    const request = route.request(); const url = request.url();
    if (url === `${profile.convexUrl.replace('.cloud', '.site')}/files/upload`) {
      if (request.method() === 'OPTIONS') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-task-id, x-file-name', 'Access-Control-Allow-Methods': 'POST' } });
      calls++; assert.equal(request.headers().authorization, 'Bearer fixture-token');
      return route.fulfill({ json: { id: `fixture-${calls}`, storageId: `storage-${calls}` }, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (url === 'https://upload-csp.test/app.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
    if (url === 'https://upload-csp.test/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: '<div id="root"></div><script src="/app.js"></script>' });
    return route.abort();
  });
  const file = { name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('no personal data') };
  policy = csp.replace(` ${profile.convexUrl.replace('.cloud', '.site')}`, '');
  await page.goto('https://upload-csp.test/');
  await page.getByLabel('ファイルを選ぶ').setInputFiles(file);
  await page.getByRole('alert').waitFor();
  assert.equal(calls, 0, 'old native policy blocks the file site before network transmission');
  policy = csp;
  await page.reload();
  await page.getByLabel('ファイルを選ぶ').setInputFiles([file, { ...file, name: 'second.txt' }]);
  await page.waitForFunction(() => document.querySelector('output').textContent === '2');
  assert.equal(calls, 2);
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Native CSP regression: old policy blocks uploads; fixed pinned file site supports both sequential attachments. No production request sent.');
} finally { await browser.close(); }
