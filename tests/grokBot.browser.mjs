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
      answered: rows.filter(row => ['answered', 'returned', 'merging'].includes(row.status)).map(({ stalled: _stalled, openTasks: _open, ...row }) => row),
      proposals: window.proposals ?? [], nextPatrolAt: window.nextPatrolAt ?? null, metrics: window.metrics ?? { medianAnswerMs: null, answered: 0, returnRate: null, returned: 0, reviewed: 0, forwardWeek: 0, forwardToday: 0 },
      nextPatrol: window.nextPatrol ?? null, rejections: window.rejections, norms: window.norms, recentCompletions: window.recentCompletions };
    case 'grokBot:team': return window.team;
    case 'grokBot:schedule': return window.schedule;
    case 'grokBot:taskHistory': return { rows: (window.workRows ?? [row, window.result]).filter(Boolean).map(row => ({ ...row, canReply: true })),
      canReply: true, mayExecute: !!window.mayExecute, reviewRequired: !!window.reviewRequired, botMode: window.botMode, deferredUntil: window.deferredUntil ?? null };
    case 'grokBot:norms': return window.norms;
    case 'grokBot:assignments': return window.assignments;
    case 'grokBot:vp': return window.vp ?? null;
    case 'grokBot:oauthLabel': return args.assignment === 'press-bot' ? { id: 'press-bot', name: '広報' } : args.assignment === 'vp-bot' ? { id: 'vp-bot', name: 'VP', vp: true } : null;
  }
}
export const useMutation = ref => async args => {
  window.calls.push({ name: getFunctionName(ref), args });
  if (getFunctionName(ref) === 'grokBot:saveSchedule') window.schedule = { ...window.schedule, ...args, times: args.times ?? [args.time] };
  const patch = value => { window.workRows = window.workRows.map(row => row.id === args.id ? { ...row, ...value } : row); };
  if (getFunctionName(ref) === 'grokBot:reply') {
    if (window.workRows) patch({ status: 'answered', wakeStatus: 'accepted', answer: args.answer });
    else window.decision = { ...window.decision, status: 'answered', wakeStatus: 'accepted', answer: args.answer };
  }
  if (getFunctionName(ref) === 'grokBot:approveReview') patch(window.workRows.find(row => row.id === args.id).prHeadSha
    ? { status: 'merging', wakeStatus: 'queued', wakeAt: Date.now() } : { status: 'approved' });
  if (getFunctionName(ref) === 'grokBot:returnReview') patch({ status: 'returned', answer: args.comment, wakeStatus: 'failed', wakeAt: Date.now() });
  if (getFunctionName(ref) === 'grokBot:retry') patch({ wakeStatus: 'accepted' });
  if (getFunctionName(ref) === 'grokBot:setDelegation') { window.mayExecute = args.execute; window.reviewRequired = !!args.reviewCompletion; window.botMode = args.mode; }
  if (getFunctionName(ref) === 'grokBot:rejectTaskWithLearning') {
    if (args.workId) window.workRows = window.workRows.filter(row => row.id !== args.workId);
    else window.proposals = window.proposals.filter(row => row.id !== args.proposalId);
  }
  if (getFunctionName(ref) === 'grokBot:addNorm') window.norms = [{ id: 'n' + (window.norms.length + 1), kind: args.kind, text: args.text, active: true, createdAt: Date.now() }, ...window.norms];
  if (getFunctionName(ref) === 'grokBot:toggleNorm') window.norms = window.norms.map(norm => norm.id === args.id ? { ...norm, active: args.active } : norm);
  if (getFunctionName(ref) === 'grokBot:deleteNorm') window.norms = window.norms.filter(norm => norm.id !== args.id);
  if (getFunctionName(ref) === 'grokBot:addAssignment' && args.vp) window.vp = { id: 'vp-bot', labelId: '', name: 'Grok Bot',
    connectorName: 'Terminal · VP', connectorConnected: false, webhookConfigured: false, connected: false, managed: true };
  else if (getFunctionName(ref) === 'grokBot:addAssignment') window.assignments = [{ id: 'press-bot', labelId: args.labelId,
    connectorName: 'Terminal · 広報 · press', connectorConnected: false, webhookConfigured: false, connected: false, managed: true }];
  if (getFunctionName(ref) === 'grokBot:rotateAssignmentToken' && args.vp) window.vp = { ...window.vp, connectorConnected: false, connected: false };
  else if (getFunctionName(ref) === 'grokBot:rotateAssignmentToken') window.assignments = window.assignments.map(row => row.labelId === args.labelId
    ? { ...row, connectorConnected: false, connected: false } : row);
  if (getFunctionName(ref) === 'grokBot:adoptProposal' || getFunctionName(ref) === 'grokBot:dismissProposal') {
    window.proposals = window.proposals.filter(row => row.id !== args.id);
  }
  if (getFunctionName(ref) === 'grokBot:cancelDeferral') window.deferredUntil = null;
  const employees = edit => { window.team = { employees: window.team.employees.map(edit) }; };
  if (getFunctionName(ref) === 'grokBot:setAssignmentDefaultMode') employees(row => row.labelId === args.labelId ? { ...row, defaultMode: args.defaultMode } : row);
  if (getFunctionName(ref) === 'grokBot:setDelegation' && window.team) employees(row => ({ ...row,
    tasks: row.tasks.map(task => task.id === args.taskId ? { ...task, botMode: args.mode, inherited: args.mode === row.defaultMode } : task) }));
  if (getFunctionName(ref) === 'grokBot:assignGoalToBot') employees(row => row.labelId === args.labelId ? { ...row, tasks: [...row.tasks,
    { id: 'goal-' + window.calls.length, title: args.title, botMode: args.mode, inherited: args.mode === row.defaultMode, waiting: 0, review: 0, answered: 0, merging: 0 }] } : row);
  if (getFunctionName(ref) === 'grokBot:setAssignmentSkin') window.assignments = window.assignments.map(row => row.id === args.assignmentId ? { ...row, skin: args.skin } : row);
  window.refresh();
  if (getFunctionName(ref) === 'grokBot:addAssignment') return args.vp ? 'vp-bot' : 'press-bot';
  if (getFunctionName(ref) === 'grokBot:assignGoalToBot') return { taskId: 'goal-' + window.calls.length };
  if (getFunctionName(ref) === 'grokBot:adoptProposal') return { status: args.id === 'stale-move' ? 'changed' : 'adopted' };
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
    import {MainBotPatrolSettings, NormsSettings, TaskWorkInbox, TaskWorkInboxLink, TaskWorkSection} from './src/components/task/TaskWork';
    import {LabelGrokBotMark, LabelGrokBotProvider, VpGrokBotSettings} from './src/components/task/LabelGrokBot';
    import {GrokBotAuthorizePage} from './src/pages/GrokBotAuthorizePage';
    window.listeners = new Set();
    window.revision = 0;
    window.calls = [];
    window.assignments = [];
    window.refresh = () => { window.revision++; window.listeners.forEach(fn => fn()); };
    window.schedule = { enabled: false, time: '03:00', times: ['03:00'], timeZone: 'Australia/Melbourne' };
    window.decision = { id: 'question', taskId: 'launch', status: 'waiting', text: '11月予定と書いてよいですか。', title: '告知文', label: '広報', createdAt: Date.now() };
    createRoot(document.getElementById('root')).render(<BrowserRouter>
      <TaskWorkInboxLink/><Routes>
        <Route path="/inbox" element={<TaskWorkInbox/>}/>
        <Route path="/grok-bot/authorize" element={<GrokBotAuthorizePage/>}/>
        <Route path="/patrol" element={<MainBotPatrolSettings/>}/>
        <Route path="/norms" element={<NormsSettings/>}/>
        <Route path="/vp" element={<section className="settings-section"><h3>VP（Grok Bot）</h3>
          <div className="settings-group settings-block"><VpGrokBotSettings/></div></section>}/>
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
const place = { taskId: 'launch', title: '告知文', label: '広報', labelId: 'press', stalled: true, openTasks: 3 };
const workRows = () => [
  { ...place, id: 'choice', status: 'waiting', kind: 'choice', headline: '告知ページをいつ公開するか', createdAt: Date.now() - 7_200_000,
    text: '告知文と画像がそろいました。公開日だけが決まっていません。公開すると取引先にも通知が届きます。',
    options: [{ label: '今週金曜', consequence: '金曜の朝に告知ページを本番に公開し、取引先へ通知を送ります。', irreversible: true },
      { label: '来週月曜', consequence: '月曜まで下書きのまま置き、社内確認を1回挟みます。' },
      { label: '保留', consequence: '公開日が決まるまで何もしません。' }],
    recommendation: '来週月曜', recommendationReason: '社内確認の時間が取れ、取引先への通知も週明けの方が読まれます。', confidence: 'medium', irreversible: true,
    checks: ['公開日の表記が「11月予定」になっているか', '通知の宛先が取引先リストだけか'],
    evidence: [{ url: 'https://example.test/preview/launch', title: '告知ページのプレビュー' }, { url: 'https://example.test/recipients' }] },
  { ...place, id: 'approval', status: 'waiting', kind: 'approval', headline: '見出しを「11月予定」に変える', createdAt: Date.now() - 3_600_000,
    text: '公開日が未定のため、見出しの日付をぼかしたいです。',
    options: [{ label: '承認', consequence: '見出しを「11月予定」に書き換えます。' }, { label: '却下', consequence: '見出しは今のまま残します。' }],
    recommendation: '承認', recommendationReason: '日付の誤りを避けられます。', confidence: 'high', checks: ['見出しの文言'] },
  { ...place, id: 'review', status: 'review', headline: '告知文の修正を仕上げた', text: '指摘の3点を直し、文面を確定しました。',
    assumptions: '公開日が未定のため「11月予定」と書きました。', checks: ['見出しの表記', '問い合わせ先のメールアドレス'], links: [pr], createdAt: Date.now() - 600_000 },
];
const legacyRow = () => ({ ...place, id: 'legacy', status: 'waiting', kind: 'choice', options: [{ label: '今週' }, { label: '来週' }], recommendation: '来週',
  irreversible: true, text: '公開日を決めてください。公開後は取り消せません。', createdAt: Date.now() - 9_000_000 });

const proposals = () => [
  { id: 'remove', kind: 'delete', vp: false, proposer: '広報', taskId: 'old-plan', taskTitle: '旧キャンペーン案の整理', taskOpen: true, count: 4,
    reason: '12月の告知方針で不要になりました。サブタスクも同じ理由で不要です。', createdAt: Date.now() - 5_000 },
  { id: 'later', kind: 'defer', vp: false, proposer: '広報', taskId: 'launch', taskTitle: '告知文', taskOpen: true, until: '2026-12-01',
    reason: '公開日が決まるまで手を付けられません。', createdAt: Date.now() - 4_000 },
  { id: 'stale-move', kind: 'move', vp: true, proposer: 'VP', taskId: 'loose', taskTitle: 'プレスリリースの配信先リストを作る', taskOpen: true,
    labelId: 'press', labelName: '広報', reason: '広報の作業です。', createdAt: Date.now() - 3_000 },
  { id: 'idea', kind: 'new_task', vp: true, proposer: 'VP', title: '請求書の発行フローを見直す', note: '月末に毎回手作業になっています。',
    reason: '毎月同じ確認が発生しています。', createdAt: Date.now() - 2_000 },
];

async function open(width, path) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route('https://terminal.test/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' }));
  await page.goto(`https://terminal.test${path}`);
  await page.addStyleTag({ content: css });
  return page;
}

async function inbox(width, path, setup) {
  const page = await open(width, path);
  await page.evaluate(setup);
  await page.addScriptTag({ content: outputFiles[0].text });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
  const shoot = async name => {
    if (!shots) return;
    for (const theme of ['black', 'white', 'original']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shots}/${name}-${width}-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'black'; });
  };
  return { page, noOverflow, shoot, card: page.locator('.inbox-pane .work-card'), queue: page.getByRole('region', { name: '対応の一覧' }),
    lastCall: () => page.evaluate(() => window.calls.at(-1)) };
}

const challengeRow = () => ({ ...place, id: 'challenge', status: 'waiting', kind: 'challenge', artifactKind: 'mock', botMode: 'challenge',
  headline: '告知ページは本当に必要か', text: '問い合わせの多くは既存のFAQで足りています。使い捨てのモックで比べられます。',
  options: [{ label: 'ボツ', consequence: 'タスクを削除します。' }, { label: '作る', consequence: '実装に進みます。' }],
  recommendation: 'ボツ', recommendationReason: '需要が未確認です。', confidence: 'medium', checks: ['モックの導線'], createdAt: Date.now() - 9_000_000 });

/** The design loop: challenge before building, greenlight in one step, return with a norm, kill with learning. */
async function designStudio(width) {
  const { page, noOverflow, shoot, card, lastCall } = await inbox(width, '/inbox?item=challenge', () => {});
  const rejections = [{ id: 'rej', taskId: 'old', taskTitle: '旧キャンペーン案', labelName: '広報', reason: '効果を測れない', spawnedTaskId: 'ask', spawnedTitle: '3人に聞く', rejectedAt: Date.now() - 60_000 }];
  const norms = [{ id: 'n1', kind: 'kill_criterion', text: '計測できない改善はボツ', labelId: 'press', labelName: '広報', active: true, createdAt: Date.now() }];
  await page.evaluate(([rows, rejections, norms]) => {
    window.workRows = rows; window.rejections = rejections; window.norms = norms; window.nextPatrolAt = Date.now() + 3_600_000;
    window.nextPatrol = { at: window.nextPatrolAt, label: '広報', vp: false }; window.refresh();
  }, [[challengeRow(), ...workRows()], rejections, norms]);
  await card.getByRole('heading', { name: '告知ページは本当に必要か' }).waitFor();
  await card.locator('.work-card-meta').getByText('反論・検証').waitFor();
  await card.locator('.work-card-meta .task-work-badge').getByText('モック', { exact: true }).waitFor();
  await page.getByText(/次の巡回 \d\d:\d\d（広報）/).waitFor({ state: 'attached' });
  const promote = card.getByRole('checkbox', { name: 'この回答で実行へ進める（完了は確認）' });
  assert.equal(await promote.isChecked(), false, 'greenlighting is opt-in');
  await promote.check();
  await noOverflow();
  await shoot('challenge');
  await card.getByRole('button', { name: /^作る/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:reply');
  assert.deepEqual((await lastCall()).args, { id: 'challenge', expectedUserId: 'alice', answer: '作る', promoteToExecution: true });

  // An ordinary decision in a task the Bot already executes offers no greenlight.
  await card.getByRole('heading', { name: '告知ページをいつ公開するか' }).waitFor();
  assert.equal(await card.getByRole('checkbox', { name: /実行へ進める/ }).count(), 0);

  // Kill with learning: reason required, a next step and a norm are optional.
  if (width > 760) await page.keyboard.press('x');
  else await card.getByRole('button', { name: '納得してボツにする' }).click();
  const submit = card.getByRole('button', { name: 'ボツにして学びを残す' });
  assert.equal(await submit.isDisabled(), true);
  await card.getByLabel('なぜやらないと決めたか・分かったこと').fill('公開日が決まらない限り判断できない');
  await card.getByLabel('この対話から生まれた次の一手（任意）').fill('公開日を決める');
  await card.getByRole('checkbox', { name: 'この判断基準を規範にも残す' }).check();
  await submit.click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:rejectTaskWithLearning');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', workId: 'choice', reason: '公開日が決まらない限り判断できない',
    spawnTitle: '公開日を決める', alsoCreateNorm: true });

  // Returning a review can also keep the feedback as a norm.
  await page.evaluate(() => { window.workRows = window.workRows.filter(row => row.id === 'review'); window.refresh(); });
  await page.locator('.inbox-queue').getByRole('button', { name: /告知文の修正を仕上げた/ }).click();
  await card.getByRole('heading', { name: '告知文の修正を仕上げた' }).waitFor();
  await card.getByRole('button', { name: '差し戻す' }).click();
  await card.getByLabel('差し戻しの理由').fill('問い合わせ先は代表アドレスにする');
  await card.getByRole('checkbox', { name: 'この指摘を規範にも残す' }).check();
  await card.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:returnReview');
  assert.deepEqual((await lastCall()).args, { id: 'review', expectedUserId: 'alice', comment: '問い合わせ先は代表アドレスにする', alsoCreateNorm: true });

  // The learning log and norms open quietly from the status line.
  await page.getByRole('button', { name: 'ボツと学び 1' }).click();
  await page.locator('.inbox-rejections').getByText('効果を測れない').waitFor();
  assert.equal(await page.getByRole('link', { name: '次の一手: 3人に聞く' }).getAttribute('href'), '/?task=ask');
  await page.getByRole('button', { name: '規範 1' }).click();
  assert.equal(await page.locator('.inbox-rejections').count(), 0, 'one drawer at a time');
  await page.locator('.inbox-norms').getByText('計測できない改善はボツ').waitFor();
  await noOverflow();
  await shoot('studio-drawers');
  await page.close();
}

async function consoleKeyboard() {
  const { page, noOverflow, shoot, card, queue, lastCall } = await inbox(1280, '/inbox', () => {});
  await page.evaluate(([rows]) => { window.workRows = rows; window.nextPatrolAt = Date.now() + 3_600_000; window.refresh(); }, [workRows()]);
  await page.getByRole('link', { name: '受信箱（対応待ち3件）' }).waitFor();
  const rows = queue.getByRole('button');
  assert.deepEqual(await queue.locator('#inbox-waiting ~ ul .inbox-row-title').allTextContents(), ['告知ページをいつ公開するか', '見出しを「11月予定」に変える', '告知文の修正を仕上げた']);
  assert.equal(await rows.first().getAttribute('aria-current'), 'true');
  assert.match(await rows.first().textContent(), /広報 · 判断依頼 · 3件停止不可逆/);
  await card.getByRole('heading', { name: '告知ページをいつ公開するか' }).waitFor();
  await card.getByText('この判断で3件が止まっています').waitFor();
  await card.getByRole('button', { name: /^今週金曜 不可逆 金曜の朝に/ }).waitFor();
  await card.getByRole('button', { name: /^来週月曜 推奨 月曜まで下書き/ }).waitFor();
  assert.equal(await card.getByRole('button', { name: '推奨どおり' }).count(), 0, 'the recommendation is marked, not a shortcut');
  await card.getByText('確度 中').waitFor();
  assert.deepEqual(await card.locator('.work-card-checks li').allTextContents(), workRows()[0].checks);
  assert.equal(await card.locator('details.work-card-evidence').evaluate(node => node.open), false, 'evidence starts collapsed');
  assert.equal(await card.getByLabel('回答').count(), 0, 'free text waits behind 別の答えを書く');
  await page.getByText('Botの反映待ち 0').waitFor();
  await page.getByText(/次の巡回 \d\d:\d\d/).waitFor();
  await noOverflow();
  await shoot('console');

  // Irreversible: select with 1, Enter arms, a stray second Enter within 400 ms does nothing, a deliberate one confirms.
  await page.keyboard.press('1');
  const first = card.getByRole('button', { name: /^今週金曜/ });
  assert.ok(await first.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Enter');
  await card.getByText('取り消せません。もう一度押して確定').waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'a double press never confirms an irreversible choice');
  await shoot('console-armed');
  await page.waitForTimeout(450);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:reply');
  assert.deepEqual((await lastCall()).args, { id: 'choice', expectedUserId: 'alice', answer: '今週金曜' });

  // Auto-advance: the next card opens, keeps the keyboard and is announced.
  await card.getByRole('heading', { name: '見出しを「11月予定」に変える' }).waitFor();
  assert.match(page.url(), /\?item=approval$/);
  assert.ok(await page.evaluate(() => document.activeElement.closest('.work-card') !== null), 'focus stays in the console');
  await page.locator('.task-work-live').filter({ hasText: '次の対応: 見出しを「11月予定」に変える' }).waitFor();
  await page.getByText('Botの反映待ち 1').waitFor();

  // S moves the current item to the end of this visit's queue; J and K move. Wait until the new card holds focus first.
  await page.waitForFunction(() => document.activeElement.closest('.work-card')?.dataset.item === 'approval');
  await page.keyboard.press('s');
  await card.getByRole('heading', { name: '告知文の修正を仕上げた' }).waitFor();
  assert.deepEqual(await queue.locator('#inbox-waiting ~ ul .inbox-row-title').allTextContents(), ['告知文の修正を仕上げた', '見出しを「11月予定」に変える']);
  await page.waitForFunction(() => document.activeElement.closest('.work-card')?.dataset.item === 'review');
  await page.keyboard.press('j');
  await card.getByRole('heading', { name: '見出しを「11月予定」に変える' }).waitFor();
  await page.keyboard.press('k');
  await card.getByRole('heading', { name: '告知文の修正を仕上げた' }).waitFor();
  await card.getByText('Botが補った前提・判断').waitFor();
  await card.getByText('この確認で3件が止まっています').waitFor();

  // ? shows the legend; A approves a review in one step when nothing is published.
  await page.keyboard.press('?');
  await page.getByRole('region', { name: 'キー操作' }).waitFor();
  await shoot('console-legend');
  await page.keyboard.press('?');
  await page.keyboard.press('a');
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:approveReview');
  assert.deepEqual((await lastCall()).args, { id: 'review', expectedUserId: 'alice' });

  // A reversible choice confirms with one click, then the queue is empty.
  await card.getByRole('heading', { name: '見出しを「11月予定」に変える' }).waitFor();
  await card.getByRole('button', { name: /^却下/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.args.id === 'approval');
  assert.equal((await lastCall()).args.answer, '却下');
  const empty = page.locator('.inbox-empty');
  await empty.getByRole('heading', { name: '対応待ちはありません' }).waitFor();
  await empty.getByText('この間に3件が動き出しました。').waitFor();
  await empty.getByRole('region', { name: '直近7日' }).waitFor();
  assert.equal(await page.locator('.nav-count').count(), 0, 'the inbox link is quiet when nothing needs the human');
  await page.getByRole('button', { name: 'Botの反映待ち 2' }).click();
  await queue.getByRole('button', { name: /回答済み・反映待ち 見出し/ }).click();
  await card.getByText('あなたの回答').waitFor();
  assert.match(page.url(), /\?item=approval$/);
  await noOverflow();
  await shoot('console-empty');
  await page.close();
}

async function consolePhone(width) {
  const { page, noOverflow, shoot, card, queue, lastCall } = await inbox(width, '/inbox', () => {});
  await page.evaluate(([rows]) => { window.workRows = rows; window.refresh(); }, [workRows()]);
  await queue.getByRole('button', { name: /告知ページをいつ公開するか/ }).waitFor();
  assert.equal(await card.isVisible(), false, 'a phone starts on the queue');
  await noOverflow();
  await shoot('phone-queue');
  await queue.getByRole('button', { name: /見出しを「11月予定」に変える/ }).click();
  await card.getByRole('heading', { name: '見出しを「11月予定」に変える' }).waitFor();
  assert.equal(await queue.isVisible(), false);
  assert.match(page.url(), /\?item=approval$/);
  await noOverflow();
  await shoot('phone-card');
  await page.getByRole('button', { name: '一覧に戻る' }).click();
  await queue.getByRole('button', { name: /告知ページをいつ公開するか/ }).waitFor();
  assert.doesNotMatch(page.url(), /item=/);
  await queue.getByRole('button', { name: /告知ページをいつ公開するか/ }).click();
  await card.getByRole('button', { name: /^今週金曜/ }).click();
  await card.getByText('取り消せません。もう一度押して確定').waitFor();
  await noOverflow();
  await shoot('phone-armed');
  await card.getByRole('button', { name: /^来週月曜/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:reply');
  assert.equal((await lastCall()).args.answer, '来週月曜');
  await card.getByRole('heading', { name: '見出しを「11月予定」に変える' }).waitFor();
  await card.getByRole('button', { name: '別の答えを書く' }).click();
  await card.getByLabel('回答').fill('見出しは「秋の告知」にしてください。');
  await card.getByRole('button', { name: '返信する' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.args.id === 'approval');
  await card.getByRole('heading', { name: '告知文の修正を仕上げた' }).waitFor();
  await noOverflow();
  await shoot('phone-review');
  await page.close();
}

const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const prReview = () => [{ ...place, id: 'pr', status: 'review', headline: '告知ページの修正をPRにした', text: '文言を直し、画像を差し替えました。',
  checks: ['プレビューで見出しを確認'], links: ['https://example.test/preview/launch', 'https://github.com/example/press-site/pull/128'],
  prUrl: 'https://github.com/example/press-site/pull/128', prHeadSha: sha, openTasks: 1, createdAt: Date.now() - 1_200_000 },
  { ...place, id: 'pr-2', status: 'review', headline: '料金表のPR', text: '料金表を更新しました。', checks: ['金額'], links: ['https://github.com/example/press-site/pull/129'],
    prUrl: 'https://github.com/example/press-site/pull/129', prHeadSha: sha.replace('a1', 'b2'), openTasks: 1, createdAt: Date.now() - 600_000 }];
const metrics = { medianAnswerMs: 45 * 60_000, answered: 8, returnRate: 1 / 3, returned: 2, reviewed: 6, forwardWeek: 3, forwardToday: 1, rejectedWeek: 2, rejectedToday: 1, spawnedWeek: 1 };

async function pullRequestAndMetrics(width) {
  const { page, noOverflow, shoot, card, lastCall } = await inbox(width, '/inbox?item=pr', () => {});
  await page.evaluate(([rows, figures]) => { window.workRows = rows; window.metrics = figures; window.refresh(); }, [prReview(), metrics]);
  await card.getByText('広報 / 告知文 · プルリクエストの確認', { exact: false }).waitFor();
  const link = card.getByRole('link', { name: 'example/press-site#128' });
  assert.equal(await link.getAttribute('href'), 'https://github.com/example/press-site/pull/128');
  await card.getByText('a1b2c3d', { exact: true }).waitFor();
  const merge = card.getByRole('button', { name: /承認してマージを任せる/ });
  const note = await merge.evaluate(node => document.getElementById(node.getAttribute('aria-describedby'))?.textContent);
  assert.match(note, /マージすると本番に公開されます/, 'approving a pull request says that merging publishes to production');
  await card.getByText('根拠 1件').click();
  await card.getByRole('link', { name: 'https://example.test/preview/launch' }).waitFor();
  assert.equal(await card.getByRole('link', { name: 'https://github.com/example/press-site/pull/128' }).count(), 0, 'the PR link is shown once');
  if (width > 760) {
    const strip = page.getByRole('region', { name: '直近7日' });
    assert.deepEqual(await strip.locator('dl > div').evaluateAll(rows => rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])),
      [['前に進んだ件数', '3件 今日 1件'], ['納得して手放した件数', '2件 今日 1件 · 次の一手 1件'], ['差し戻し率', '33% 2/6件'], ['回答までの時間（中央値）', '45分']]);
  }
  await noOverflow();
  await shoot('pr');

  // Merging publishes, so approval takes a second deliberate press.
  await merge.click();
  await card.getByRole('button', { name: /取り消せません。もう一度押して確定/ }).click();
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'a double click never approves a merge');
  await page.waitForTimeout(450);
  await card.getByRole('button', { name: /取り消せません。もう一度押して確定/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:approveReview');
  assert.deepEqual((await lastCall()).args, { id: 'pr', expectedUserId: 'alice' });

  // R opens the return reason; the reason is required.
  await card.getByRole('heading', { name: '料金表のPR' }).waitFor();
  if (width > 760) {
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.activeElement?.matches('.work-card textarea'));
  } else await card.getByRole('button', { name: '差し戻す' }).click();
  assert.equal(await card.getByRole('button', { name: '差し戻す' }).isDisabled(), true);
  await card.getByLabel('差し戻しの理由').fill('金額が税抜きのままです。');
  await card.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:returnReview');
  assert.deepEqual((await lastCall()).args, { id: 'pr-2', expectedUserId: 'alice', comment: '金額が税抜きのままです。' });
  await page.locator('.inbox-empty').getByText('この間に1件が動き出しました。').waitFor();

  await page.getByRole('button', { name: 'Botの反映待ち 2' }).click();
  await page.getByRole('button', { name: /承認済み・Botのマージ待ち/ }).click();
  await card.getByRole('link', { name: 'example/press-site#128' }).waitFor();
  assert.equal(await card.getByRole('button').count(), 0, 'nothing to approve twice');
  await noOverflow();
  await shoot('pr-merging');

  await page.evaluate(() => { window.metrics = undefined; window.refresh(); });
  await page.locator('.task-work-metrics').first().getByText('45分').waitFor({ state: 'detached' });
  await card.getByRole('link', { name: '告知文' }).click();
  await page.getByLabel('Grok Botの関わり方').waitFor();
  await page.getByText('Botとのやりとり', { exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: '承認済み・Botのマージ待ち' }).waitFor();
  await noOverflow();
  await page.close();
}

async function legacyAndTaskPanel(width) {
  const { page, noOverflow, shoot, card, lastCall } = await inbox(width, '/inbox?item=legacy', () => {});
  await page.evaluate(([rows]) => { window.workRows = rows; window.refresh(); }, [[legacyRow(), ...workRows()]]);
  await card.getByText('公開日を決めてください。公開後は取り消せません。').waitFor();
  assert.equal(await card.getByRole('heading').count(), 0, 'an older row keeps its question as written');
  await card.locator('.work-card-meta').getByText('不可逆', { exact: true }).waitFor();
  await card.getByRole('button', { name: /^来週 推奨/ }).waitFor();
  await noOverflow();
  await shoot('legacy');
  await card.getByRole('button', { name: /^今週/ }).click();
  await card.getByText('取り消せません。もう一度押して確定').waitFor();
  await page.waitForTimeout(450);
  await card.getByRole('button', { name: /^今週/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:reply');
  assert.deepEqual((await lastCall()).args, { id: 'legacy', expectedUserId: 'alice', answer: '今週' });

  await page.evaluate(rows => { window.workRows = rows; window.refresh(); }, workRows());
  await card.getByRole('link', { name: '告知文' }).click();
  const role = page.getByLabel('Grok Botの関わり方');
  await role.waitFor();
  assert.deepEqual(await role.locator('option').allTextContents(), ['確認・監査', 'まず反論・検証モックまで', '実行を任せ、完了は必ず確認', '実行も任せる']);
  await role.selectOption('challenge');
  await page.waitForFunction(() => window.botMode === 'challenge');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', taskId: 'launch', mode: 'challenge', execute: false });
  await role.selectOption('checked');
  await page.waitForFunction(() => window.reviewRequired === true);
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', taskId: 'launch', mode: 'checked', execute: true, reviewCompletion: true });
  assert.equal(await role.inputValue(), 'checked');
  const panel = page.locator('.inspector-section, section').filter({ hasText: 'Botとのやりとり' }).last();
  await panel.getByRole('heading', { name: '告知ページをいつ公開するか' }).waitFor();
  await panel.getByRole('button', { name: /^来週月曜 推奨/ }).waitFor();
  assert.equal(await page.locator('.inbox-queue').count(), 0, 'the task panel shows cards without the queue');
  await noOverflow();
  await shoot('task-panel');
  await panel.getByRole('button', { name: '承認して完了' }).click();
  await page.getByRole('status').filter({ hasText: '承認済み' }).first().waitFor();
  assert.deepEqual(await lastCall(), { name: 'grokBot:approveReview', args: { id: 'review', expectedUserId: 'alice' } });
  await page.close();
}

async function proposalsAndDeferral(width) {
  const { page, noOverflow, shoot, card, queue, lastCall } = await inbox(width, '/inbox', () => {});
  await page.evaluate(([rows, ideas]) => { window.workRows = rows; window.proposals = ideas; window.refresh(); }, [workRows(), proposals()]);
  await page.getByRole('link', { name: '受信箱（対応待ち3件）' }).waitFor();
  assert.deepEqual(await queue.locator('h2').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent.trim())),
    ['対応待ち', '提案', '直近7日'], 'the queue reads waiting items, proposals, then the figures');
  await queue.getByText('手が空いたときに').waitFor();
  for (const text of ['広報 · 削除の提案', '広報 · 延期の提案', 'VP · 仕分けの提案', 'VP · 新しいタスクの提案']) await queue.getByText(text).waitFor();
  await queue.getByRole('button', { name: /旧キャンペーン案の整理/ }).click();
  await card.getByText('サブタスクを含む4件を削除').waitFor();
  await card.getByRole('link', { name: '旧キャンペーン案の整理' }).waitFor();
  await noOverflow();
  await shoot('proposal');
  await card.getByRole('button', { name: '採用して削除' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:adoptProposal');
  assert.deepEqual((await lastCall()).args, { id: 'remove', expectedUserId: 'alice' });
  await card.getByText('2026/12/01まで延期', { exact: false }).waitFor();
  const toQueue = () => width <= 760 ? page.getByRole('button', { name: '一覧に戻る' }).click() : undefined;
  await toQueue();
  await queue.getByRole('button', { name: /配信先リスト/ }).click();
  await card.getByRole('button', { name: '採用' }).click();
  await page.getByRole('status').filter({ hasText: '提案のあとに変わったため、仕分けしませんでした' }).waitFor();
  await card.getByText('未仕分けに追加').waitFor();
  await card.getByText('月末に毎回手作業になっています。').waitFor();
  await card.getByRole('button', { name: '見送り' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:dismissProposal');
  assert.deepEqual((await lastCall()).args, { id: 'idea', expectedUserId: 'alice' });
  await page.getByRole('link', { name: '受信箱（対応待ち3件）' }).waitFor();

  await page.evaluate(() => { window.deferredUntil = '2026-12-01'; window.refresh(); });
  await toQueue();
  await queue.getByRole('button', { name: /告知ページをいつ公開するか/ }).click();
  await card.getByRole('link', { name: '告知文' }).click();
  const deferral = page.locator('.task-work-deferral');
  await deferral.getByText('2026/12/01まで。', { exact: false }).waitFor();
  await deferral.getByText('延期', { exact: true }).waitFor();
  await noOverflow();
  await deferral.getByRole('button', { name: '延期を取り消す' }).click();
  await deferral.waitFor({ state: 'detached' });
  assert.deepEqual(await lastCall(), { name: 'grokBot:cancelDeferral', args: { expectedUserId: 'alice', taskId: 'launch' } });
  await page.close();
}

async function vpSettings(width) {
  const page = await open(width, '/vp');
  await page.evaluate(() => {
    window.open = () => ({ location: { set href(value) { window.grokBotHandoff = value; } }, close() {} });
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedSetupValue = value; } } });
  });
  await page.addScriptTag({ content: outputFiles[0].text });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
  await page.getByText('VPは全ラベルと未仕分けのタスクを見て', { exact: false }).waitFor();
  await page.getByText('全体を見て提案するVPを任せます。', { exact: false }).waitFor();
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/vp-intro-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Grok Botで設定する' }).click();
  const handoff = page.getByRole('link', { name: 'Grok Botで設定する' });
  await handoff.waitFor();
  const added = await page.evaluate(() => window.calls.find(call => call.name === 'grokBot:addAssignment').args);
  assert.deepEqual(Object.keys(added).sort(), ['expectedUserId', 'token', 'vp']);
  assert.equal(added.vp, true);
  const prompt = new URL(await handoff.getAttribute('href')).searchParams.get('text');
  assert.match(prompt, /as my VP/);
  assert.match(prompt, /https:\/\/terminal.test\/grok-bot\/mcp\/vp-bot/);
  assert.match(prompt, /all_tasks/);
  assert.ok(prompt.length <= 1000 && !prompt.includes('\n'));
  assert.equal(new URL(await page.evaluate(() => window.grokBotHandoff)).searchParams.get('text'), prompt);
  await page.getByText('接続を管理', { exact: true }).click();
  await page.getByRole('button', { name: '手動で設定' }).click();
  await page.getByRole('button', { name: '接続キーを再発行' }).click();
  await page.getByRole('button', { name: 'Name をコピー', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedSetupValue), 'Terminal · VP');
  assert.deepEqual(Object.keys(await page.evaluate(() => window.calls.find(call => call.name === 'grokBot:rotateAssignmentToken').args)).sort(), ['expectedUserId', 'token', 'vp']);
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/vp-setup-${width}.png`, fullPage: true });
  await page.evaluate(() => { window.vp = { ...window.vp, connectorConnected: true, connected: true, webhookConfigured: true }; window.refresh(); });
  await page.getByText('接続済み', { exact: true }).first().waitFor();
  await page.getByRole('heading', { name: 'Grok Botの巡回' }).waitFor();
  await page.getByRole('checkbox', { name: '毎日巡回する' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:saveSchedule');
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { expectedUserId: 'alice', enabled: true, time: '03:00', vp: true });
  await page.getByRole('button', { name: '+ 出勤時刻を追加' }).click();
  await page.getByLabel('出勤時刻 2', { exact: true }).fill('18:30');
  await page.getByRole('button', { name: '+ 出勤時刻を追加' }).click();
  await page.getByRole('button', { name: '出勤時刻 3 を削除' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:saveSchedule' && window.calls.at(-1).args.times);
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { expectedUserId: 'alice', enabled: true, time: '03:00', vp: true, times: ['03:00', '18:30'] });
  await page.getByLabel('出勤時刻 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '今すぐ巡回させる' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:patrolNow');
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { expectedUserId: 'alice', vp: true });
  await page.getByText('巡回を依頼しました。').waitFor();
  await noOverflow();
  if (shots) await page.screenshot({ path: `${shots}/vp-connected-${width}.png`, fullPage: true });
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, '/grok-bot/authorize?' + new URLSearchParams({
    assignment: 'vp-bot', client_id: 'grok-bot', response_type: 'code', code_challenge_method: 'S256',
    code_challenge: 'x'.repeat(43), state: 'fixture-state', redirect_uri: 'https://www.cursor.com/bot/mcp/oauth/callback',
  }));
  await page.getByText(/VPとして、全ラベルと未仕分けのタスクの閲覧と、提案の送信を許可します/).waitFor();
  await page.close();
}

const recentCompletions = () => [
  { id: 'done-1', taskId: 'pricing', title: '料金表を更新する', label: '広報', labelId: 'press', headline: '料金表を税込みに直した', summary: '全プランの金額を税込みに統一しました。',
    links: ['https://example.test/pricing'], prUrl: 'https://github.com/example/press-site/pull/130', prHeadSha: sha, completedAt: Date.now() - 5 * 3_600_000, status: 'complete' },
  { id: 'done-2', taskId: 'faq', title: 'FAQを整える', label: '開発', labelId: 'development', headline: null, summary: 'FAQの重複を3件まとめました。',
    links: [], prUrl: null, prHeadSha: null, completedAt: Date.now() - 9 * 3_600_000, status: 'approved' },
];
const noSchedule = { enabled: false, times: ['06:00'], nextCheckAt: null, lastRunAt: null, lastStatus: null };
const team = () => ({ employees: [
  { id: 'press-bot', labelId: 'press', labelName: '広報', name: '広報Bot', connected: true, vp: false, defaultMode: 'review',
    schedule: { enabled: true, times: ['06:00', '18:00'], nextCheckAt: Date.now() + 3_600_000, lastRunAt: null, lastStatus: null },
    counts: { openTasks: 2, waiting: 1, review: 0, completedRecent: 1 },
    tasks: [{ id: 'launch', title: '告知文', botMode: 'review', inherited: true, waiting: 1, review: 0, answered: 0, merging: 0 },
      { id: 'pricing-page', title: '料金ページの差し替え（とても長いタスク名でも折り返して読めること）', botMode: 'execute', inherited: false, waiting: 0, review: 0, answered: 0, merging: 1 }] },
  { id: 'dev-bot', labelId: 'development', labelName: '開発', name: 'Grok Bot', connected: false, vp: false, defaultMode: 'checked', schedule: noSchedule,
    counts: { openTasks: 0, waiting: 0, review: 0, completedRecent: 0 }, tasks: [] },
  { id: 'vp-bot', labelId: '', labelName: 'VP', name: 'Grok Bot', connected: true, vp: true, defaultMode: 'review', schedule: noSchedule,
    counts: { openTasks: 0, waiting: 0, review: 0, completedRecent: 0 }, tasks: [] },
] });

async function completionsAndTeam(width) {
  const { page, noOverflow, shoot, queue, lastCall } = await inbox(width, '/inbox', () => {});
  await page.evaluate(([done, staff]) => { window.workRows = []; window.recentCompletions = done; window.team = staff; window.refresh(); }, [recentCompletions(), team()]);
  // Waking up to nothing blocked still shows what the Bots finished overnight.
  const empty = page.locator('.inbox-empty');
  await empty.getByRole('heading', { name: '対応待ちはありません' }).waitFor();
  const briefing = empty.getByRole('region', { name: '最近の成果' });
  await briefing.getByRole('link', { name: '料金表を更新する' }).waitFor();
  assert.equal(await briefing.getByRole('link', { name: '料金表を更新する' }).getAttribute('href'), '/?task=pricing');
  await briefing.getByText('料金表を税込みに直した').waitFor();
  await briefing.getByText('FAQの重複を3件まとめました。').waitFor();
  await briefing.getByRole('link', { name: 'example/press-site#130' }).waitFor();
  await briefing.getByRole('link', { name: 'https://example.test/pricing' }).waitFor();
  const toggle = queue.getByRole('button', { name: '最近の成果 2' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await queue.locator('.inbox-completions-list').getByRole('link', { name: 'FAQを整える' }).waitFor();
  await noOverflow();
  await shoot('completions');

  // Bot社員: one calm place to set each employee's posture, hand it goals and steer its tasks.
  const switcher = page.getByRole('navigation', { name: '受信箱の表示' });
  assert.equal(await switcher.getByRole('link', { name: '対応待ち' }).getAttribute('aria-current'), 'page');
  await switcher.getByRole('link', { name: 'Bot社員' }).click();
  assert.match(page.url(), /\/inbox\?view=team$/);
  assert.equal(await switcher.getByRole('link', { name: 'Bot社員' }).getAttribute('aria-current'), 'page');
  await page.getByRole('heading', { name: '受信箱', level: 1 }).waitFor();
  const press = page.locator('.bot-employee-card').filter({ has: page.getByRole('heading', { name: '広報Bot' }) });
  const dev = page.locator('.bot-employee-card').filter({ hasText: '開発' });
  await press.getByText('接続済み').waitFor();
  await press.getByText(/出勤 06:00・18:00 · 次回 \d\d:\d\d · 未完了 2件 · 回答待ち 1 · 72時間の成果 1件/).waitFor();
  await dev.getByText('設定途中').waitFor();
  assert.equal(await dev.getByRole('button', { name: '今すぐ巡回' }).count(), 0, 'an unconnected Bot is not called');
  assert.equal(await dev.getByRole('button', { name: '追加してすぐ巡回' }).count(), 0);
  await press.getByText('回答待ち', { exact: true }).waitFor();
  await press.getByText('マージ待ち', { exact: true }).waitFor();
  assert.equal(await press.getByRole('link', { name: '告知文' }).getAttribute('href'), '/?task=launch');
  await page.locator('.bot-employee-card').filter({ hasText: 'VP' }).getByText('VPは全ラベルを見て、提案だけを行います。').waitFor();
  await noOverflow();
  await shoot('team');

  await press.getByLabel('既定の任せ方').selectOption('checked');
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:setAssignmentDefaultMode');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', labelId: 'press', defaultMode: 'checked' });
  assert.equal(await press.getByLabel('この目標の任せ方').inputValue(), 'checked', 'a goal starts in the employee default');

  const goal = press.getByPlaceholder('成し遂げたいことを書く…');
  assert.equal(await press.getByRole('button', { name: '追加', exact: true }).isDisabled(), true);
  await goal.fill('採用ページを公開する');
  await goal.press('Enter');
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:assignGoalToBot');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', labelId: 'press', title: '採用ページを公開する', mode: 'checked' });
  await press.getByText('「採用ページを公開する」を追加しました。').waitFor();
  await press.getByRole('link', { name: '採用ページを公開する' }).waitFor();
  assert.equal(await goal.inputValue(), '');

  await goal.fill('請求書テンプレートを直す');
  await press.getByLabel('この目標の任せ方').selectOption('execute');
  await press.getByRole('button', { name: '追加してすぐ巡回' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.args.title === '請求書テンプレートを直す');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', labelId: 'press', title: '請求書テンプレートを直す', mode: 'execute', runNow: true });
  await press.getByText('「請求書テンプレートを直す」を追加しました。巡回を依頼しました。').waitFor();

  await press.getByLabel('関わり方: 告知文').selectOption('challenge');
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:setDelegation');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', taskId: 'launch', mode: 'challenge', execute: false });

  await press.getByRole('button', { name: '今すぐ巡回' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:patrolNow');
  assert.deepEqual((await lastCall()).args, { expectedUserId: 'alice', labelId: 'press' });
  await press.getByText('巡回を依頼しました。', { exact: true }).waitFor();
  await page.locator('.bot-employee-card').filter({ hasText: 'VP' }).getByRole('button', { name: '今すぐ巡回' }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.args.vp === true);
  await noOverflow();

  await switcher.getByRole('link', { name: '対応待ち' }).click();
  await empty.getByRole('heading', { name: '対応待ちはありません' }).waitFor();
  await page.close();
}

/** Approving can also save "this kind may proceed without asking", without slowing the one-key approval. */
async function autonomyApproval(width) {
  const { page, noOverflow, shoot, card, lastCall } = await inbox(width, '/inbox?item=review', () => {});
  await page.evaluate(([rows]) => { window.workRows = rows; window.refresh(); }, [workRows().slice(2, 3)]);
  await card.getByRole('heading', { name: '告知文の修正を仕上げた' }).waitFor();
  const disclosure = card.locator('details.work-card-autonomy');
  assert.equal(await disclosure.evaluate(node => node.open), false, 'the optional rule starts collapsed');
  await disclosure.getByText('承認と同時に自律ルールを追加（任意）').click();
  await card.getByLabel('この種は今後聞かずに進めてよい').fill('告知文の表記ゆれ修正は確認なしで完了してよい');
  await noOverflow();
  await shoot('autonomy');
  await card.getByRole('button', { name: /承認して完了/ }).click();
  await page.waitForFunction(() => window.calls.at(-1)?.name === 'grokBot:approveReview');
  assert.deepEqual((await lastCall()).args, { id: 'review', expectedUserId: 'alice', autonomyRule: '告知文の表記ゆれ修正は確認なしで完了してよい' });
  await page.close();
}

try {
  await consoleKeyboard();
  for (const width of [1280, 390]) await completionsAndTeam(width);
  for (const width of [1280, 390]) await autonomyApproval(width);
  for (const width of [1280, 390]) await designStudio(width);
  for (const width of [390, 320]) await consolePhone(width);
  for (const width of [1280, 390]) await pullRequestAndMetrics(width);
  for (const width of [1280, 390]) await legacyAndTaskPanel(width);
  for (const width of [1280, 390]) await proposalsAndDeferral(width);
  for (const width of [1280, 390]) await vpSettings(width);
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
  await page.getByRole('link', { name: '受信箱（対応待ち1件）' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '毎日巡回する' }).count(), 0, 'patrol schedules live in the connection settings, not the inbox');
  const go = path => page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await go('/patrol');
  await page.getByRole('heading', { name: 'メインBotの巡回' }).waitFor();
  await page.getByRole('checkbox', { name: '毎日巡回する' }).check();
  await page.getByLabel('巡回時刻').fill('04:25');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => window.schedule.time === '04:25' && window.schedule.enabled);
  assert.deepEqual(await page.evaluate(() => window.calls[0].args), { expectedUserId: 'alice', enabled: true, time: '04:25' });
  assert.equal(await page.getByRole('button', { name: '今すぐ巡回させる' }).count(), 0, 'the main Bot has no connection to call by hand');
  await page.evaluate(() => { window.norms = []; window.refresh(); });
  await go('/norms');
  await page.getByText('まだ規範はありません。', { exact: false }).waitFor();
  await page.getByLabel('新しい規範').fill('売上に直結しない改修は今月やらない');
  await page.getByLabel('規範の種類').selectOption('kill_criterion');
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByText('売上に直結しない改修は今月やらない').waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1).args), { expectedUserId: 'alice', text: '売上に直結しない改修は今月やらない', kind: 'kill_criterion' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await go('/inbox?item=question');
  await page.getByLabel('回答', { exact: true }).fill('11月予定で。');
  await page.getByRole('button', { name: '返信する' }).click();
  await page.getByRole('heading', { name: '対応待ちはありません' }).waitFor();
  await page.getByRole('button', { name: 'Botの反映待ち 1' }).click();
  await page.getByRole('button', { name: /回答済み・反映待ち/ }).click();
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
  console.log('Mobile: Bot handoff, label-specific consent, Routine validation, skins, patrol and inbox. Console: keyboard flow, irreversible double-confirm, auto-advance, phone navigation at 390/320, pull requests, older rows, task panel, proposals, deferral, VP settings, challenge cards, one-step greenlight, kill with learning, norms, multi-time clock-ins, overnight completions, Bot社員 and autonomy on approval.');
} finally {
  await browser.close();
}
