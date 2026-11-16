import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const templateUrl = 'https://x.ai/bot/hPGmSCsPi8Y_tUpPjDjwl';
const backend = `
import { useSyncExternalStore } from 'react';
import { getFunctionName } from 'convex/server';
export const useAuth = () => ({ userId: 'alice', isLoaded: true });
export const SignInButton = ({ children }) => children;
export const useConvexAuth = () => ({ isAuthenticated: true });
export function useQuery(ref, args) {
  useSyncExternalStore(fn => { window.listeners.add(fn); return () => window.listeners.delete(fn); }, () => window.revision);
  if (args === 'skip') return undefined;
  const row = window.decision;
  const rows = window.workRows ?? [row];
  switch (getFunctionName(ref)) {
    case 'grokBot:inbox': return { pending: rows.filter(row => row.status === 'waiting' || row.status === 'review'),
      answered: rows.filter(row => row.status === 'answered' || row.status === 'returned').map(({ stalled: _stalled, openTasks: _open, ...row }) => row) };
    case 'grokBot:schedule': return window.schedule;
    case 'grokBot:taskHistory': return { rows: (window.workRows ?? [row, window.result]).filter(Boolean).map(row => ({ ...row, canReply: true })),
      canReply: true, mayExecute: !!window.mayExecute, reviewRequired: !!window.reviewRequired };
    case 'grokBot:assignments': return window.assignments;
    case 'grokBot:oauthLabel': return args.assignment === 'press-bot' ? { id: 'press-bot', name: '広報' } : null;
  }
}
export const useMutation = ref => async args => {
  window.calls.push({ name: getFunctionName(ref), args });
  if (getFunctionName(ref) === 'grokBot:saveSchedule') window.schedule = { ...window.schedule, ...args };
  const patch = value => { window.workRows = window.workRows.map(row => row.id === args.id ? { ...row, ...value } : row); };
  if (getFunctionName(ref) === 'grokBot:reply') {
    if (window.workRows) patch({ status: 'answered', wakeStatus: 'accepted', answer: args.answer });
    else window.decision = { ...window.decision, status: 'answered', wakeStatus: 'accepted', answer: args.answer };
  }
  if (getFunctionName(ref) === 'grokBot:approveReview') patch({ status: 'approved' });
  if (getFunctionName(ref) === 'grokBot:returnReview') patch({ status: 'returned', answer: args.comment, wakeStatus: 'failed', wakeAt: Date.now() });
  if (getFunctionName(ref) === 'grokBot:retry') patch({ wakeStatus: 'accepted' });
  if (getFunctionName(ref) === 'grokBot:setDelegation') { window.mayExecute = args.execute; window.reviewRequired = !!args.reviewCompletion; }
  if (getFunctionName(ref) === 'grokBot:addAssignment') window.assignments = [{ id: 'press-bot', labelId: args.labelId,
    connectorName: 'Terminal · 広報 · press', connectorConnected: false, webhookConfigured: false, connected: false, managed: true }];
  if (getFunctionName(ref) === 'grokBot:rotateAssignmentToken') window.assignments = window.assignments.map(row => row.labelId === args.labelId
    ? { ...row, connectorConnected: false, connected: false } : row);
  if (getFunctionName(ref) === 'grokBot:setAssignmentSkin') window.assignments = window.assignments.map(row => row.id === args.assignmentId ? { ...row, skin: args.skin } : row);
  window.refresh();
  if (getFunctionName(ref) === 'grokBot:addAssignment') return 'press-bot';
};
export const useAction = ref => async args => {
  window.calls.push({ name: getFunctionName(ref), args });
  if (args.webhookKey !== 'fixture-key') throw { data: 'Routineを呼び出せませんでした。' };
  window.assignments = window.assignments.map(row => row.labelId === args.labelId
    ? { ...row, webhookConfigured: true, connected: row.connectorConnected } : row);
  window.refresh();
};`;
const { outputFiles } = await build({
  stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
    import {createRoot} from 'react-dom/client';
    import {BrowserRouter, Routes, Route} from 'react-router-dom';
    import {TaskWorkInbox, TaskWorkInboxLink, TaskWorkSection} from './src/components/task/TaskWork';
    import {LabelGrokBotMark, LabelGrokBotProvider} from './src/components/task/LabelGrokBot';
    import {GrokBotAuthorizePage} from './src/pages/GrokBotAuthorizePage';
    window.listeners = new Set();
    window.revision = 0;
    window.calls = [];
    window.assignments = [];
    window.refresh = () => { window.revision++; window.listeners.forEach(fn => fn()); };
    window.schedule = { enabled: false, time: '03:00', timeZone: 'Australia/Melbourne' };
    window.decision = { id: 'question', taskId: 'launch', status: 'waiting', text: '11月予定と書いてよいですか。', title: '告知文', label: '広報', createdAt: Date.now() };
    createRoot(document.getElementById('root')).render(<BrowserRouter>
      <TaskWorkInboxLink/><Routes>
        <Route path="/inbox" element={<TaskWorkInbox/>}/>
        <Route path="/grok-bot/authorize" element={<GrokBotAuthorizePage/>}/>
        <Route path="/" element={<LabelGrokBotProvider>
          <LabelGrokBotMark labelId="press" labelName="広報" onFocus={() => {}}/>
          <LabelGrokBotMark labelId="development" labelName="開発" onFocus={() => {}}/>
          <TaskWorkSection taskId="launch"/>
        </LabelGrokBotProvider>}/>
      </Routes></BrowserRouter>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'grok-bot-fixture', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: backend, resolveDir: process.cwd() }));
  } }],
});

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROME_CHANNEL });
const css = await readFile('src/index.css', 'utf8');
const shots = process.env.GROK_BOT_SCREENSHOTS;
const pr = 'https://github.com/example/press-site/pull/128-very-long-branch-name-for-wrapping';
const workRows = () => [
  { id: 'choice', taskId: 'launch', title: '告知文', label: '広報', labelId: 'press', status: 'waiting', kind: 'choice', options: ['今週', '来週', '保留'],
    recommendation: '来週', irreversible: true, text: '公開日を決めてください。公開後は取り消せません。', stalled: true, openTasks: 3, createdAt: Date.now() - 7_200_000 },
  { id: 'approval', taskId: 'launch', title: '告知文', label: '広報', labelId: 'press', status: 'waiting', kind: 'approval', recommendation: '承認',
    text: '見出しを「11月予定」に変えてよいですか。', stalled: true, openTasks: 3, createdAt: Date.now() - 3_600_000 },
  { id: 'review', taskId: 'launch', title: '告知文', label: '広報', labelId: 'press', status: 'review', text: '告知文の修正をPRにしました。',
    assumptions: '公開日が未定のため「11月予定」と書きました。', links: [pr], stalled: true, openTasks: 3, createdAt: Date.now() - 600_000 },
];

async function open(width, path) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route('https://terminal.test/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' }));
  await page.goto(`https://terminal.test${path}`);
  await page.addStyleTag({ content: css });
  return page;
}

async function decisionsAndReviews(width) {
  const page = await open(width, '/inbox');
  await page.evaluate(rows => { window.workRows = rows; }, workRows());
  await page.addScriptTag({ content: outputFiles[0].text });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
  await page.getByRole('link', { name: '受信箱 (3)' }).waitFor();
  const focus = page.getByRole('region', { name: 'いま最も詰まらせている1件' });
  await focus.getByText('公開日を決めてください。', { exact: false }).waitFor();
  await focus.getByText('不可逆', { exact: true }).waitFor();
  await focus.getByRole('button', { name: '来週 推奨' }).waitFor();
  assert.equal(await page.getByText('不可逆', { exact: true }).count(), 1);
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/inbox-${width}.png`, fullPage: true });
  await focus.getByRole('button', { name: '推奨どおり' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:reply');
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { id: 'choice', expectedUserId: 'alice', answer: '来週' });
  const approval = page.getByRole('region', { name: 'いま最も詰まらせている1件' });
  await approval.getByText('見出しを「11月予定」に変えてよいですか。').waitFor();
  await approval.getByRole('button', { name: '却下' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.args.id === 'approval');
  assert.equal(await page.evaluate(() => window.calls.at(-1).args.answer), '却下');
  const review = page.getByRole('region', { name: 'いま最も詰まらせている1件' });
  await review.getByText('公開日が未定のため「11月予定」と書きました。').waitFor();
  assert.equal(await review.getByRole('button', { name: '差し戻す' }).isDisabled(), true);
  await review.getByLabel('差し戻しの理由').fill('公開日は12月1日です。');
  await review.getByRole('button', { name: '差し戻す' }).click();
  await page.getByRole('status').filter({ hasText: '差し戻し・再開通知に失敗' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { name: 'grokBot:returnReview', args: { id: 'review', expectedUserId: 'alice', comment: '公開日は12月1日です。' } });
  await page.getByRole('button', { name: '担当Botに再通知' }).click();
  await page.getByRole('status').filter({ hasText: '差し戻し・反映待ち' }).waitFor();
  await page.getByText('確認待ちはありません。').waitFor();
  await page.getByRole('link', { name: '受信箱', exact: true }).waitFor();
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/inbox-answered-${width}.png`, fullPage: true });

  await page.evaluate(rows => { window.workRows = rows; window.refresh(); }, workRows());
  await page.getByRole('link', { name: '告知文' }).first().click();
  const role = page.getByLabel('Grok Botの関わり方');
  await role.selectOption('checked');
  await page.waitForFunction(() => window.reviewRequired === true);
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { expectedUserId: 'alice', taskId: 'launch', execute: true, reviewCompletion: true });
  assert.equal(await role.inputValue(), 'checked');
  await page.getByRole('button', { name: '承認 推奨', exact: true }).waitFor();
  await page.getByRole('button', { name: '今週', exact: true }).waitFor();
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/task-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: '承認して完了' }).click();
  await page.getByRole('status').filter({ hasText: '承認済み' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { name: 'grokBot:approveReview', args: { id: 'review', expectedUserId: 'alice' } });
  await page.close();
}

try {
  for (const width of [1280, 390]) await decisionsAndReviews(width);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://terminal.test/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' }));
  await page.goto('https://terminal.test/inbox');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    value: { async writeText(value) { window.copiedSetupValue = value; } },
  }));
  await page.evaluate(() => {
    window.open = () => ({
      location: { set href(value) { window.grokBotHandoff = value; } },
      close() {},
    });
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.getByRole('link', { name: '受信箱 (1)' }).waitFor();
  await page.getByRole('checkbox', { name: '毎日巡回する' }).check();
  await page.getByLabel('巡回時刻').fill('04:25');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => window.schedule.time === '04:25' && window.schedule.enabled);
  assert.deepEqual(await page.evaluate(() => window.calls[0].args), { expectedUserId: 'alice', enabled: true, time: '04:25' });
  await page.getByLabel('回答', { exact: true }).fill('11月予定で。');
  await page.getByRole('button', { name: '返信する' }).click();
  await page.getByRole('status').filter({ hasText: '回答済み・反映待ち' }).waitFor();
  await page.getByRole('link', { name: '告知文' }).click();
  assert.match(page.url(), /\?task=launch$/);
  const role = page.getByLabel('Grok Botの関わり方');
  assert.equal(await role.inputValue(), 'review');
  await role.selectOption('execute');
  await page.waitForFunction(() => window.mayExecute === true);
  await page.evaluate(() => {
    window.decision.status = 'applied';
    window.result = { id: 'result', status: 'complete', text: '手順を実行し、修正後の文言を確認しました。', createdAt: Date.now() };
    window.refresh();
  });
  await page.getByText('手順を実行し、修正後の文言を確認しました。').waitFor();
  await page.getByRole('status').filter({ hasText: '反映済み' }).waitFor();
  const mark = page.getByRole('button', { name: '広報 · Grok Botを接続' });
  await mark.click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('別のBotの共有リンク').isVisible(), false);
  assert.equal(await dialog.getByLabel('POST to（URL）').count(), 0);
  await dialog.getByRole('button', { name: 'Grok Botで設定する' }).click();
  const handoff = dialog.getByRole('link', { name: 'Grok Botで設定する' });
  await handoff.waitFor();
  const handoffUrl = new URL(await handoff.getAttribute('href'));
  const openedUrl = new URL(await page.evaluate(() => window.grokBotHandoff));
  assert.equal(openedUrl.origin, 'https://cursor.com');
  assert.equal(openedUrl.pathname, '/grok-bot/link/v1/prompt');
  assert.equal(openedUrl.search, handoffUrl.search);
  const prompt = handoffUrl.searchParams.get('text');
  assert.equal(handoffUrl.protocol, 'grokbot:');
  assert.equal(handoffUrl.pathname, '/v1/prompt');
  assert.match(prompt, /広報/);
  assert.match(prompt, /https:\/\/terminal.test\/grok-bot\/mcp\/press-bot/);
  assert.match(prompt, /connection_check/);
  assert.ok(prompt.length <= 1000 && !prompt.includes('\n'));
  assert.equal(await dialog.getByLabel('POST to（URL）').isVisible(), false);
  assert.equal(await dialog.getByRole('button', { name: 'Authorization をコピー' }).isVisible(), false);
  await dialog.getByText('別のBotを使う・アプリが開かない', { exact: true }).click();
  assert.equal(await dialog.getByRole('link', { name: '担当Botを作る' }).getAttribute('href'), templateUrl);
  await dialog.getByLabel('別のBotの共有リンク').fill('https://x.ai/bot/agent/abcdefghijklmnopqrstu');
  assert.equal(new URL(await handoff.getAttribute('href')).searchParams.get('id'), 'abcdefghijklmnopqrstu');
  await dialog.getByText('接続を管理', { exact: true }).click();
  await dialog.getByRole('button', { name: '手動で設定' }).click();
  await dialog.getByRole('button', { name: '接続キーを再発行' }).click();
  await dialog.getByRole('button', { name: 'Name をコピー', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedSetupValue), 'Terminal · 広報 · press');
  await dialog.getByRole('button', { name: 'Server URL をコピー' }).click();
  assert.equal(await page.evaluate(() => window.copiedSetupValue), 'https://terminal.test/api/grok-bot');
  await dialog.getByRole('button', { name: 'Authorization をコピー' }).click();
  const authorization = await page.evaluate(() => window.copiedSetupValue);
  assert.match(authorization, /^Bearer [a-f0-9]{64}$/);
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.name === 'grokBot:rotateAssignmentToken').args),
    { expectedUserId: 'alice', labelId: 'press', token: authorization.slice(7) });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '広報 · Grok Botの接続を続ける' }).click();
  await dialog.getByText('接続を管理', { exact: true }).click();
  await dialog.getByRole('button', { name: '手動で設定' }).click();
  await dialog.getByRole('button', { name: 'Authorization をコピー' }).click();
  assert.equal(await page.evaluate(() => window.copiedSetupValue), authorization);
  assert.ok(!prompt.includes(authorization));
  await page.evaluate(() => {
    window.assignments = window.assignments.map(row => ({ ...row, connectorConnected: true, connected: row.webhookConfigured }));
    window.refresh();
  });
  await dialog.getByRole('status').filter({ hasText: 'Terminalへのアクセスを確認しました' }).waitFor();
  const urlInput = dialog.getByLabel('POST to（URL）');
  const keyInput = dialog.getByLabel('key（呼び出しキー）');
  const webhookUrl = 'https://api2.cursor.sh/automations/webhook/press';
  await urlInput.waitFor();
  assert.ok(await urlInput.evaluate(node => node.getBoundingClientRect().width > 0.8 * node.closest('form').getBoundingClientRect().width));
  await urlInput.fill(webhookUrl);
  await keyInput.fill('wrong-key');
  await dialog.getByRole('button', { name: 'テストして接続' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Routineを呼び出せませんでした' }).waitFor();
  assert.equal(await urlInput.inputValue(), webhookUrl);
  assert.equal(await keyInput.inputValue(), 'wrong-key');
  await keyInput.fill('fixture-key');
  await dialog.getByRole('button', { name: 'テストして接続' }).click();
  await dialog.getByRole('status').filter({ hasText: '接続済み' }).waitFor();
  await dialog.getByRole('heading', { name: 'Grok Botの巡回' }).waitFor();
  assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().width < innerWidth));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const assignedMark = page.getByRole('button', { name: '広報 · 担当のGrok Bot' });
  const avatar = assignedMark.locator('img');
  assert.ok(await assignedMark.evaluate(node => node === document.activeElement));
  assert.equal(await avatar.evaluate(node => node.decode().then(() => node.naturalWidth)), 36);
  await assignedMark.click();
  await dialog.getByLabel('スキン画像を追加').setInputFiles('public/icons/icon-192.png');
  await page.waitForFunction(() => window.calls.some(call => call.name === 'grokBot:setAssignmentSkin'));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const originalSkin = await avatar.getAttribute('src');
  assert.match(originalSkin, /^data:image\/png;base64,/);
  assert.equal(await avatar.evaluate(node => node.decode().then(() => node.naturalWidth)), 64);
  await assignedMark.click();
  await dialog.getByLabel('スキン画像を変更').setInputFiles('src/assets/cirno.png');
  await page.waitForFunction(() => window.calls.filter(call => call.name === 'grokBot:setAssignmentSkin').length === 2);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.notEqual(await avatar.getAttribute('src'), originalSkin);
  await assignedMark.click();
  await dialog.getByText('接続を管理', { exact: true }).click();
  await dialog.getByRole('button', { name: '接続をやり直す' }).click();
  await dialog.getByRole('link', { name: 'Grok Botで設定する' }).waitFor();
  await dialog.getByRole('button', { name: '手動で設定' }).click();
  await dialog.getByRole('button', { name: 'Authorization をコピー' }).click();
  assert.notEqual(await page.evaluate(() => window.copiedSetupValue), authorization);
  assert.equal(await dialog.getByLabel('POST to（URL）').count(), 0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const defaultMark = page.getByRole('button', { name: '開発 · Grok Botを接続' }).locator('img');
  assert.equal(await defaultMark.evaluate(node => node.decode().then(() => node.naturalWidth)), 36);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const consent = '/grok-bot/authorize?' + new URLSearchParams({
    assignment: 'press-bot', client_id: 'grok-bot', response_type: 'code', code_challenge_method: 'S256',
    code_challenge: 'x'.repeat(43), state: 'fixture-state', redirect_uri: 'https://www.cursor.com/bot/mcp/oauth/callback',
  });
  await page.route('https://www.cursor.com/bot/mcp/oauth/callback?**', route => route.fulfill({ body: 'Grok Bot callback' }));
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); },
    consent.replace('www.cursor.com', 'cursor.com.invalid'));
  await page.getByText('接続を開けませんでした。Grok Botからやり直してください。').waitFor();
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, consent);
  await page.getByText(/「広報」のタスクの確認/).waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.name === 'grokBot:approveOAuth')), false);
  await page.getByRole('button', { name: '接続を許可' }).click();
  await page.waitForURL('https://www.cursor.com/bot/mcp/oauth/callback?**');
  const callback = new URL(page.url());
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  assert.match(callback.searchParams.get('code'), /^[a-f0-9]{64}$/);
  console.log('Mobile: Bot handoff, label-specific consent, Routine validation, skins, patrol and inbox. 1280/390: structured decisions and reviews.');
} finally {
  await browser.close();
}
