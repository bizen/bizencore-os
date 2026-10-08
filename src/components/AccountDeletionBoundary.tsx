import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { ACCOUNT_DELETION_EVENT, clearDeletedAccountCache, deletionKey, deletionRemembered, rememberAccountDeletion } from '../lib/accountDeletion';

export function AccountDeletionBoundary({ children }: { children: ReactNode }) {
  return isCloudConfigured ? <CloudBoundary>{children}</CloudBoundary> : children;
}

function CloudBoundary({ children }: { children: ReactNode }) {
  const { isLoaded, userId, sessionId } = useAuth();
  const { signOut } = useClerk();
  const status = useQuery(api.accountDeletion.status, userId ? {} : 'skip');
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const deleting = Boolean(userId && (localUserId === userId || deletionRemembered(userId) ||
    (status?.userId === userId && status.phase !== 'active')));

  useLayoutEffect(() => {
    const onAccepted = (event: Event) => setLocalUserId((event as CustomEvent<string>).detail);
    const onStorage = (event: StorageEvent) => {
      if (userId && event.key === deletionKey(userId) && event.newValue === 'accepted') setLocalUserId(userId);
    };
    window.addEventListener(ACCOUNT_DELETION_EVENT, onAccepted);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(ACCOUNT_DELETION_EVENT, onAccepted); window.removeEventListener('storage', onStorage); };
  }, [userId]);

  useLayoutEffect(() => {
    if (!deleting || !userId) return;
    const cleared = clearDeletedAccountCache(userId);
    let active = true;
    queueMicrotask(() => { if (active) setCacheError(!cleared); });
    if (!deletionRemembered(userId)) rememberAccountDeletion(userId);
    return () => { active = false; };
  }, [deleting, userId]);

  if (isLoaded === false || (userId && status === undefined && !deleting)) return <div className="account-deletion-status" role="status">読み込み中...</div>;
  if (!deleting) return children;
  const complete = status?.userId === userId && status.phase === 'complete';
  return (
    <main className="account-deletion-status" aria-live="polite">
      <h1>{complete ? 'アカウントを削除しました' : 'アカウント削除を受け付けました'}</h1>
      <p>{complete ? 'サーバーの保存データと認証アカウントの削除が完了しました。' : 'サーバーで削除を進めています。この画面を閉じても処理は続きます。'}</p>
      <p>このブラウザの共通のタスク・保存テキストは残っています。</p>
      {status?.retrying ? <p>通信エラーのため自動で再試行しています。</p> : null}
      {cacheError ? <p role="alert">このアカウント専用の端末データを一部消去できませんでした。</p> : null}
      <button type="button" onClick={() => { void signOut({ sessionId: sessionId ?? undefined, redirectUrl: '/' }).catch(() => setSignOutError(true)); }}>サインアウト</button>
      {signOutError ? <p role="alert">サインアウトできませんでした。再度お試しください。</p> : null}
    </main>
  );
}
