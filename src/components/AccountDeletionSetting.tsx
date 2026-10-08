import { useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAction, useQuery } from 'convex/react';
import { Trash2 } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { rememberAccountDeletion } from '../lib/accountDeletion';

export function AccountDeletionSetting() {
  const { userId } = useAuth();
  // Changing accounts discards the previous account's confirmation.
  return userId ? <Confirmation key={userId} userId={userId} /> : null;
}

function Confirmation({ userId }: { userId: string }) {
  const status = useQuery(api.accountDeletion.status);
  const request = useAction(api.accountDeletion.request);
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composingRef = useRef(false);
  const [error, setError] = useState('');
  const available = status?.userId === userId && status.available && status.phase === 'active';

  async function remove() {
    if (!available || confirmation !== '削除' || busyRef.current || composingRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await request({ expectedAccountId: userId, confirmation });
      rememberAccountDeletion(userId);
    } catch (cause) {
      const data = (cause as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '削除を開始できませんでした。通信を確認して再度お試しください。');
    } finally { busyRef.current = false; setBusy(false); }
  }

  return (
    <div className="settings-account-delete">
      <p className="settings-muted">このアカウントのタスク・生活世界・コンテキスト資料と添付ファイル・保存テキスト・設定・MCP接続履歴をサーバーから削除し、パートナーとの共有も解除します。</p>
      <p className="settings-muted">Googleアカウントや、パートナー自身のデータは削除しません。このブラウザ内の共通のタスク・保存テキストは残ります。削除は取り消せません。</p>
      {status === undefined ? <p className="settings-muted">読み込み中...</p> : !available ? <p className="settings-muted">現在、アカウント削除を利用できません。</p> : null}
      {!expanded ? (
        <button type="button" className="account-delete-button" disabled={!available} onClick={() => setExpanded(true)}>
          <Trash2 size={15} aria-hidden />アカウントを削除
        </button>
      ) : (
        <form className="account-delete-confirmation" onSubmit={event => { event.preventDefault(); void remove(); }} aria-busy={busy}>
          <label htmlFor="account-delete-confirmation">確認のため「削除」と入力してください。</label>
          <input id="account-delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
            disabled={busy} autoFocus autoComplete="off" spellCheck={false} />
          <div className="account-delete-actions">
            <button type="button" disabled={busy} onClick={() => { setExpanded(false); setConfirmation(''); setError(''); }}>キャンセル</button>
            <button type="submit" className="account-delete-button" disabled={busy || !available || confirmation !== '削除'}>
              <Trash2 size={15} aria-hidden />{busy ? '削除を受け付けています…' : '完全に削除する'}
            </button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className="settings-error">{error}</p> : null}
    </div>
  );
}
