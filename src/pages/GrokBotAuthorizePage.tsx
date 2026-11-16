import { SignInButton, useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { grokBotHex, grokBotOAuthRequest, grokBotRandomCode } from '../lib/grokBotOAuth';

type Connection = NonNullable<ReturnType<typeof grokBotOAuthRequest>>;

export function GrokBotAuthorizePage() {
  const connection = grokBotOAuthRequest(useLocation().search);
  return <section className="task-action-page">
    <h1>Grok Botの接続を許可</h1>
    {isCloudConfigured && connection ? <Authorize connection={connection} /> :
      <p>接続を開けませんでした。Grok Botからやり直してください。</p>}
  </section>;
}

function Authorize({ connection }: { connection: Connection }) {
  const { userId, isLoaded } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const label = useQuery(api.grokBot.oauthLabel, userId && isAuthenticated
    ? { assignment: connection.assignment, expectedUserId: userId } : 'skip');
  const approve = useMutation(api.grokBot.approveOAuth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function allow() {
    if (!label || !userId || busy) return;
    setBusy(true);
    setError('');
    try {
      const code = grokBotRandomCode();
      const codeHash = grokBotHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))));
      await approve({ expectedUserId: userId, assignmentId: label.id, codeHash, challenge: connection.challenge, redirectUri: connection.redirectUri });
      const callback = new URL(connection.redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', connection.state);
      window.location.assign(callback.href);
    } catch {
      setError('許可を保存できませんでした。もう一度お試しください。');
      setBusy(false);
    }
  }

  if (!isLoaded || (userId && isLoading)) return <p role="status">読み込み中…</p>;
  if (!userId) return <>
    <p>担当ラベルのあるアカウントでTerminalにサインインしてください。</p>
    <SignInButton mode="modal" forceRedirectUrl={location.href}><button type="button" className="primary-btn">サインイン</button></SignInButton>
  </>;
  if (!isAuthenticated || label === null) return <p>この接続を開けません。Terminalのアカウントを確認してください。</p>;
  if (label === undefined) return <p role="status">担当ラベルを確認中…</p>;
  return <>
    <p>{'vp' in label && label.vp
      ? 'Grok BotをVPとして、全ラベルと未仕分けのタスクの閲覧と、提案の送信を許可します。タスクを直接変更することはできません。'
      : `Grok Botに「${label.name}」のタスクの確認・起票と、判断依頼・結果の記録を許可します。`}</p>
    <button type="button" className="primary-btn" disabled={busy} onClick={() => void allow()}>{busy ? '接続中…' : '接続を許可'}</button>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </>;
}
