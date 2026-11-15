import { SignInButton, useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';

export function TaskActionPage() {
  const { requestId } = useParams();
  if (!isCloudConfigured) return <section className="task-action-page"><h1>削除を確認</h1><p>この環境ではアカウント接続が設定されていません。</p></section>;
  return <AuthenticatedAction requestId={requestId ?? ''} />;
}

function AuthenticatedAction({ requestId }: { requestId: string }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (!isLoaded) return <section className="task-action-page" role="status">読み込み中…</section>;
  if (!isSignedIn || !userId) return <section className="task-action-page">
    <h1>削除を確認</h1><p>削除を依頼したアカウントでサインインしてください。</p>
    <SignInButton mode="modal" forceRedirectUrl={window.location.href}><button type="button" className="ghost-btn">サインイン</button></SignInButton>
  </section>;
  if (isLoading) return <section className="task-action-page" role="status">サインインを確認中…</section>;
  if (!isAuthenticated) return <section className="task-action-page"><h1>サインインを確認できませんでした</h1>
    <p>ページを再読み込みして、もう一度お試しください。</p><button type="button" className="ghost-btn" onClick={() => window.location.reload()}>再読み込み</button></section>;
  return <ActionConfirmation key={`${userId}:${requestId}`} userId={userId} requestId={requestId} />;
}

function ActionConfirmation({ userId, requestId }: { userId: string; requestId: string }) {
  const remote = useQuery(api.taskActions.get, { requestId, expectedAccountId: userId });
  const respond = useMutation(api.taskActions.respond);
  const [result, setResult] = useState<typeof remote>();
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const state = result ?? remote;
  const expiresAt = state?.expires_at;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  async function decide(decision: 'approve' | 'cancel') {
    if (!state || state.user_id !== userId || state.request_id !== requestId || state.status !== 'pending' || expired || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      setResult(await respond({ requestId, expectedAccountId: userId, expectedRevision: state.revision, decision }));
    } catch (cause) {
      const data = (cause as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '処理できませんでした。通信を確認して再度お試しください。');
    } finally { busyRef.current = false; setBusy(false); }
  }

  if (state === undefined) return <section className="task-action-page" role="status">読み込み中…</section>;
  if (!state) return <section className="task-action-page"><h1>確認待ちの操作が見つかりません</h1>
    <p>削除を依頼したアカウントか確認してください。古い確認リンクは利用できません。</p><Link to="/">タスク一覧へ</Link></section>;
  if (state.user_id !== userId || state.request_id !== requestId) return <section className="task-action-page" role="status">読み込み中…</section>;
  const status = state.status === 'pending' && expired ? 'expired' : state.status;
  const message = status === 'completed' ? `「${state.text}」と配下のタスク、合計${state.deleted ?? state.count}件を削除しました。`
    : status === 'cancelled' ? '削除をキャンセルしました。この依頼では削除しません。'
    : status === 'changed' ? '対象のタスクが変更されています。削除は実行していません。エージェントに改めて削除を依頼してください。'
    : status === 'expired' ? '確認の有効期限が切れました。削除は実行していません。エージェントに改めて削除を依頼してください。' : '';
  return <section className="task-action-page" aria-busy={busy}>
    <h1>{status === 'pending' ? 'タスクの削除を確認' : status === 'completed' ? '削除しました' : '削除の確認'}</h1>
    {message ? <><p role="status">{message}</p><p>エージェントとの会話に戻って結果を確認できます。</p><Link to="/">タスク一覧へ</Link></> : <>
      <p className="task-action-title">{state.text || '（無題）'}</p>
      <p>{state.count > 1 ? `このタスクと配下の${state.count - 1}件を削除します。` : 'このタスクを削除します。'}添付資料も削除対象に含まれます。</p>
      {state.subtasks && state.subtasks.length > 0 ? <ul className="task-action-subtasks">{state.subtasks.map(item => <li key={item.id}>{item.text || '（無題）'}</li>)}
        {state.count - 1 > state.subtasks.length ? <li>ほか{state.count - 1 - state.subtasks.length}件</li> : null}</ul> : null}
      {state.client_name ? <p>依頼元：{state.client_name}</p> : null}
      <p>このページを開いただけでは削除しません。内容を確認して操作を選んでください。</p>
      <div className="account-delete-actions">
        <button type="button" disabled={busy} onClick={() => { void decide('cancel'); }}>キャンセル</button>
        <button type="button" className="account-delete-button" disabled={busy} onClick={() => { void decide('approve'); }}>{busy ? '処理中…' : 'タスクを削除'}</button>
      </div>
    </>}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </section>;
}
