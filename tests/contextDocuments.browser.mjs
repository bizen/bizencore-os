import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: String.raw`
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskInspector } from './src/components/task/TaskInspector';
    import { Picker } from './mcp-app/Picker';
    import { attachmentFrom, contextStorageError } from './src/lib/attachments';
    const noop = () => {};
    const source = '# コンテキスト資料の設計\n\n## 合意した方針\n\n全文を読めるようにし、**同じ資料を更新**します。\n\n- 日誌は作らない\n- アプリ内で編集しない\n\n| 操作 | 振る舞い |\n| --- | --- |\n| 更新 | 本文を置換 |\n| 追記 | 同じ資料に補足 |\n\n' + '十分に長い文章でも全文を保持する。'.repeat(400) + '\n\n末尾の確認文字列\n\n[危険リンク](javascript:alert(1))\n\n![外部画像](https://tracker.invalid/pixel.png)\n\n<script>window.injected = true</script>\n\n~~~js\nconst document = "safe";\n~~~';
    globalThis.sourceText = source;
    const document = { id: 'doc', kind: 'text', title: 'コンテキスト資料の閲覧・更新方針', text: source, by: 'ai', createdAt: 1, revision: 0 };
    const task = { id: 'task', type: 'task', text: 'コンテキスト資料を読む', done: false, order: 0, parentId: null, createdAt: 1, updatedAt: 1, attachments: [document] };
    function WebFixture() {
      const [item, setItem] = useState(task);
      globalThis.updateDocumentFixture = () => setItem(previous => ({ ...previous, attachments: [{ ...document, text: '# 更新された本文\n\n新しい内容', revision: 1 }] }));
      return <TaskInspector item={item} items={{ task: item }} initialFocus="title" todayDate="2026-10-05"
        onClose={() => globalThis.closeCount++} onTextChange={noop} onNoteChange={noop} onCompletionCriteriaChange={noop}
        onSetDeadline={noop} onToggleToday={noop} onSetLocked={noop} onSetEstimate={noop} onSetKind={noop} onRemove={noop} onRemoveAttachment={noop}
        onAddAttachment={(id, input) => {
          const attachment = attachmentFrom(input, 'human', 'new', 2);
          if (!attachment || contextStorageError([...item.attachments, attachment])) return false;
          setItem(previous => ({ ...previous, attachments: [...previous.attachments, attachment] })); return true;
        }} />;
    }
    const client = { connect: async () => {}, page: async () => ({ items: [task], today_date: '2026-10-05' }),
      detail: async () => ({ ...task, attachments: [document] }), send: async () => {}, open: async () => {} };
    globalThis.closeCount = 0;
    createRoot(window.document.getElementById('root')).render(location.pathname === '/app' ? <Picker client={client} /> : <WebFixture />);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({}) },
});
const css = await readFile('src/index.css', 'utf8');
const pickerCss = await readFile('mcp-app/style.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('bizencore.theme', new URLSearchParams(location.search).get('theme') || 'black');
    globalThis.copies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (globalThis.failCopy) throw new Error('Denied'); globalThis.copies.push(text);
    } } });
  });
  await page.route('**/*', route => {
    if (route.request().url().startsWith('https://bizencore.test/')) return route.fulfill({ contentType: 'text/html', body: `<style>${css}\n${pickerCss}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` });
    externalRequests.push(route.request().url()); return route.abort();
  });
  const preview = () => page.getByRole('button', { name: 'コンテキスト資料の閲覧・更新方針の全文を開く', exact: true });
  const viewer = () => page.getByRole('dialog', { name: 'コンテキスト資料の閲覧・更新方針', exact: true });
  for (const theme of ['black', 'white', 'original']) for (const width of [1280, 390, 320]) for (const host of ['web', 'app']) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`https://bizencore.test/${host}?theme=${theme}`);
    if (host === 'web') await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    else await page.getByRole('button', { name: 'コンテキスト資料を読む', exact: true }).click();
    try { await preview().waitFor({ timeout: 5000 }); }
    catch (error) { console.error({ theme, width, host, errors, body: await page.locator('body').innerText() }); throw error; }
    assert.equal(await preview().locator('.context-text').evaluate(el => el.scrollHeight > el.clientHeight), true);
    await preview().click();
    await viewer().waitFor();
    await page.getByRole('heading', { name: '合意した方針', exact: true }).waitFor();
    assert.equal(await viewer().locator('table').count(), 1);
    assert.equal(await viewer().locator('img, script, textarea, [contenteditable="true"]').count(), 0);
    assert.equal(await viewer().locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await viewer().locator('article').innerText().then(text => text.includes('末尾の確認文字列')), true);
    assert.equal(await viewer().evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1;
    }), true);
    assert.notEqual(await viewer().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: '本文をコピー', exact: true }).click();
    assert.equal(await page.evaluate(() => copies.at(-1) === sourceText), true);
    if (theme === 'black' && width === 390) {
      for (const [name, extension] of [['Markdownをダウンロード', 'md'], ['テキストをダウンロード', 'txt']]) {
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name, exact: true }).click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), `コンテキスト資料の閲覧・更新方針.${extension}`);
        assert.equal(await readFile(await download.path(), 'utf8'), await page.evaluate(() => sourceText));
      }
      await page.evaluate(() => { globalThis.failCopy = true; });
      await page.getByRole('button', { name: '本文をコピー', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'コピーできませんでした' }).waitFor();
      await page.evaluate(() => { globalThis.failCopy = false; });
    }
    if (theme === 'black' && [1280, 390].includes(width)) await page.screenshot({ path: `/private/tmp/bizencore-context-${host}-${width}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '資料を閉じる', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await viewer().evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    assert.equal(await viewer().count(), 0);
    assert.equal(await preview().evaluate(el => document.activeElement === el), true);
    if (host === 'web') assert.equal(await page.evaluate(() => closeCount), 0);
    else assert.equal(await page.getByRole('dialog', { name: 'タスク詳細', exact: true }).count(), 1);
  }
  await page.goto('https://bizencore.test/web');
  await preview().click();
  await page.evaluate(() => globalThis.updateDocumentFixture());
  await page.getByRole('heading', { name: '更新された本文', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const input = page.getByRole('textbox', { name: 'コンテキストを添える', exact: true });
  await input.fill('x'.repeat(100001));
  await input.press('Enter');
  await page.getByRole('alert').filter({ hasText: '100,000' }).waitFor();
  assert.equal((await input.inputValue()).length, 100001);
  await input.fill('貼り付けた新しい資料\n\n本文');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '');
  await page.getByRole('button', { name: '貼り付けた新しい資料の全文を開く', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: '貼り付けた新しい資料', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => Boolean(globalThis.injected)), false);
  assert.equal(externalRequests.some(url => url.includes('tracker.invalid')), false);
  console.log('Passed: Web and MCP Apps context reader, 3 themes at 1280/390/320, Markdown, safe links/images/HTML, full-text copy and md/txt download, modal keyboard focus/Escape, live updates, long-paste errors and document creation.');
} finally { await browser.close(); }
