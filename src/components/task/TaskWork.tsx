import { useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { FunctionReturnType } from 'convex/server';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../../convex/_generated/api';
import { isCloudConfigured } from '../../lib/cloudConfig';
import { formatDuration, pullRequest } from '../../lib/grokBotWork';

type Work = NonNullable<FunctionReturnType<typeof api.grokBot.taskHistory>>['rows'][number];
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
  // Patrol schedules live with the Bot connection settings, not here.
  return <section className="task-work-inbox">
    <header className="inbox-header">
      <h1>受信箱</h1>
      {userId && inbox ? <p role="status" className="task-work-summary">{inbox.pending.length ? `対応待ち ${inbox.pending.length}件` : '対応待ちはありません'}</p> : null}
    </header>
    {!userId ? <p className="task-work-hint">受信箱を見るにはサインインしてください。</p> :
      inbox === undefined ? <p role="status" className="task-work-hint">読み込み中…</p> :
      inbox === null ? <p className="task-work-hint">Grok Botの担当ラベルが設定されていません。</p> :
      <InboxConsole inbox={inbox} userId={userId} />}
  </section>;
}

type Inbox = NonNullable<FunctionReturnType<typeof api.grokBot.inbox>>;
/** A row with its task and label, as the inbox places it. */
type Placed = Omit<Work, 'canReply'> & { taskId: string; title: string; label: string; stalled?: boolean; openTasks?: number };

const kindName = (row: Pick<Work, 'status' | 'prUrl'>) => isReview(row) ? row.prUrl ? 'プルリクエストの確認' : '完了の確認' : '判断依頼';
const headlineOf = (row: Pick<Work, 'headline' | 'text'>) => row.headline ?? row.text.split('\n')[0];
/** A second press sooner than this is a stray double press, never a confirmation. */
const strayPressMs = 400;

/** A key meant for the inbox: no modifier, no text field focused, and focus on the page or inside the inbox. */
function inboxKey(event: KeyboardEvent, root: HTMLElement | null) {
  if (!root || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const active = document.activeElement;
  if (active && active !== document.body && !root.contains(active)) return null;
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'))) return null;
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

function patrolTime(at: number, now: number) {
  const time = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(at);
  return new Date(at).toDateString() === new Date(now).toDateString() ? time
    : `${new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(at)} ${time}`;
}

/**
 * One console: the queue on the left in bottleneck order, the selected card on the right. On a phone the queue and
 * the card take turns. Skips and the unblocked tally belong to this visit only.
 */
function InboxConsole({ inbox, userId }: { inbox: Inbox; userId: string }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  /** The item to focus once it is on screen ('' for the empty state); null when focus should stay put. */
  const focusTarget = useRef<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [resolved, setResolved] = useState<ReadonlyMap<string, number>>(new Map());
  const [legend, setLegend] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState('');
  const pending = [...inbox.pending.filter(row => !skipped.includes(row.id)),
    ...skipped.map(id => inbox.pending.find(row => row.id === id)).filter(row => row !== undefined)];
  const itemId = params.get('item');
  const selectedPending = pending.find(row => row.id === itemId);
  const proposal = inbox.proposals.find(row => row.id === itemId);
  const answered = inbox.answered.find(row => row.id === itemId);
  const explicit = !!(selectedPending || proposal || answered);
  const current = explicit ? selectedPending : pending[0];
  const currentId = explicit ? itemId : current?.id ?? null;
  const [showAwaiting, setShowAwaiting] = useState(!!answered);
  const queue: string[] = [...pending.map(row => row.id), ...inbox.proposals.map(row => row.id)];
  const unblocked = [...resolved].filter(([taskId]) => !inbox.pending.some(row => row.taskId === taskId)).reduce((sum, [, count]) => sum + count, 0);

  function select(id: string | null, push = false) {
    const next = new URLSearchParams(params);
    if (id) next.set('item', id);
    else next.delete('item');
    setNotice('');
    setParams(next, { replace: !push, state: push ? { fromQueue: true } : location.state });
  }

  function move(delta: number) {
    if (!queue.length) return;
    const index = currentId ? queue.indexOf(currentId) : -1;
    const next = queue[Math.min(queue.length - 1, Math.max(0, index + delta))];
    if (next && next !== currentId) {
      focusTarget.current = next;
      select(next);
    }
  }

  /** After an answer, approval or skip: the next item in the same section opens and keeps the keyboard. */
  function advance(id: string, section: { id: string; title: string }[], prefix = '') {
    const rest = section.filter(other => other.id !== id);
    const next = rest[section.findIndex(other => other.id === id)] ?? rest[0];
    // Past the last proposal, the pane falls back to the first waiting item, if any.
    const fallback = next ? undefined : pending.find(row => row.id !== id && section.every(other => other.id !== row.id));
    const title = next?.title ?? (fallback && headlineOf(fallback));
    focusTarget.current = next?.id ?? fallback?.id ?? '';
    setAnnouncement(`${prefix}${title ? `次の対応: ${title}` : '対応待ちはありません'}`);
    select(next?.id ?? null);
  }

  const waitingSection = () => pending.map(row => ({ id: row.id, title: headlineOf(row) }));
  const resolvePending = (row: Placed) => {
    setResolved(previous => new Map(previous).set(row.taskId, Math.max(previous.get(row.taskId) ?? 0, row.openTasks ?? 1)));
    advance(row.id, waitingSection());
  };
  const resolveProposal = (id: string) => advance(id, inbox.proposals.map(row => ({ id: row.id, title: proposalSubject(row) ?? '提案' })));

  // Once the item moved to is on screen, the keyboard stays in the console.
  useEffect(() => {
    const node = paneRef.current?.querySelector<HTMLElement>('[data-pane-focus]');
    if (focusTarget.current === null || node?.dataset.item !== focusTarget.current) return;
    focusTarget.current = null;
    node.focus();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = inboxKey(event, rootRef.current);
      if (key === null || !rootRef.current?.offsetParent) return;
      if (key === 'j' || key === 'ArrowDown') move(1);
      else if (key === 'k' || key === 'ArrowUp') move(-1);
      else if (key === 's' && current && pending.length > 1) {
        setSkipped(previous => [...previous.filter(id => id !== current.id), current.id]);
        advance(current.id, waitingSection(), '後回しにしました。');
      } else if (key === '?') setLegend(open => !open);
      else if (key === 'Escape' && legend) setLegend(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const back = () => {
    if ((location.state as { fromQueue?: boolean } | null)?.fromQueue) navigate(-1);
    else select(null);
  };

  return <div ref={rootRef} className={`inbox-console${explicit ? ' is-detail' : ''}${pending.length ? '' : ' is-empty'}`}>
    <section className="inbox-queue" aria-label="対応の一覧">
      {pending.length ? <section aria-labelledby="inbox-waiting">
        <h2 className="inbox-queue-heading" id="inbox-waiting">対応待ち <span className="task-work-count">{pending.length}</span></h2>
        <ul className="inbox-queue-list">{pending.map(row => <li key={row.id}>
          <button type="button" className="inbox-row" aria-current={row.id === currentId ? 'true' : undefined} onClick={() => select(row.id, true)}>
            <span className="inbox-row-meta">{row.label} · {kindName(row)}{row.openTasks ? ` · ${row.openTasks}件停止` : ''}
              {row.irreversible ? <span className="inbox-row-mark">不可逆</span> : null}</span>
            <span className="inbox-row-title">{headlineOf(row)}</span>
          </button>
        </li>)}</ul>
      </section> : null}
      {inbox.proposals.length ? <section aria-labelledby="inbox-proposals" className="inbox-queue-proposals">
        <h2 className="inbox-queue-heading" id="inbox-proposals">提案 <span className="task-work-hint">手が空いたときに</span></h2>
        <ul className="inbox-queue-list">{inbox.proposals.map(row => <li key={row.id}>
          <button type="button" className="inbox-row" aria-current={row.id === currentId ? 'true' : undefined} onClick={() => select(row.id, true)}>
            <span className="inbox-row-meta">{row.vp ? 'VP' : row.proposer} · {proposalKinds[row.kind]}の提案</span>
            <span className="inbox-row-title">{proposalSubject(row) ?? '見つからないタスク'}</span>
          </button>
        </li>)}</ul>
      </section> : null}
      <div className="inbox-status">
        <p>{inbox.answered.length
          ? <button type="button" className="inbox-status-toggle" aria-expanded={showAwaiting} onClick={() => setShowAwaiting(open => !open)}>
            Botの反映待ち {inbox.answered.length}</button>
          : <span>Botの反映待ち 0</span>}
          <span aria-hidden> · </span><span>次の巡回 {inbox.nextPatrolAt ? <PatrolTime at={inbox.nextPatrolAt} /> : '未設定'}</span></p>
        {showAwaiting && inbox.answered.length ? <ul className="inbox-queue-list">{inbox.answered.map(row => <li key={row.id}>
          <button type="button" className="inbox-row is-quiet" aria-current={row.id === currentId ? 'true' : undefined} onClick={() => select(row.id, true)}>
            <span className="inbox-row-meta">{row.label} · {statusText(row, true)}</span>
            <span className="inbox-row-title">{headlineOf(row)}</span>
          </button>
        </li>)}</ul> : null}
      </div>
      {pending.length ? <WorkMetrics metrics={inbox.metrics} /> : null}
      <p className="inbox-keys-hint"><kbd>J</kbd><kbd>K</kbd> 移動 · <kbd>S</kbd> 後回し · <kbd>?</kbd> キー一覧</p>
    </section>
    <div className="inbox-pane" ref={paneRef}>
      <button type="button" className="inbox-back" onClick={back}><ChevronLeft size={16} aria-hidden />一覧に戻る</button>
      {notice ? <p role="status" className="task-work-hint inbox-notice">{notice}</p> : null}
      {current ? <WorkCard key={current.id} row={current} userId={userId} canReply keyRoot={rootRef} onResolved={() => resolvePending(current)} />
        : proposal ? <article key={proposal.id} className="work-card is-proposal" tabIndex={-1} data-pane-focus data-item={proposal.id} aria-label={`${proposalKinds[proposal.kind]}の提案`}>
          <ProposalItem row={proposal} userId={userId} onChanged={setNotice} onResolved={() => resolveProposal(proposal.id)} />
        </article>
        : answered ? <WorkCard key={answered.id} row={answered} userId={userId} canReply />
        : <div className="inbox-empty">
          <h2 tabIndex={-1} data-pane-focus data-item="">対応待ちはありません</h2>
          {unblocked ? <p>この間に{unblocked}件が動き出しました。</p> : <p className="task-work-hint">Botが判断や確認を求めると、ここに届きます。</p>}
          <WorkMetrics metrics={inbox.metrics} />
        </div>}
    </div>
    {legend ? <KeyLegend onClose={() => setLegend(false)} /> : null}
    <p className="task-work-live" aria-live="polite">{announcement}</p>
  </div>;
}

function PatrolTime({ at }: { at: number }) {
  const [now] = useState(Date.now);
  return <time dateTime={new Date(at).toISOString()}>{patrolTime(at, now)}</time>;
}

function KeyLegend({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [['1–4', '選択肢を選ぶ'], ['Enter', '確定（取り消せない選択は2回）'], ['J / ↓', '次へ'], ['K / ↑', '前へ'],
    ['S', 'このセッションの最後に回す'], ['A', '確認依頼を承認'], ['R', '差し戻しの理由を書く'], ['?', 'この一覧']];
  return <section className="inbox-legend" aria-labelledby="inbox-legend-title">
    <h2 id="inbox-legend-title">キー操作</h2>
    <dl>{keys.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl>
    <button type="button" className="ghost-btn" onClick={onClose}>閉じる</button>
  </section>;
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
const proposalSubject = (row: Proposal) => row.kind === 'new_task' ? row.title : row.taskTitle;

function proposalEffect(row: Proposal) {
  switch (row.kind) {
    case 'delete': return row.count && row.count > 1 ? `サブタスクを含む${row.count}件を削除` : '削除';
    case 'defer': return `${formatDay(row.until ?? '')}まで延期（それまでBotの一覧に出ません）`;
    case 'move': return `「${row.labelName ?? '見つからないラベル'}」へ移動`;
    case 'new_task': return row.labelId ? `「${row.labelName ?? '見つからないラベル'}」に追加` : '未仕分けに追加';
  }
}

/** A Bot idea. Quieter than decisions: it never blocks a Bot and only changes anything once adopted. */
function ProposalItem({ row, userId, onChanged, onResolved }: { row: Proposal; userId: string; onChanged: (notice: string) => void; onResolved: () => void }) {
  const adopt = useMutation(api.grokBot.adoptProposal);
  const dismiss = useMutation(api.grokBot.dismissProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const subject = proposalSubject(row);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      onResolved();
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
    <p className="work-card-meta">{row.vp ? 'VP' : `${row.proposer}のBot`} · {proposalKinds[row.kind]}の提案 · 採用するまで何も変わりません</p>
    <h3 className="work-card-headline">{row.kind === 'new_task' ? row.title : row.taskId && subject !== undefined
      ? <Link to={`/?task=${encodeURIComponent(row.taskId)}`}>{subject}</Link> : '見つからないタスク'}</h3>
    <p className="task-work-effect">{proposalEffect(row)}</p>
    {row.note ? <p className="task-work-text task-work-note">{row.note}</p> : null}
    <p className="work-card-context">{row.reason}</p>
    <div className="work-card-actions">
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
      <ul className="task-work-list">{decisions.map(row => <li key={row.id}>
        <WorkCard key={userId} row={row} userId={userId} canReply={canReply && row.canReply} />
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

function WorkLinks({ links }: { links?: string[] }) {
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

const confidenceNames = { high: '高', medium: '中', low: '低' } as const;

/** The answers a card offers. Older rows flag the whole question, so each of their answers is treated as irreversible. */
function choicesOf(row: Omit<Work, 'canReply'>) {
  const legacyIrreversible = !row.headline && !!row.irreversible;
  const options = row.kind === 'approval' && !row.options ? [{ label: '承認' }, { label: '却下' }]
    : row.kind === 'approval' || row.kind === 'choice' ? row.options ?? [] : [];
  return options.map(option => ({ label: option.label, consequence: 'consequence' in option ? option.consequence : undefined,
    irreversible: ('irreversible' in option && !!option.irreversible) || legacyIrreversible }));
}

/** Holding Enter must not repeat a confirmation. */
const noRepeat = (event: ReactKeyboardEvent) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); };

/**
 * One decision or review in a fixed layout: meta, headline, context, options or what was done, the reason, what to
 * check, evidence, then actions. Rows without a headline predate cards and show their question as written.
 * With keyRoot the card answers to the inbox keys.
 */
function WorkCard({ row, userId, canReply, keyRoot, onResolved }: {
  row: Omit<Work, 'canReply'> & Partial<Pick<Placed, 'taskId' | 'title' | 'label' | 'stalled' | 'openTasks'>>;
  userId: string; canReply: boolean; keyRoot?: RefObject<HTMLElement | null>; onResolved?: () => void;
}) {
  const id = useId();
  const cardRef = useRef<HTMLElement>(null);
  const optionsRef = useRef<HTMLOListElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const reply = useMutation(api.grokBot.reply);
  const retry = useMutation(api.grokBot.retry);
  const approve = useMutation(api.grokBot.approveReview);
  const sendBack = useMutation(api.grokBot.returnReview);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryReady, setRetryReady] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [armed, setArmed] = useState<{ target: string; at: number } | null>(null);
  const [writing, setWriting] = useState(false);
  const review = isReview(row);
  const awaitsBot = row.status === 'answered' || row.status === 'returned' || row.status === 'merging';
  const open = canReply && (row.status === 'waiting' || row.status === 'review');
  const choices = choicesOf(row);
  const freeText = !review && (row.kind ?? 'info') === 'info';
  const showForm = open && (freeText || writing);
  useEffect(() => {
    if (!awaitsBot || !row.wakeAt) return;
    const timer = setTimeout(() => setRetryReady(true), Math.max(0, row.wakeAt + 60_000 - Date.now()));
    return () => { clearTimeout(timer); setRetryReady(false); };
  }, [awaitsBot, row.wakeAt]);

  async function run(action: () => Promise<unknown>, done?: () => void) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setDraft('');
      setArmed(null);
      done?.();
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '送信できませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  /** Irreversible actions take a second, deliberate press. */
  function guarded(target: string, irreversible: boolean, act: () => void) {
    if (!irreversible) return act();
    const now = Date.now();
    if (armed?.target !== target) setArmed({ target, at: now });
    else if (now - armed.at >= strayPressMs) act();
  }

  const args = { id: row.id, expectedUserId: userId };
  const answer = (text: string) => run(() => reply({ ...args, answer: text }), onResolved);
  const choose = (index: number) => {
    setSelected(index);
    guarded(choices[index].label, choices[index].irreversible, () => { void answer(choices[index].label); });
  };
  const approveNow = () => guarded('approve', !!row.prHeadSha, () => { void run(() => approve(args), onResolved); });
  function openWriting() {
    setWriting(true);
    setArmed(null);
    requestAnimationFrame(() => textRef.current?.focus());
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    void (review ? run(() => sendBack({ ...args, comment: draft }), onResolved) : answer(draft));
  }

  useEffect(() => {
    if (!keyRoot || !open) return;
    const onKey = (event: KeyboardEvent) => {
      const key = inboxKey(event, keyRoot.current);
      if (key === null || !cardRef.current?.offsetParent || busy) return;
      if (event.repeat && key === 'Enter') return event.preventDefault();
      const index = Number(key) - 1;
      const onControl = document.activeElement?.matches('button, a, summary');
      if (!review && Number.isInteger(index) && index >= 0 && index < choices.length) {
        setSelected(index);
        setArmed(null);
        optionsRef.current?.querySelectorAll('button')[index]?.focus();
      } else if (key === 'Enter' && !onControl && !review && selected !== null) choose(selected);
      else if (key === 'a' && review) approveNow();
      else if (key === 'r' && review) openWriting();
      else if (key === 'Escape' && (armed || selected !== null)) { setArmed(null); setSelected(null); }
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const legacy = !row.headline;
  const recommended = row.recommendation;
  const recommendedChoice = choices.some(choice => choice.label === recommended);
  const evidence = row.evidence ?? row.links?.filter(link => link !== row.prUrl).map(url => ({ url, title: undefined }));
  const keys = !!keyRoot;
  const blocked = row.openTasks;
  return <article ref={cardRef} className={`work-card${open ? ' is-open' : ''}`} tabIndex={-1} data-pane-focus data-item={row.id} aria-labelledby={`${id}-headline`}>
    <p className="work-card-meta">
      {row.taskId ? <>{row.label} / <Link to={`/?task=${encodeURIComponent(row.taskId)}`}>{row.title}</Link> · </> : null}
      {kindName(row)}{open && blocked ? <> · <strong>この{review ? '確認' : '判断'}で{blocked}件が止まっています</strong></> : null}
      {open && row.stalled ? ' · Botの手が止まっています' : null}
      {legacy && row.irreversible ? <span className="task-work-badge">不可逆</span> : null}
    </p>
    {legacy ? <p className="task-work-text work-card-legacy" id={`${id}-headline`}>{row.text}</p> : <>
      <h3 className="work-card-headline" id={`${id}-headline`}>{row.headline}</h3>
      <p className="work-card-context">{row.text}</p>
    </>}
    {row.assumptions ? <section className="work-card-section">
      <h4>Botが補った前提・判断</h4><p className="work-card-prose">{row.assumptions}</p>
    </section> : null}
    {open && choices.length ? <ol className="work-card-options" ref={optionsRef} aria-label="選択肢">{choices.map((choice, index) => {
      const isArmed = armed?.target === choice.label;
      return <li key={choice.label}>
        <button type="button" disabled={busy} onKeyDown={noRepeat} onClick={() => choose(index)}
          className={`work-card-option${choice.label === recommended ? ' is-recommended' : ''}${selected === index ? ' is-selected' : ''}${isArmed ? ' is-armed' : ''}`}>
          <span className="work-card-option-head">
            {keys ? <kbd aria-hidden>{index + 1}</kbd> : null}
            <span className="work-card-option-label">{choice.label}</span>
            {choice.label === recommended ? <span className="task-work-badge">推奨</span> : null}
            {choice.irreversible ? <span className="task-work-badge is-irreversible">不可逆</span> : null}
          </span>
          {choice.consequence ? <span className="work-card-consequence">{choice.consequence}</span> : null}
          {isArmed ? <span className="work-card-armed">取り消せません。もう一度押して確定</span> : null}
        </button>
      </li>;
    })}</ol> : null}
    {row.recommendationReason ? <section className="work-card-section">
      <h4>推奨の理由{row.confidence ? <span className="work-card-confidence">確度 {confidenceNames[row.confidence]}</span> : null}</h4>
      <p className="work-card-prose">{row.recommendationReason}</p>
    </section> : recommended && !recommendedChoice ? <p className="task-work-text task-work-note"><strong>推奨</strong>{'\n'}{recommended}</p> : null}
    {row.checks?.length ? <section className="work-card-section">
      <h4>あなたが確かめる点</h4>
      <ul className="work-card-checks">{row.checks.map(check => <li key={check}>{check}</li>)}</ul>
    </section> : null}
    {row.prUrl ? <PullRequest url={row.prUrl} sha={row.prHeadSha} /> : null}
    {evidence?.length ? <details className="work-card-evidence">
      <summary>根拠 {evidence.length}件</summary>
      <ul className="task-work-links">{evidence.map(link => <li key={link.url}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title ?? link.url}</a>
      </li>)}</ul>
    </details> : null}
    {row.answer ? <p className="task-work-text task-work-answer"><strong>{review ? '差し戻しの理由' : 'あなたの回答'}</strong>{'\n'}{row.answer}</p> : null}
    {open && review ? <div className="work-card-actions">
      <button type="button" className="ghost-btn is-primary" disabled={busy} onKeyDown={noRepeat} aria-describedby={row.prHeadSha ? `${id}-merge` : undefined}
        onClick={approveNow}>{keys ? <kbd aria-hidden>A</kbd> : null}{armed?.target === 'approve' ? '取り消せません。もう一度押して確定'
          : row.prHeadSha ? '承認してマージを任せる' : '承認して完了'}</button>
      {!writing ? <button type="button" className="ghost-btn" disabled={busy} onClick={openWriting}>{keys ? <kbd aria-hidden>R</kbd> : null}差し戻す</button> : null}
      {row.prHeadSha ? <p className="task-work-hint" id={`${id}-merge`}>承認すると、Botがこのコミットをマージします。マージすると本番に公開されます。</p> : null}
    </div> : null}
    {open && !review && !freeText && !writing ? <div className="work-card-actions">
      <button type="button" className="ghost-btn" disabled={busy} onClick={openWriting}>別の答えを書く</button>
    </div> : null}
    {showForm ? <form className="task-work-reply" onSubmit={submit}>
      <label htmlFor={`${id}-text`}>{review ? '差し戻しの理由' : '回答'}</label>
      <textarea id={`${id}-text`} ref={textRef} rows={3} className="inspector-note" value={draft} maxLength={8000}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !freeText) { setWriting(false); cardRef.current?.focus(); } }} required />
      <div className="work-card-actions">
        <button type="submit" className="ghost-btn is-primary" disabled={busy || !draft.trim()}>{review ? '差し戻す' : '返信する'}</button>
        {!freeText ? <button type="button" className="ghost-btn" disabled={busy} onClick={() => { setWriting(false); setDraft(''); }}>やめる</button> : null}
      </div>
    </form> : null}
    {canReply && awaitsBot && (row.wakeStatus === 'failed' || retryReady) ?
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void run(() => retry(args)); }}>担当Botに再通知</button> : null}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
    <p className="work-card-footer" role="status">{statusText(row, canReply)} · Grok Bot · {formatTime(row.createdAt)}</p>
  </article>;
}
