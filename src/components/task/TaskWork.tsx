import { useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { isCloudConfigured } from '../../lib/cloudConfig';
import { formatDuration, pullRequest } from '../../lib/grokBotWork';

type Work = NonNullable<FunctionReturnType<typeof api.grokBot.taskHistory>>['rows'][number];
type Pending = NonNullable<FunctionReturnType<typeof api.grokBot.inbox>>['pending'][number];
type Proposal = NonNullable<FunctionReturnType<typeof api.grokBot.inbox>>['proposals'][number];
type Metrics = NonNullable<FunctionReturnType<typeof api.grokBot.inbox>>['metrics'];
type Schedule = NonNullable<FunctionReturnType<typeof api.grokBot.schedule>>;
const reviewStatuses: Work['status'][] = ['review', 'approved', 'returned', 'revised', 'merging', 'merged', 'superseded'];
const isReview = (row: Pick<Work, 'status'>) => reviewStatuses.includes(row.status);

function useAccount() {
  const { userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  return isAuthenticated ? userId ?? null : null;
}

function AuthenticatedInboxLink({ onClick }: { onClick?: () => void }) {
  const userId = useAccount();
  const inbox = useQuery(api.grokBot.inbox, userId ? { expectedUserId: userId } : 'skip');
  const waiting = inbox?.pending.length ?? 0;
  // Quiet when nothing needs the human; a small count when something does. Never a colour alarm.
  return inbox ? (
    <NavLink to="/inbox" onClick={onClick} aria-label={waiting ? `受信箱（対応待ち${waiting}件）` : undefined}
      className={({ isActive }) => `nav-link nav-link--inbox${waiting ? ' has-waiting' : ''}${isActive ? ' active' : ''}`}>
      受信箱{waiting ? <span className="nav-count" aria-hidden>{waiting}</span> : null}
    </NavLink>
  ) : null;
}

export function TaskWorkInboxLink({ onClick }: { onClick?: () => void }) {
  return isCloudConfigured ? <AuthenticatedInboxLink onClick={onClick} /> : null;
}

export function TaskWorkInbox() {
  return isCloudConfigured ? <AuthenticatedInbox /> : <section className="task-action-page"><h1>受信箱</h1><p>アカウント接続が必要です。</p></section>;
}

function AuthenticatedInbox() {
  const userId = useAccount();
  const inbox = useQuery(api.grokBot.inbox, userId ? { expectedUserId: userId } : 'skip');
  const [first, ...rest] = inbox?.pending ?? [];
  // Top to bottom: the one bottleneck, the rest needing me, quiet proposals, work waiting on Bots, then the 7-day figures.
  // Patrol schedules live with the Bot connection settings, not here.
  return <section className="task-action-page task-work-inbox">
    <h1>受信箱</h1>
    {!userId ? <p>受信箱を見るにはサインインしてください。</p> :
      inbox === undefined ? <p role="status">読み込み中…</p> :
      inbox === null ? <p>Grok Botの担当ラベルが設定されていません。</p> :
      <>
        <p role="status" className="task-work-summary">{inbox.pending.length ? `対応待ち ${inbox.pending.length}件` : 'いま対応が必要なものはありません。'}</p>
        {first ? <section className="task-work-card task-work-focus" aria-labelledby="task-work-next">
          <h2 className="task-work-heading" id="task-work-next">次に対応する1件</h2>
          <InboxItem key={first.id} row={first} userId={userId} />
        </section> : null}
        {rest.length ? <section className="task-work-group" aria-labelledby="task-work-rest">
          <h2 className="task-work-heading" id="task-work-rest">ほかの対応待ち <span className="task-work-count">{rest.length}</span></h2>
          <ul className="task-work-list">
            {rest.map(row => <li className="task-work-card" key={row.id}><InboxItem row={row} userId={userId} /></li>)}
          </ul>
        </section> : null}
        {inbox.proposals.length ? <Proposals rows={inbox.proposals} userId={userId} /> : null}
        {inbox.answered.length ? <section className="task-work-group task-work-awaiting" aria-labelledby="task-work-awaiting">
          <h2 className="task-work-heading" id="task-work-awaiting">Botの反映待ち</h2>
          <ul className="task-work-list">
            {inbox.answered.map(row => <li className="task-work-card" key={row.id}><InboxItem row={row} userId={userId} /></li>)}
          </ul>
        </section> : null}
        <WorkMetrics metrics={inbox.metrics} />
      </>}
  </section>;
}

function InboxItem({ row, userId }: { row: Omit<Pending, 'stalled' | 'openTasks'> & { stalled?: boolean }; userId: string }) {
  return <>
    <p className="task-work-status">{row.label} · {isReview(row) ? row.prUrl ? 'プルリクエストの確認' : '完了の確認' : '判断依頼'}{row.stalled ? ' · Botの手が止まっています' : ''}</p>
    <h3><Link to={`/?task=${encodeURIComponent(row.taskId)}`}>{row.title}</Link></h3>
    <WorkItem key={userId} row={row} userId={userId} canReply />
  </>;
}

/** Quiet outcome figures for the last 7 days. Not a score: no colours, no streaks. */
function WorkMetrics({ metrics }: { metrics: Metrics }) {
  const none = '—';
  return <section className="task-work-metrics" aria-labelledby="task-work-metrics">
    <h2 className="task-work-heading" id="task-work-metrics">直近7日</h2>
    <dl>
      <div><dt>回答までの時間（中央値）</dt><dd>{metrics.medianAnswerMs === null ? none : formatDuration(metrics.medianAnswerMs)}</dd></div>
      <div><dt>差し戻し率</dt><dd>{metrics.returnRate === null ? none : <>{Math.round(metrics.returnRate * 100)}%
        <span className="task-work-count"> {metrics.returned}/{metrics.reviewed}件</span></>}</dd></div>
      <div><dt>前に進んだ件数</dt><dd>{metrics.forwardWeek ? <>{metrics.forwardWeek}件
        <span className="task-work-count"> 今日 {metrics.forwardToday}件</span></> : none}</dd></div>
    </dl>
  </section>;
}

const proposalKinds: Record<Proposal['kind'], string> = { delete: '削除', defer: '延期', move: '仕分け', new_task: '新しいタスク' };
const formatDay = (day: string) => day.replaceAll('-', '/');

/** Bot ideas. Quieter than decisions: they never block a Bot and only change anything once adopted. */
function Proposals({ rows, userId }: { rows: Proposal[]; userId: string }) {
  const [notice, setNotice] = useState('');
  return <section className="task-work-proposals" aria-labelledby="task-work-proposals">
    <h2 className="task-work-heading" id="task-work-proposals">提案 <span className="task-work-count">{rows.length}</span></h2>
    <p className="task-work-hint">採用するまで何も変わりません。Botの手も止めません。</p>
    {notice ? <p role="status" className="task-work-status">{notice}</p> : null}
    <ul className="task-work-list">
      {rows.map(row => <li className="task-work-card" key={row.id}><ProposalItem row={row} userId={userId} onChanged={setNotice} /></li>)}
    </ul>
  </section>;
}

function proposalEffect(row: Proposal) {
  switch (row.kind) {
    case 'delete': return row.count && row.count > 1 ? `サブタスクを含む${row.count}件を削除` : '削除';
    case 'defer': return `${formatDay(row.until ?? '')}まで延期（それまでBotの一覧に出ません）`;
    case 'move': return `「${row.labelName ?? '見つからないラベル'}」へ移動`;
    case 'new_task': return row.labelId ? `「${row.labelName ?? '見つからないラベル'}」に追加` : '未仕分けに追加';
  }
}

function ProposalItem({ row, userId, onChanged }: { row: Proposal; userId: string; onChanged: (notice: string) => void }) {
  const adopt = useMutation(api.grokBot.adoptProposal);
  const dismiss = useMutation(api.grokBot.dismissProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const subject = row.kind === 'new_task' ? row.title : row.taskTitle;
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'status' in result && result.status === 'changed') {
        onChanged(`「${subject ?? 'タスク'}」は提案のあとに変わったため、${proposalKinds[row.kind]}しませんでした。`);
      }
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '送信できませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }
  const args = { id: row.id, expectedUserId: userId };
  return <>
    <p className="task-work-status">{row.vp ? 'VP' : `${row.proposer}のBot`} · {proposalKinds[row.kind]}の提案</p>
    <h3>{row.kind === 'new_task' ? row.title : row.taskId && subject !== undefined
      ? <Link to={`/?task=${encodeURIComponent(row.taskId)}`}>{subject}</Link> : '見つからないタスク'}</h3>
    <p className="task-work-effect">{proposalEffect(row)}</p>
    {row.note ? <p className="task-work-text task-work-note">{row.note}</p> : null}
    <p className="task-work-text">{row.reason}</p>
    <div className="task-work-choices">
      <button type="button" className={`ghost-btn${row.kind === 'delete' ? ' is-danger' : ''}`} disabled={busy} onClick={() => { void run(() => adopt(args)); }}>
        {row.kind === 'delete' ? '採用して削除' : '採用'}</button>
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void run(() => dismiss(args)); }}>見送り</button>
    </div>
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </>;
}

/** The main Bot's daily patrol, shown with the other Bot connection settings. Renders nothing without a main Bot. */
export function MainBotPatrolSettings() {
  return isCloudConfigured ? <AuthenticatedMainBotPatrol /> : null;
}

function AuthenticatedMainBotPatrol() {
  const userId = useAccount();
  const schedule = useQuery(api.grokBot.schedule, userId ? { expectedUserId: userId } : 'skip');
  return userId && schedule ? <section className="settings-section" aria-labelledby="settings-main-patrol-title">
    <h3 id="settings-main-patrol-title">メインBotの巡回</h3>
    <div className="settings-group settings-block">
      <PatrolSettings key={`${userId}:${schedule.time}:${schedule.enabled}`} schedule={schedule} userId={userId} heading={false} />
    </div>
  </section> : null;
}

export function LabelPatrolSettings({ labelId, vp, userId }: { labelId?: string; vp?: boolean; userId: string }) {
  const target = vp ? { vp: true as const } : { labelId };
  const schedule = useQuery(api.grokBot.schedule, { expectedUserId: userId, ...target });
  return schedule ? <PatrolSettings key={`${schedule.time}:${schedule.enabled}`} schedule={schedule} userId={userId} target={target} /> : null;
}

function PatrolSettings({ schedule, userId, target, heading = true }: { schedule: Schedule; userId: string; target?: { labelId?: string; vp?: true }; heading?: boolean }) {
  const save = useMutation(api.grokBot.saveSchedule);
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [time, setTime] = useState(schedule.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = enabled !== schedule.enabled || time !== schedule.time;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError('');
    try {
      await save({ expectedUserId: userId, enabled, time, ...target });
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '巡回時刻を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  const lastStatus = schedule.lastStatus === 'accepted' ? 'Grok Botが受付' : schedule.lastStatus === 'failed' ? '呼び出しに失敗' : '呼び出し中';
  return <section className={`task-work-patrol${heading ? '' : ' is-embedded'}`}>
    {heading ? <h2>Grok Botの巡回</h2> : null}
    <form onSubmit={event => { void submit(event); }}>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> 毎日巡回する</label>
      <label> 巡回時刻 <input type="time" className="inspector-input" value={time} onChange={event => setTime(event.target.value)} required /></label>
      <button type="submit" className="ghost-btn" disabled={busy || !changed}>{busy ? '保存中…' : '保存'}</button>
    </form>
    <p className="task-work-hint">{schedule.timeZone ? `タイムゾーン ${schedule.timeZone}` : '先に 設定 › 一般 でタイムゾーンを保存してください。'}</p>
    {schedule.lastRunAt ? <p role="status" className="task-work-hint">前回 {formatTime(schedule.lastRunAt, schedule.timeZone ?? undefined)} · {lastStatus}</p> : null}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </section>;
}

export function TaskWorkSection({ taskId }: { taskId: string }) {
  return isCloudConfigured ? <AuthenticatedTaskWork key={taskId} taskId={taskId} /> : null;
}

function AuthenticatedTaskWork({ taskId }: { taskId: string }) {
  const userId = useAccount();
  const data = useQuery(api.grokBot.taskHistory, userId ? { taskId, expectedUserId: userId } : 'skip');
  if (!userId || !data) return null;
  const { rows, canReply, mayExecute, reviewRequired, deferredUntil } = data;
  const decisions = rows.filter(row => row.status === 'waiting' || row.status === 'answered' || row.status === 'applied' || isReview(row));
  const results = rows.filter(row => row.status === 'progress' || row.status === 'complete');
  return <>
    {deferredUntil ? <TaskDeferral taskId={taskId} userId={userId} until={deferredUntil} /> : null}
    {canReply ? <TaskDelegation key={userId} taskId={taskId} userId={userId} role={mayExecute ? reviewRequired ? 'checked' : 'execute' : 'review'} /> : null}
    {decisions.length ? <section className="inspector-section">
      <h3 className="inspector-label">Botとのやりとり</h3>
      <ul className="task-work-list">{decisions.map(row => <li className="task-work-card" key={row.id}>
        <WorkItem key={userId} row={row} userId={userId} canReply={canReply && row.canReply} />
      </li>)}</ul>
    </section> : null}
    {results.length ? <section className="inspector-section">
      <h3 className="inspector-label">Botの作業報告</h3>
      <ul className="task-work-list">{results.map(row => <li className="task-work-card" key={row.id}>
        <span className="task-work-status">{row.status === 'complete' ? '完了報告' : '途中経過'} · {formatTime(row.createdAt)}</span>
        <p className="task-work-text">{row.text}</p>
        <WorkLinks links={row.links} />
      </li>)}</ul>
    </section> : null}
  </>;
}

function TaskDeferral({ taskId, userId, until }: { taskId: string; userId: string; until: string }) {
  const cancel = useMutation(api.grokBot.cancelDeferral);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="inspector-prop task-work-deferral">
    <p><span className="task-work-badge">延期</span> {formatDay(until)}まで。それまでGrok Botの一覧に出ません。</p>
    <button type="button" className="ghost-btn" disabled={busy} onClick={() => {
      setBusy(true);
      setError('');
      cancel({ expectedUserId: userId, taskId }).catch(() => {
        setError('延期を取り消せませんでした。もう一度お試しください。');
        setBusy(false);
      });
    }}>延期を取り消す</button>
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </div>;
}

type Role = 'review' | 'execute' | 'checked';

function TaskDelegation({ taskId, userId, role }: { taskId: string; userId: string; role: Role }) {
  const setDelegation = useMutation(api.grokBot.setDelegation);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(next: Role) {
    setBusy(true);
    setError('');
    try {
      await setDelegation({ expectedUserId: userId, taskId, execute: next !== 'review', ...(next === 'checked' ? { reviewCompletion: true } : {}) });
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : 'Grok Botの関わり方を変更できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="inspector-prop task-work-delegation">
    <label className="inspector-label" htmlFor={inputId}>Grok Botの関わり方</label>
    <select id={inputId} className="inspector-input task-work-role" value={role} disabled={busy}
      onChange={event => { void change(event.target.value as Role); }}>
      <option value="review">確認・監査</option>
      <option value="execute">実行も任せる</option>
      <option value="checked">実行を任せ、完了は必ず確認</option>
    </select>
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </div>;
}

const formatTime = (time: number, timeZone?: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(time);

function WorkLinks({ links: all, except }: { links?: string[]; except?: string }) {
  const links = all?.filter(link => link !== except);
  return links?.length ? <ul className="task-work-links">{links.map(link =>
    <li key={link}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>
  )}</ul> : null;
}

function PullRequest({ url, sha }: { url: string; sha?: string }) {
  return <p className="task-work-pr">
    <span className="task-work-status">プルリクエスト</span>
    <a href={url} target="_blank" rel="noopener noreferrer">{pullRequest(url)?.label ?? url}</a>
    {sha ? <code title={sha}>{sha.slice(0, 7)}</code> : null}
  </p>;
}

function statusText(row: Omit<Work, 'canReply'>, canReply: boolean) {
  const wake = row.wakeStatus === 'failed' ? '再開通知に失敗' : row.wakeStatus === 'accepted' ? '反映待ち' : '通知中';
  switch (row.status) {
    case 'applied': return '反映済み';
    case 'approved': return '承認済み';
    case 'merged': return '承認済み・マージ済み';
    case 'superseded': return '承認後に新しいコミットで再提出';
    case 'merging': return canReply ? `承認済み・Botのマージ待ち${row.wakeStatus === 'failed' ? '・再開通知に失敗' : ''}` : '受付終了';
    case 'revised': return '差し戻し・反映済み';
    case 'waiting': return canReply ? '回答待ち' : '受付終了';
    case 'review': return canReply ? row.prHeadSha ? 'マージ前の確認待ち' : '確認待ち' : '受付終了';
    case 'answered': return canReply ? `回答済み・${wake}` : '受付終了';
    case 'returned': return canReply ? `差し戻し・${wake}` : '受付終了';
    default: return '';
  }
}

function WorkItem({ row, userId, canReply }: { row: Omit<Work, 'canReply'>; userId: string; canReply: boolean }) {
  const inputId = useId();
  const reply = useMutation(api.grokBot.reply);
  const retry = useMutation(api.grokBot.retry);
  const approve = useMutation(api.grokBot.approveReview);
  const sendBack = useMutation(api.grokBot.returnReview);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryReady, setRetryReady] = useState(false);
  const review = isReview(row);
  const awaitsBot = row.status === 'answered' || row.status === 'returned' || row.status === 'merging';
  useEffect(() => {
    if (!awaitsBot || !row.wakeAt) return;
    const timer = setTimeout(() => setRetryReady(true), Math.max(0, row.wakeAt + 60_000 - Date.now()));
    return () => { clearTimeout(timer); setRetryReady(false); };
  }, [awaitsBot, row.wakeAt]);

  async function run(action: () => Promise<unknown>, clear = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      if (clear) setDraft('');
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '送信できませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  const args = { id: row.id, expectedUserId: userId };
  const answer = (text: string) => run(() => reply({ ...args, answer: text }), true);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    void (review ? run(() => sendBack({ ...args, comment: draft }), true) : answer(draft));
  }
  const recommended = row.recommendation;
  const choices = row.kind === 'approval' ? ['承認', '却下'] : row.kind === 'choice' ? row.options ?? [] : [];
  const open = canReply && (row.status === 'waiting' || row.status === 'review');
  return <>
    <span className="task-work-status" role="status">{statusText(row, canReply)} · Grok Bot · {formatTime(row.createdAt)}</span>
    {row.irreversible ? <span className="task-work-badge">不可逆</span> : null}
    <p className="task-work-text">{row.text}</p>
    {recommended && !choices.includes(recommended) ? <p className="task-work-text task-work-note"><strong>推奨</strong>{'\n'}{recommended}</p> : null}
    {row.assumptions ? <p className="task-work-text task-work-note"><strong>Botが補った前提・判断</strong>{'\n'}{row.assumptions}</p> : null}
    {row.prUrl ? <PullRequest url={row.prUrl} sha={row.prHeadSha} /> : null}
    <WorkLinks links={row.links} except={row.prUrl} />
    {row.answer ? <p className="task-work-text task-work-answer"><strong>{review ? '差し戻しの理由' : 'あなたの回答'}</strong>{'\n'}{row.answer}</p> : null}
    {open && !review && (choices.length || recommended) ? <div className="task-work-choices" role="group" aria-label="すぐに回答">
      {recommended ? <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void answer(recommended); }}>推奨どおり</button> : null}
      {choices.map(choice => <button type="button" key={choice} className={`ghost-btn${choice === recommended ? ' is-primary is-recommended' : ''}`}
        disabled={busy} onClick={() => { void answer(choice); }}>
        {choice}{choice === recommended ? <span className="task-work-badge">推奨</span> : null}
      </button>)}
    </div> : null}
    {open && review ? <div className="task-work-choices">
      <button type="button" className="ghost-btn is-primary" disabled={busy} aria-describedby={row.prHeadSha ? `${inputId}-merge` : undefined}
        onClick={() => { void run(() => approve(args)); }}>{row.prHeadSha ? '承認してマージを任せる' : '承認して完了'}</button>
      {row.prHeadSha ? <p className="task-work-hint" id={`${inputId}-merge`}>承認すると、Botがこのコミットをマージします。マージすると本番に公開されます。</p> : null}
    </div> : null}
    {open ? <form className="task-work-reply" onSubmit={submit}>
      <label htmlFor={inputId}>{review ? '差し戻しの理由' : '回答'}</label>
      <textarea id={inputId} rows={2} className="inspector-note" value={draft} maxLength={8000}
        onChange={event => setDraft(event.target.value)} required />
      <button type="submit" className="ghost-btn" disabled={busy || !draft.trim()}>{review ? '差し戻す' : '返信する'}</button>
    </form> : null}
    {canReply && awaitsBot && (row.wakeStatus === 'failed' || retryReady) ?
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void run(() => retry(args)); }}>担当Botに再通知</button> : null}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </>;
}
