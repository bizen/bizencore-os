import { useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { isCloudConfigured } from '../../lib/cloudConfig';

type Work = NonNullable<FunctionReturnType<typeof api.grokBot.taskHistory>>['rows'][number];
type Schedule = NonNullable<FunctionReturnType<typeof api.grokBot.schedule>>;

function useAccount() {
  const { userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  return isAuthenticated ? userId ?? null : null;
}

function AuthenticatedInboxLink({ onClick }: { onClick?: () => void }) {
  const userId = useAccount();
  const inbox = useQuery(api.grokBot.inbox, userId ? { expectedUserId: userId } : 'skip');
  return inbox ? (
    <NavLink to="/inbox" onClick={onClick} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      受信箱{inbox.waiting.length ? ` (${inbox.waiting.length})` : ''}
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
  const schedule = useQuery(api.grokBot.schedule, userId ? { expectedUserId: userId } : 'skip');
  const rows = inbox ? [...inbox.waiting, ...inbox.answered] : [];
  return <section className="task-action-page task-work-inbox">
    <h1>受信箱</h1>
    {!userId ? <p>受信箱を見るにはサインインしてください。</p> :
      inbox === undefined ? <p role="status">読み込み中…</p> :
      inbox === null ? <p>Grok Botの担当ラベルが設定されていません。</p> :
      <>
        <p role="status">{inbox.waiting.length}件の判断依頼</p>
        {rows.length ? <ul className="task-work-list">
          {rows.map(row => <li className="task-work-card" key={row.id}>
            <p className="task-work-status">{row.label}</p>
            <h2><Link to={`/?task=${encodeURIComponent(row.taskId)}`}>{row.title}</Link></h2>
            <Decision key={userId} row={row} userId={userId} canReply />
          </li>)}
        </ul> : null}
        {schedule ? <PatrolSettings key={`${userId}:${schedule.time}:${schedule.enabled}`} schedule={schedule} userId={userId} /> : null}
      </>}
  </section>;
}

export function LabelPatrolSettings({ labelId, userId }: { labelId: string; userId: string }) {
  const schedule = useQuery(api.grokBot.schedule, { expectedUserId: userId, labelId });
  return schedule ? <PatrolSettings key={`${schedule.time}:${schedule.enabled}`} schedule={schedule} userId={userId} labelId={labelId} /> : null;
}

function PatrolSettings({ schedule, userId, labelId }: { schedule: Schedule; userId: string; labelId?: string }) {
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
      await save({ expectedUserId: userId, enabled, time, ...(labelId ? { labelId } : {}) });
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '巡回時刻を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  const lastStatus = schedule.lastStatus === 'accepted' ? 'Grok Botが受付' : schedule.lastStatus === 'failed' ? '呼び出しに失敗' : '呼び出し中';
  return <section className="task-work-patrol">
    <h2>Grok Botの巡回</h2>
    <form onSubmit={event => { void submit(event); }}>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> 毎日巡回する</label>
      <label> 巡回時刻 <input type="time" className="inspector-input" value={time} onChange={event => setTime(event.target.value)} required /></label>
      <button type="submit" className="ghost-btn" disabled={busy || !changed}>保存</button>
    </form>
    <p>{schedule.timeZone ?? '設定でタイムゾーンを保存してください。'}</p>
    {schedule.lastRunAt ? <p role="status">前回 {formatTime(schedule.lastRunAt, schedule.timeZone ?? undefined)} · {lastStatus}</p> : null}
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
  const { rows, canReply, mayExecute } = data;
  const decisions = rows.filter(row => row.status === 'waiting' || row.status === 'answered' || row.status === 'applied');
  const results = rows.filter(row => row.status === 'progress' || row.status === 'complete');
  return <>
    {canReply ? <TaskDelegation key={userId} taskId={taskId} userId={userId} mayExecute={mayExecute} /> : null}
    {decisions.length ? <section className="inspector-section">
      <h3 className="inspector-label">業務連絡</h3>
      <ul className="task-work-list">{decisions.map(row => <li className="task-work-card" key={row.id}>
        <Decision key={userId} row={row} userId={userId} canReply={canReply && row.canReply} />
      </li>)}</ul>
    </section> : null}
    {results.length ? <section className="inspector-section">
      <h3 className="inspector-label">作業結果</h3>
      <ul className="task-work-list">{results.map(row => <li className="task-work-card" key={row.id}>
        <span className="task-work-status">{row.status === 'complete' ? '完了報告' : '途中経過'} · {formatTime(row.createdAt)}</span>
        <p className="task-work-text">{row.text}</p>
        {row.links?.length ? <ul className="task-work-links">{row.links.map(link =>
          <li key={link}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>
        )}</ul> : null}
      </li>)}</ul>
    </section> : null}
  </>;
}

function TaskDelegation({ taskId, userId, mayExecute }: { taskId: string; userId: string; mayExecute: boolean }) {
  const setDelegation = useMutation(api.grokBot.setDelegation);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(execute: boolean) {
    setBusy(true);
    setError('');
    try {
      await setDelegation({ expectedUserId: userId, taskId, execute });
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : 'Grok Botの関わり方を変更できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="inspector-prop">
    <label className="inspector-label" htmlFor={inputId}>Grok Botの関わり方</label>
    <select id={inputId} className="inspector-input" value={mayExecute ? 'execute' : 'review'} disabled={busy}
      onChange={event => { void change(event.target.value === 'execute'); }}>
      <option value="review">確認・監査</option>
      <option value="execute">実行も任せる</option>
    </select>
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </div>;
}

const formatTime = (time: number, timeZone?: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(time);

function Decision({ row, userId, canReply }: { row: Omit<Work, 'canReply'>; userId: string; canReply: boolean }) {
  const inputId = useId();
  const reply = useMutation(api.grokBot.reply);
  const retry = useMutation(api.grokBot.retry);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryReady, setRetryReady] = useState(false);
  useEffect(() => {
    if (row.status !== 'answered' || !row.wakeAt) return;
    const timer = setTimeout(() => setRetryReady(true), Math.max(0, row.wakeAt + 60_000 - Date.now()));
    return () => { clearTimeout(timer); setRetryReady(false); };
  }, [row.status, row.wakeAt]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (busy || (event && !draft.trim())) return;
    setBusy(true);
    setError('');
    try {
      const args = { id: row.id, expectedUserId: userId };
      if (event) {
        await reply({ ...args, answer: draft });
        setDraft('');
      } else await retry(args);
    } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '送信できませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  const status = row.status === 'applied' ? '反映済み' : !canReply ? '受付終了' : row.status === 'waiting' ? '要回答' :
    row.wakeStatus === 'failed' ? '回答済み・再開通知に失敗' :
      row.wakeStatus === 'accepted' ? '回答済み・反映待ち' : '回答済み・通知中';
  return <>
    <span className="task-work-status" role="status">{status} · Grok Bot · {formatTime(row.createdAt)}</span>
    <p className="task-work-text">{row.text}</p>
    {row.answer ? <p className="task-work-text task-work-answer"><strong>あなたの回答</strong>{'\n'}{row.answer}</p> : null}
    {canReply && row.status === 'waiting' ? <form className="task-work-reply" onSubmit={event => { void send(event); }}>
      <label htmlFor={inputId}>回答</label>
      <textarea id={inputId} rows={2} className="inspector-note" value={draft} maxLength={8000}
        onChange={event => setDraft(event.target.value)} required />
      <button type="submit" className="ghost-btn" disabled={busy || !draft.trim()}>返信する</button>
    </form> : null}
    {canReply && row.status === 'answered' && (row.wakeStatus === 'failed' || retryReady) ?
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void send(); }}>担当Botに再通知</button> : null}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </>;
}
