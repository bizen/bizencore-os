import { useAuth } from '@clerk/clerk-react';
import { useAction, useConvexAuth, useMutation, useQuery } from 'convex/react';
import { ArrowUpRight, Check, Copy, X } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../../convex/_generated/api';
import grokBotMark from '../../assets/grok-bot-mark.png';
import { isCloudConfigured } from '../../lib/cloudConfig';
import { grokBotRandomCode } from '../../lib/grokBotOAuth';
import { handleMetaKeyDown } from '../../lib/metaCursor';
import { LabelPatrolSettings } from './TaskWork';

type Assignment = FunctionReturnType<typeof api.grokBot.assignments>[number];
const LabelBots = createContext<{ userId: string | null; assignments: Assignment[] | undefined } | null>(null);

export function LabelGrokBotProvider({ children }: { children: ReactNode }) {
  return isCloudConfigured ? <CloudLabelBots>{children}</CloudLabelBots> : children;
}

function CloudLabelBots({ children }: { children: ReactNode }) {
  const { userId: subject } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const userId = isAuthenticated ? subject ?? null : null;
  const assignments = useQuery(api.grokBot.assignments, userId ? { expectedUserId: userId } : 'skip');
  return <LabelBots.Provider value={{ userId, assignments }}>{children}</LabelBots.Provider>;
}

export function LabelGrokBotMark({ labelId, labelName, onFocus }: { labelId: string; labelName: string; onFocus: () => void }) {
  const bots = useContext(LabelBots);
  const [opened, setOpened] = useState(false);
  const [credential, setCredential] = useState<{ userId: string; token: string }>();
  const userId = bots?.userId;
  const assignment = bots?.assignments?.find(row => row.labelId === labelId);
  const connectorConnected = assignment?.connectorConnected;
  useEffect(() => {
    setCredential(value => value?.userId === userId && !connectorConnected ? value : undefined);
  }, [userId, connectorConnected]);
  if (!bots) return null;
  const name = labelName.trim() || 'ラベル';
  const action = `${name} · ${assignment?.connected ? '担当のGrok Bot' : assignment ? 'Grok Botの接続を続ける' : 'Grok Botを接続'}`;
  return <>
    <button type="button" className={`meta-grok${assignment ? ' is-assigned' : ''}`} data-meta="grok-bot"
      aria-label={action} title={action} aria-haspopup="dialog" onClick={() => setOpened(true)}
      onKeyDown={handleMetaKeyDown} onFocus={onFocus}>
      <BotAvatar assignment={assignment} size={20} />
      {assignment?.connected && <span className="label-bot-connected" aria-hidden />}
    </button>
    {opened && <BotDialog key={bots.userId} labelId={labelId} labelName={name} userId={bots.userId}
      loading={bots.assignments === undefined} assignment={assignment}
      token={credential?.userId === userId ? credential?.token ?? '' : ''}
      onToken={token => setCredential(token && userId ? { userId, token } : undefined)}
      onClose={() => setOpened(false)} />}
  </>;
}

/** The user's VP: one cross-label Bot that only reads and proposes. Managed from settings with the label connection UI. */
export function VpGrokBotSettings() {
  return isCloudConfigured ? <CloudVpSettings /> : <p className="settings-muted">クラウド接続が設定されていません。</p>;
}

function CloudVpSettings() {
  const { userId: subject } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const userId = isAuthenticated ? subject ?? null : null;
  const vp = useQuery(api.grokBot.vp, userId ? { expectedUserId: userId } : 'skip');
  const [credential, setCredential] = useState<{ userId: string; token: string }>();
  const token = credential?.userId === userId && !vp?.connectorConnected ? credential.token : '';
  return <div className="label-bot-vp">
    <p className="settings-muted">VPは全ラベルと未仕分けのタスクを見て、削除・延期・仕分け・新しいタスクを提案するだけの枠です。自分では何も変更できず、受信箱の「提案」で採用したものだけが反映されます。</p>
    {!userId ? <p className="settings-muted">VPを接続するには、Terminalにサインインしてください。</p> :
      vp === undefined ? <p role="status">接続状況を読み込んでいます…</p> : <>
        {vp ? <div className="label-bot-heading">
          <BotAvatar assignment={vp} size={28} />
          <div><h4>VP</h4><p>{vp.connected ? '全ラベルを見て提案します' : '接続を続けてください'}</p></div>
        </div> : null}
        <AssignmentSettings vp labelId="" labelName="VP" userId={userId} assignment={vp ?? undefined} token={token}
          onToken={next => setCredential(next ? { userId, token: next } : undefined)} />
      </>}
  </div>;
}

function BotAvatar({ assignment, size }: { assignment?: Assignment; size: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const skin = assignment?.skin;
  return skin && skin !== failedImage
    ? <img className="label-bot-avatar" src={skin} alt="" width={size} height={size} onError={() => setFailedImage(skin)} />
    : <img className="label-bot-brand-mark" src={grokBotMark} alt="" width={size} height={size} />;
}

function BotDialog({ labelId, labelName, userId, loading, assignment, token, onToken, onClose }: {
  labelId: string; labelName: string; userId: string | null; loading: boolean; assignment?: Assignment;
  token: string; onToken: (token: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="label-bot-dialog" aria-labelledby={titleId} onClose={onClose}
    onKeyDown={event => event.stopPropagation()}>
    <header className="label-bot-heading">
      <BotAvatar assignment={assignment} size={28} />
      <div><h2 id={titleId}>{assignment?.connected ? '担当のGrok Bot' : 'Grok Botを接続'}</h2><p>{labelName}</p></div>
      <button type="button" className="icon-btn" aria-label="閉じる" onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button>
    </header>
    {userId ? loading ? <p role="status">接続状況を読み込んでいます…</p> :
      <AssignmentSettings labelId={labelId} labelName={labelName} userId={userId} assignment={assignment} token={token} onToken={onToken} /> :
      <p>Grok Botを接続するには、Terminalにサインインしてください。</p>}
  </dialog>;
}

const skinFileTypes = 'image/png,image/jpeg,image/webp';
const grokBotTemplateUrl = 'https://x.ai/bot/hPGmSCsPi8Y_tUpPjDjwl';
const routineName = 'Terminalからの依頼';
const terminalOrigin = () => location.protocol === 'https:' ? location.origin : 'https://app.bizencore.com';

function routineInstructions(name: string, vp?: boolean) {
  const work = vp
    ? 'On patrol read all_tasks and propose only a few high-value ideas; never act on tasks.'
    : 'On patrol check answered tasks first. On reply use task_id and question_id. Review by default, execute only if bot_role=execute, and record results in Terminal.';
  return `Create or update and enable a webhook routine named "${name}" using that connector. On connection_check exit without work. ${work} Reply in Japanese with the routine's webhook settings link. Ask me to paste POST to and key into Terminal. Never put the key in chat.`;
}

function guidedSetup(assignmentId: string, labelName: string, connectorName: string, webhookConfigured: boolean, botId: string, vp?: boolean) {
  const endpoint = `${terminalOrigin()}/grok-bot/mcp/${assignmentId}`;
  const label = JSON.stringify(Array.from(labelName).slice(0, 32).join(''));
  const prompt = [
    `${vp ? 'Set up bizencore Terminal as my VP: read every label, propose only.' : `Set up bizencore Terminal for label ${label}.`} Add or reconnect the custom MCP connector ${JSON.stringify(connectorName)} at ${endpoint}. Show the OAuth authorization card. Use ${vp ? 'all_tasks' : 'assigned_tasks'} to verify access after approval.`,
    webhookConfigured
      ? 'Keep the existing routine and confirm in Japanese.'
      : routineInstructions(`${routineName} · ${assignmentId.slice(-8)}`, vp),
  ].join(' ');
  const link = new URL('grokbot://app/v1/prompt');
  if (botId) link.searchParams.set('id', botId);
  link.searchParams.set('text', prompt);
  const webLink = new URL('https://cursor.com/grok-bot/link/v1/prompt');
  webLink.search = link.search;
  return { prompt, link: location.protocol === 'https:' ? link.href : webLink.href, webLink: webLink.href };
}

function CopySetupValue({ value, label, caption = label }: { value: string; label: string; caption?: string }) {
  const [status, setStatus] = useState<'copied' | 'manual'>();
  return <div className="label-bot-copy">
    <button type="button" className="ghost-btn" aria-label={label} onClick={async () => {
      try {
        await navigator.clipboard.writeText(value);
        setStatus('copied');
      } catch {
        setStatus('manual');
      }
    }}>{status === 'copied' ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}{caption}</button>
    <span role="status">{status === 'copied' ? 'コピーしました' : ''}</span>
    {status === 'manual' && <textarea className="inspector-note" rows={3} readOnly value={value} autoFocus
      aria-label={`${label}（手動）`} onFocus={event => event.target.select()} />}
  </div>;
}

async function prepareSkin(file: File) {
  let bitmap: ImageBitmap | undefined;
  try {
    if (!skinFileTypes.split(',').includes(file.type) || file.size > 25 * 1024 * 1024) throw new Error();
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error();
    const crop = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, 64, 64);
    return canvas.toDataURL('image/png');
  } catch {
    throw new ConvexError('25 MB以下のPNG、JPEG、WebP画像を選んでください。');
  } finally {
    bitmap?.close();
  }
}

function AssignmentSettings({ labelId, labelName, userId, assignment, token, onToken, vp }: {
  labelId: string; labelName: string; userId: string; assignment?: Assignment; token: string; onToken: (token: string) => void; vp?: boolean;
}) {
  const add = useMutation(api.grokBot.addAssignment);
  const connect = useAction(api.grokBot.connectAssignmentWebhook);
  const setSkin = useMutation(api.grokBot.setAssignmentSkin);
  const rotate = useMutation(api.grokBot.rotateAssignmentToken);
  const remove = useMutation(api.grokBot.removeAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [botLink, setBotLink] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [openRoutine, setOpenRoutine] = useState(false);
  const botId = /^(?:https:\/\/(?:x\.ai\/bot\/agent\/|cursor\.com\/grok-bot\/link\/v1\/agent\?id=)|grokbot:\/\/app\/v1\/agent\?id=)?([A-Za-z0-9_-]{21})\/?$/.exec(botLink.trim())?.[1] ?? '';
  const connectorConnected = assignment?.connectorConnected;
  useEffect(() => {
    if (connectorConnected) setOpenRoutine(true);
  }, [connectorConnected]);
  const args = vp ? { expectedUserId: userId, vp: true as const } : { expectedUserId: userId, labelId };

  async function perform(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await work(); } catch (error) {
      const data = (error as { data?: unknown })?.data;
      setError(typeof data === 'string' ? data : '保存できませんでした。もう一度お試しください。');
    } finally { setBusy(false); }
  }

  function connectRoutine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void perform(() => connect({ ...args, webhookUrl: String(values.get('url')), webhookKey: String(values.get('key')) }));
  }

  function resetConnection() {
    void perform(async () => {
      const next = grokBotRandomCode();
      await rotate({ ...args, token: next });
      onToken(next);
    });
  }

  const errorMessage = error && <p role="alert" className="settings-error">{error}</p>;
  const botChoice = <label>別のBotの共有リンク<input className="inspector-input" value={botLink} maxLength={160}
    onChange={event => setBotLink(event.target.value)} placeholder="Botの「共有」からコピー" /></label>;
  const invalidBotLink = !!botLink.trim() && !botId;
  const botLinkError = invalidBotLink && <p role="alert">Bot本人の共有リンクかIDを貼り付けてください。</p>;
  const botLinks = <div className="label-bot-links">
    <a href={grokBotTemplateUrl} target="_blank" rel="noopener noreferrer">担当Botを作る</a>
    <a href="https://x.ai/bot" target="_blank" rel="noopener noreferrer">Grok Botを入手</a>
  </div>;
  if (!assignment) return <div className="label-bot-intro">
    <p>{botId ? '選んだBot' : 'メインBot'}に、{vp ? '全体を見て提案するVPを任せます。' : 'このラベルの確認・監査を任せます。'}</p>
    <button type="button" className="primary-btn label-bot-open" disabled={busy || invalidBotLink} onClick={() => {
      if (busy) return;
      const handoff = location.protocol === 'https:' ? window.open('about:blank', '_blank') : null;
      void perform(async () => {
        try {
          const id = await add({ ...args, token: grokBotRandomCode() });
          const setup = guidedSetup(id, labelName, `Terminal ${id.slice(-8)}`, false, botId, vp);
          if (handoff && !handoff.closed) {
            handoff.opener = null;
            handoff.location.href = setup.webLink;
          }
        } catch (cause) {
          handoff?.close();
          throw cause;
        }
      });
    }}>
      {busy ? '準備中…' : 'Grok Botで設定する'} <ArrowUpRight size={15} aria-hidden />
    </button>
    <details className="label-bot-management">
      <summary>別のBotを使う</summary>
      <div className="label-bot-form">{botChoice}{botLinkError}{botLinks}</div>
    </details>
    {errorMessage}
  </div>;

  const setup = assignment.id ? guidedSetup(assignment.id, labelName,
    `Terminal ${assignment.id.slice(-8)}`, assignment.webhookConfigured, botId, vp) : null;

  return <>
    {assignment.connected ? <>
      <p className="label-bot-status" role="status"><Check size={16} aria-hidden />接続済み</p>
      {vp ? <LabelPatrolSettings vp userId={userId} /> : <LabelPatrolSettings labelId={labelId} userId={userId} />}
      {assignment.id && <label className="label-bot-skin">{assignment.skin ? 'スキン画像を変更' : 'スキン画像を追加'}
        <input type="file" accept={skinFileTypes} disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0];
          const assignmentId = assignment.id;
          event.currentTarget.value = '';
          if (file && assignmentId) void perform(async () => {
            await setSkin({ expectedUserId: userId, assignmentId, skin: await prepareSkin(file) });
          });
        }} />
      </label>}
    </> : <>
      {!assignment.connectorConnected && setup && <div className="label-bot-intro">
        <p>{botId ? '選んだBot' : 'メインBot'}で入力済みの依頼を送信し、表示された接続を許可します。</p>
        {!invalidBotLink && <a className="primary-btn label-bot-open" href={setup.link}
          target="_blank" rel="noopener noreferrer">Grok Botで設定する <ArrowUpRight size={15} aria-hidden /></a>}
        <details className="label-bot-management">
          <summary>別のBotを使う・アプリが開かない</summary>
          <div className="label-bot-form">
            {botChoice}
            {botLinkError}
            {!invalidBotLink && <a href={setup.webLink} target="_blank" rel="noopener noreferrer">ブラウザ経由で開く</a>}
            <CopySetupValue value={setup.prompt} label="依頼文をコピー" />
            {botLinks}
          </div>
        </details>
      </div>}
      {assignment.connectorConnected && <p className="label-bot-status" role="status"><Check size={16} aria-hidden />Terminalへのアクセスを確認しました</p>}
      {!assignment.webhookConfigured && <details className="label-bot-management" open={openRoutine}
        onToggle={event => setOpenRoutine(event.currentTarget.open)}>
        <summary>呼び出しを登録する</summary>
        <p>Botの返信からWebhook画面を開き、「POST to」と「key」を貼り付けます。</p>
        <form className="label-bot-form" onSubmit={connectRoutine}>
          <label>POST to（URL）<input name="url" type="url" className="inspector-input" maxLength={512} autoComplete="off" spellCheck={false} disabled={busy} required /></label>
          <label>key（呼び出しキー）<input name="key" type="password" className="inspector-input" autoComplete="off" maxLength={544} disabled={busy} required /></label>
          <button type="submit" className="primary-btn" disabled={busy}>{busy ? '接続を確認中…' : 'テストして接続'}</button>
          {errorMessage}
        </form>
      </details>}
    </>}
    {assignment.webhookConfigured && errorMessage}
    {assignment.managed && <details className="label-bot-management">
      <summary>接続を管理</summary>
      <div className="label-bot-actions">
        {!assignment.connectorConnected && <button type="button" className="ghost-btn" onClick={() => setShowManual(!showManual)}>手動で設定</button>}
        {assignment.connected && <button type="button" className="ghost-btn" disabled={busy} onClick={resetConnection}>接続をやり直す</button>}
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => void perform(async () => {
          await remove(args);
          onToken('');
          setShowManual(false);
        })}>{vp ? 'VPを外す' : '割り当てを解除'}</button>
      </div>
      {showManual && !assignment.connectorConnected && <>
        {token ? <ConnectorSettings token={token} connectorName={assignment.connectorName} /> :
          <button type="button" className="ghost-btn" disabled={busy} onClick={resetConnection}>接続キーを再発行</button>}
        {assignment.connectorName && !assignment.webhookConfigured &&
          <CopySetupValue value={`Use the Terminal connector ${JSON.stringify(assignment.connectorName)}. ${routineInstructions(`${routineName} · ${vp ? 'VP' : labelId.slice(-8)}`, vp)}`} label="手動設定の依頼文をコピー" />}
      </>}
    </details>}
  </>;
}

function ConnectorSettings({ token, connectorName }: { token: string; connectorName?: string }) {
  const endpoint = new URL('/api/grok-bot', terminalOrigin()).href;
  return <>
    {connectorName
      ? <p>Connect apps → Add a custom connector → Remote HTTPS で、以下を貼り付けます。</p>
      : <p>Connect apps でこのラベルの接続を開き、Authorization を更新します。削除済みなら、以前と同じ名前で Remote HTTPS の接続を追加します。</p>}
    <div className="label-bot-copy-fields">
      {connectorName && <CopySetupValue value={connectorName} label="Name をコピー" caption="Name" />}
      <CopySetupValue value={endpoint} label="Server URL をコピー" caption="Server URL" />
      <CopySetupValue key={token} value={`Bearer ${token}`} label="Authorization をコピー" caption="Authorization" />
    </div>
    <p>Authorization は HTTP headers に追加します。{connectorName
      ? '同名の接続があれば、キーを更新します。'
      : '保存後、担当Botにこの接続でラベルを確認するよう頼んでください。'}</p>
  </>;
}
