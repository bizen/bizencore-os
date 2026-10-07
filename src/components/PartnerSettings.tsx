import { SignInButton, useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { Copy, Link2, Unplug, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { initialPartnerInvite, partnerInviteCode } from '../lib/partnerModel';
import { LABEL_COLORS } from '../lib/taskModel';

export function PartnerSettings() {
  return isCloudConfigured ? <PartnerAccountSettings /> : <p className="settings-muted">クラウド接続が設定されていません。</p>;
}

function PartnerAccountSettings() {
  const { isSignedIn, userId } = useAuth();
  return isSignedIn && userId ? <AccountSettings key={userId} accountId={userId} />
    : <SignInButton mode="modal"><button type="button" className="ghost-btn"><UserPlus size={14} aria-hidden />サインイン</button></SignInButton>;
}

function AccountSettings({ accountId }: { accountId: string }) {
  const state = useQuery(api.partners.state, { accountId });
  const createInvite = useMutation(api.partners.createInvite);
  const cancelInvite = useMutation(api.partners.cancelInvite);
  const acceptInvite = useMutation(api.partners.acceptInvite);
  const shareLabel = useMutation(api.partners.setLabelSharing);
  const disconnect = useMutation(api.partners.disconnect);
  const [draft, setDraft] = useState(initialPartnerInvite);
  const [code, setCode] = useState(() => partnerInviteCode(initialPartnerInvite()));
  const preview = useQuery(api.partners.previewInvite, code ? { accountId, code } : 'skip');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const run = async (operation: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await operation(); setMessage(success); }
    catch (cause) { setError(cause instanceof ConvexError && typeof cause.data === 'string' ? cause.data : '操作できませんでした。接続を確認して再試行してください。'); }
    finally { setBusy(false); }
  };
  if (state === undefined) return <p className="settings-muted" role="status">読み込み中...</p>;
  if (!state || state.accountId !== accountId) return <p className="settings-muted">サインインを確認してください。</p>;
  const invite = state.invite;
  const link = invite ? `${window.location.origin}/#partner-invite=${invite.code}` : '';
  return <div className="partner-settings" data-partner-surface>
    {state.partner ? <>
      <div className="partner-connection"><strong>{state.partner.name}</strong>
        <button type="button" className="icon-btn" title="接続を解除" aria-label="パートナーとの接続を解除" disabled={busy}
          onClick={() => {
            if (window.confirm('パートナーとの接続と、双方のラベル公開設定を解除しますか？')) void run(() => disconnect({ accountId }), '接続を解除しました。');
          }}><Unplug size={16} aria-hidden /></button>
      </div>
      <h4 className="inspector-label">公開するラベル</h4>
      <p className="settings-muted">メモ・完了条件・添付・生活世界は非公開</p>
      <ul className="partner-labels">{state.labels.map(label => <li key={label.id}>
        <label><input type="checkbox" checked={state.sharedLabelIds.includes(label.id)} disabled={busy}
          onChange={event => { void run(() => shareLabel({ accountId, labelId: label.id, shared: event.target.checked }), '公開設定を保存しました。'); }} />
          <span className="label-index-mark" style={{ backgroundColor: label.color ? LABEL_COLORS[label.color] : undefined }} aria-hidden />
          <span>{label.text || '無題のラベル'}</span>
        </label>
      </li>)}</ul>
      {state.labels.length === 0 ? <p className="settings-muted">共有できるラベルがありません。</p> : null}
    </> : <>
      {invite && invite.expiresAt > now ? <div className="partner-invite">
        <div className="partner-invite-link"><input readOnly value={link} aria-label="自分の招待リンク" />
          <button type="button" className="icon-btn" aria-label="招待リンクをコピー" title="招待リンクをコピー" disabled={busy}
            onClick={() => { void run(() => navigator.clipboard.writeText(link), '招待リンクをコピーしました。'); }}><Copy size={15} aria-hidden /></button>
          <button type="button" className="icon-btn" aria-label="招待を取り消す" title="招待を取り消す" disabled={busy}
            onClick={() => { void run(() => cancelInvite({ accountId }), '招待を取り消しました。'); }}><X size={15} aria-hidden /></button>
        </div>
        <span className="settings-muted">有効期限 {new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(invite.expiresAt)}</span>
      </div> : <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void run(() => createInvite({ accountId }), '招待リンクを作成しました。'); }}>
        <UserPlus size={14} aria-hidden />招待リンクを作る
      </button>}
      <div className="partner-join">
        <div className="partner-invite-link"><input value={draft} aria-label="招待リンクまたはコード" placeholder="相手の招待リンク" disabled={busy}
          onChange={event => { setDraft(event.target.value); setCode(null); setError(''); }} />
          <button type="button" className="ghost-btn" disabled={busy || !draft.trim()} onClick={() => {
            const parsed = partnerInviteCode(draft); setCode(parsed); setError(parsed ? '' : '招待リンクを確認してください。');
          }}><Link2 size={14} aria-hidden />確認</button>
        </div>
        {code && preview === undefined ? <p className="settings-muted" role="status">招待を確認中...</p> : null}
        {code && preview === null ? <p className="context-error" role="alert">招待が無効か期限切れです。</p> : null}
        {code && preview ? <div className="partner-accept"><span>{preview.name} からの招待</span>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => { void run(async () => {
            await acceptInvite({ accountId, code }); setCode(null); setDraft('');
            if (initialPartnerInvite()) window.history.replaceState(null, '', window.location.pathname + window.location.search);
          }, '接続しました。公開するラベルを選べます。'); }}>招待を承認</button>
        </div> : null}
      </div>
    </>}
    {error ? <p className="context-error" role="alert">{error}</p> : null}
    {message ? <p className="settings-muted" role="status">{message}</p> : null}
  </div>;
}
