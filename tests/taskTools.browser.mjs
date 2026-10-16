import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import { createRoot } from 'react-dom/client';
  import { useEffect, useState } from 'react';
  import { taskStore } from './src/lib/taskStore';
  const fixture = window.__tools = { calls: [], pending: null, hang: false, inputs: [], stopped: [], done: [] };
  const listeners = new Set();
  const launches = new Map();
  const source = id => {
    const item = taskStore.getState().items[id];
    return { id, text: item.text, done: item.done, note: item.note, locked: item.locked, completion_criteria: item.completionCriteria,
      attachments: item.attachments?.filter(a => !a.deletedAt), subtasks: Object.values(taskStore.getState().items).filter(item => !item.deletedAt && item.parentId === id).map(item => source(item.id)) };
  };
  const response = request => {
    const children = Object.values(taskStore.getState().items).filter(item => item.parentId === request.taskId);
    const steps = request.mode === 'decompose' ? [
      { text: 'AI draft', owner: 'ai', existingTaskId: children.find(item => item.note?.startsWith('担当: AI'))?.id ?? '', note: 'Make draft', completionCriteria: 'Draft checked' },
      { text: 'Human choice', owner: 'human', existingTaskId: children.find(item => item.note?.startsWith('担当: 人間'))?.id ?? '', note: 'Choose option', completionCriteria: 'User chooses' },
    ] : [];
    const waiting = request.mode === 'execute' && request.taskId === 'a' && !request.reply;
    if (request.mode === 'execute' && (request.taskId === 'b' || request.reply || fixture.done.includes(request.taskId))) taskStore.update(request.taskId, { done: true, completedBy: 'ai' });
    return { result: { status: waiting ? 'waiting' : 'completed', summary: waiting ? '確認が必要です' : '結果を確認しました', questions: waiting ? ['対象範囲はどこですか？'] : [], steps }, taskDone: taskStore.getState().items[request.taskId].done, sourceTask: source(request.taskId) };
  };
  const review = request => {
    if (fixture.hang) return new Promise((resolve, reject) => { fixture.pending = { resolve: () => resolve(response(request)), reject }; });
    return response(request);
  };
  window.bizencoreDesktop = { mcpSupported: true, folder: async () => '/fixture/project', taskRun: async request => {
    fixture.calls.push(request);
    return review(request);
  }, taskStop: async () => { fixture.pending?.reject(new Error('停止しました')); fixture.pending = null; },
    start: async args => {
      const request = { ...args, mode: 'execute', taskId: args.orchestration.taskId, reply: args.orchestration.reply };
      launches.set(args.id, request); fixture.calls.push(request);
      for (const listener of listeners) listener(args.id, { kind:'data', bytes: Array.from(new TextEncoder().encode('LIVE CLI: ' + request.taskId + '\\r\\nType your reply here.\\r\\n')) });
      return 123;
    }, taskReview: async id => review(launches.get(id)),
    onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    write: async (id, data) => { fixture.inputs.push({id,data}); }, resize: async () => {},
    stop: async id => { fixture.stopped.push(id); for (const listener of listeners) listener(id, { kind:'exit',code:null }); fixture.pending?.reject(new Error('停止しました')); fixture.pending = null; },
  };
  (async () => {
    const { TaskTools } = await import('./desktop/TaskTools');
    function Harness() {
      const [fontSize, setFontSize] = useState(13);
      useEffect(() => { fixture.setFontSize = setFontSize; }, []);
      return <TaskTools storageKey="fixture.task-tools" fontSize={fontSize} available={[{ id:'codex', name:'Codex', path:'/mock/codex', version:'1' }, { id:'claude', name:'Claude Code', path:'/mock/claude', version:'1' }]} cwd="/fixture/project" busy={false} intent={{ mode:'execute',ids:[],serial:0 }} hidden={false} onClose={()=>{}} onCwd={()=>{}} onBusy={()=>{}} onOpenTask={id => { fixture.openedTask = id; }} />;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  })();
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
const css = await readFile('src/index.css', 'utf8') + await readFile('desktop/workspace.css', 'utf8') + await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const html = `<style>${css}body{overflow:auto}.task-tools{max-width:520px;margin:auto}</style><div id="root"></div><script>${outputFiles[0].text}</script>`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.addInitScript(() => {
    if (localStorage.getItem('chrct.tasks.v2')) return;
    localStorage.setItem('chrct.tasks.v2', JSON.stringify([
      { id: 'label-a', text: 'Label A', type: 'section', parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1 },
      { id: 'label-b', text: 'Label B', type: 'section', parentId: null, order: 1, done: false, createdAt: 1, updatedAt: 1 },
      ...[['a', 'Alpha task', 'label-a'], ['b', 'Beta task', 'label-b'], ['c', 'Gamma task', 'label-b'], ['d', 'Delta task', 'label-a'], ['e', 'Epsilon task', 'label-b']].map(([id, text, parentId], order) => ({ id, text, parentId, type: 'task', order, done: false, createdAt: 1, updatedAt: 1 })),
    ]));
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1/');
  const panel = page.getByRole('region', { name: 'タスク作業ツール' });
  await panel.waitFor();
  await panel.getByRole('combobox', { name: '作業対象のラベル' }).selectOption('label-a');
  await panel.getByRole('checkbox', { name: /Alpha task/ }).check();
  await panel.getByRole('combobox', { name: '作業対象のラベル' }).selectOption('label-b');
  await panel.getByRole('checkbox', { name: /Beta task/ }).check();
  await panel.getByRole('checkbox', { name: /Gamma task/ }).check();
  await panel.getByRole('combobox', { name: 'Gamma taskの担当' }).selectOption('claude');
  await panel.getByRole('button', { name: '確認して開始', exact: true }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 1);
  assert.equal(await panel.getByRole('region', { name: 'オーケストレーションのターミナル' }).isVisible(), true);
  const terminal = panel.getByRole('region', { name: 'オーケストレーションのターミナル' });
  assert.equal(await terminal.locator('header .agent-logo[data-agent="codex"]').count(), 1, 'orchestration identifies the running provider with its logo');
  await terminal.getByRole('button', { name: '担当タスクの詳細を開く', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__tools.openedTask), 'a', 'orchestration details open the currently assigned task');
  await terminal.getByRole('button', { name: '完了にする', exact: true }).click();
  assert.equal(await terminal.getByRole('button', { name: '未完了に戻す', exact: true }).getAttribute('aria-pressed'), 'true');
  await terminal.getByRole('button', { name: '未完了に戻す', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__tools.stopped.length), 0, 'manual task checks do not terminate the CLI');
  assert.equal(await page.evaluate(() => window.__tools.calls.length), 1, 'manual task checks do not launch or advance orchestration');
  assert.equal(await terminal.evaluate(element => getComputedStyle(element).borderRadius), '8px');
  assert.equal(await terminal.evaluate(element => getComputedStyle(element).borderWidth), '2px');
  assert.equal(await terminal.locator('.orchestration-terminal-host').evaluate(element => getComputedStyle(element).borderWidth), '0px', 'task information and CLI share a single outer frame');
  await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent.includes('LIVE CLI: a'));
  const rowHeight = await page.locator('.xterm-accessibility-tree > div').first().evaluate(node => node.getBoundingClientRect().height);
  await page.evaluate(() => window.__tools.setFontSize(18));
  await page.waitForFunction(height => document.querySelector('.xterm-accessibility-tree > div')?.getBoundingClientRect().height > height, rowHeight);
  assert.equal(await page.evaluate(() => window.__tools.calls.length), 1, 'font size updates the live terminal without relaunch');
  await page.evaluate(() => window.__tools.setFontSize(13));
  await page.waitForFunction(height => document.querySelector('.xterm-accessibility-tree > div')?.getBoundingClientRect().height === height, rowHeight);
  await page.screenshot({ path: '/private/tmp/bizencore-orchestration-live.png' });
  assert.equal(await page.evaluate(() => window.__tools.calls.length), 1, 'manual mode does not silently advance');
  await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 2);
  await terminal.locator('header .agent-logo[data-agent="claude"]').waitFor();
  await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 3);
  await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 3 && !document.querySelector('.task-tools-running'));
  assert.deepEqual(await page.evaluate(() => window.__tools.calls.map(value => [value.taskId, value.agent])), [['a','codex'],['b','claude'],['c','claude']]);
  const results = panel.locator('.task-tools-results article');
  assert.match(await results.nth(0).textContent(), /質問待ち/);
  assert.match(await results.nth(1).textContent(), /Claude Code · 完了/);
  assert.match(await results.nth(2).textContent(), /残作業あり/, 'model success without a checked task is partial');
  await panel.getByRole('textbox', { name: 'Alpha taskへの回答' }).fill('このプロジェクトのみ');
  await results.nth(0).getByRole('button', { name: '再確認して続ける' }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 4);
  await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).click();
  await page.waitForFunction(() => window.__tools.calls.length === 4 && !document.querySelector('.task-tools-running'));
  assert.match(await results.nth(0).textContent(), /Codex · 完了/);
  await page.screenshot({ path: '/private/tmp/bizencore-task-tools-execution.png' });
  await panel.getByRole('button', { name: 'タスクベース分解', exact: true }).click();
  await panel.getByRole('button', { name: '分担案を作成', exact: true }).click();
  await panel.getByRole('textbox', { name: '分担案1のタイトル' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chrct.tasks.v2')).filter(item => item.parentId === 'c').length), 0, 'proposals do not mutate tasks');
  await panel.getByRole('textbox', { name: '分担案1のタイトル' }).fill('AI draft revised');
  await panel.getByRole('button', { name: '確認して反映', exact: true }).click();
  await panel.getByRole('button', { name: '反映済み', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chrct.tasks.v2')).filter(item => item.parentId === 'c').length), 2);
  await panel.getByRole('button', { name: '分担案を作成', exact: true }).click();
  await panel.getByText('既存サブタスクを利用', { exact: true }).first().waitFor();
  await panel.getByRole('button', { name: '確認して反映', exact: true }).click();
  await panel.getByRole('button', { name: '反映済み', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chrct.tasks.v2')).filter(item => item.parentId === 'c').length), 2, 'repeated planning reuses subtasks');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chrct.tasks.v2')).find(item => item.id === 'c').attachments.length), 1, 'one updated context document, not journals');
  await page.screenshot({ path: '/private/tmp/bizencore-task-tools-decomposition.png' });
  await panel.getByRole('button', { name: 'オーケストレーション', exact: true }).click();
  await panel.getByRole('combobox', { name: '作業対象のラベル' }).selectOption('');
  await panel.getByRole('checkbox', { name: /Delta task/ }).check();
  await panel.getByRole('checkbox', { name: /Epsilon task/ }).check();
  await page.evaluate(() => { window.__tools.hang = true; });
  const before = await page.evaluate(() => window.__tools.calls.length);
  await panel.getByRole('button', { name: '確認して開始', exact: true }).click();
  await page.waitForFunction(before => window.__tools.calls.length === before + 1, before);
  await panel.getByRole('button', { name: 'このタスク後に一時停止' }).click();
  await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).click();
  await page.waitForFunction(() => window.__tools.pending !== null);
  await page.evaluate(() => { window.__tools.pending.resolve(); window.__tools.pending = null; });
  await panel.getByRole('button', { name: '未着手・中断を再開' }).waitFor();
  assert.equal(await page.evaluate(() => window.__tools.calls.length), before + 1, 'pause prevents the next launch');
  await panel.getByRole('button', { name: '未着手・中断を再開' }).click();
  await page.waitForFunction(before => window.__tools.calls.length === before + 2, before);
  await panel.getByRole('button', { name: '実行を停止', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.task-tools-running'));
  assert.match(await panel.locator('.task-tools-results').textContent(), /中断/);
  await page.evaluate(() => { window.__tools.hang = false; window.__tools.done = ['d','e']; });
  await panel.getByRole('button', { name: '選択解除', exact: true }).click();
  await panel.getByRole('checkbox', { name: /Delta task/ }).check();
  await panel.getByRole('combobox', { name: '次のタスクへの移行' }).selectOption('automatic');
  await panel.getByRole('button', { name: '確認して開始', exact: true }).click();
  await page.getByText('作業中', { exact: true }).waitFor();
  await page.locator('.xterm-helper-textarea').press('Enter');
  await page.getByText('作業中 · 自動移行を保留', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__tools.inputs.at(-1).data), '\r', 'Enter consumed by xterm still holds automatic progression');
  await page.locator('.xterm-helper-textarea').press('x');
  await page.getByText('作業中 · 自動移行を保留', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__tools.inputs.at(-1).data), 'x', 'the user can type into the actual PTY bridge');
  await page.waitForTimeout(5500);
  assert.equal(await panel.getByRole('button', { name: '完了を確認して次へ', exact: true }).isVisible(), true, 'human input suspends automatic advancement');
  await panel.getByRole('button', { name: '自動移行を再開', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.task-tools-running'));
  await panel.getByRole('button', { name: '選択解除', exact: true }).click();
  await panel.getByRole('checkbox', { name: /Epsilon task/ }).check();
  await panel.getByRole('button', { name: '確認して開始', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.task-tools-running'));
  assert.match(await results.last().textContent(), /完了/);
  await page.reload();
  await panel.waitFor();
  assert.equal(await page.evaluate(() => window.__tools.calls.length), 0, 'restored work never auto-starts');
  for (const width of [900, 420]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'controls and long text fit');
  }
  assert.deepEqual(errors, []);
  console.log('Passed: interactive mixed-provider queue, visible CLI output, live font size, manual/MCP automatic progression, human-input hold, optional decomposition/document reuse, pause/stop/recovery and responsive layout (mock native IPC).');
} finally { await browser.close(); }
