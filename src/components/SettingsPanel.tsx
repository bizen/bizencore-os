import { useEffect, useState } from 'react';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { useMutation, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { isTimeZone } from '../lib/taskDates';
import type { Theme } from '../lib/theme';
import { PartnerSettings } from './PartnerSettings';
import { lifeWorldStore, useLifeWorldState } from '../lib/lifeWorldStore';

const KNOWN_MCP_CLIENTS: Record<string, string> = {
  'https://chatgpt.com/oauth/codex/client.json': 'Codex',
};

function McpConnectionHistory() {
  const connections = useQuery(api.sync.listMcpConnections);

  if (connections === undefined) return <p className="settings-muted">読み込み中...</p>;
  if (connections === null) return <p className="settings-muted">表示するにはサインインしてください。</p>;
  if (connections.length === 0) {
    return <p className="settings-muted">記録されたMCPの利用はまだありません。</p>;
  }

  return (
    <ul className="settings-connections">
      {connections.map(({ clientId, clientName, lastUsedAt }) => (
        <li key={clientId} className="settings-connection">
          <div className="settings-connection-main">
            <strong>{clientName || KNOWN_MCP_CLIENTS[clientId] || clientId}</strong>
            <time dateTime={new Date(lastUsedAt).toISOString()}>
              最終利用 {new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(lastUsedAt)}
            </time>
          </div>
          {clientName || KNOWN_MCP_CLIENTS[clientId] ? <code>{clientId}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function TimeZoneSetting() {
  const preference = useQuery(api.sync.getTimeZone);
  const setTimeZone = useMutation(api.sync.setTimeZone);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const value = draft ?? preference?.timeZone ?? deviceTimeZone;
  const save = async (timeZone: string, automatic: boolean) => {
    if (!isTimeZone(timeZone)) { setError('有効な IANA タイムゾーンを入力してください。'); return; }
    setSaving(true);
    setError('');
    try {
      await setTimeZone({ timeZone, automatic });
      setDraft(null);
    } catch { setError('保存できませんでした。再試行してください。'); }
    finally { setSaving(false); }
  };

  return (
    <div className="settings-timezone">
      <div className="settings-timezone-controls">
        <input
          aria-label="タイムゾーン"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          placeholder="Australia/Melbourne"
        />
        <button type="button" disabled={saving || !isTimeZone(value)} onClick={() => void save(value, false)}>保存</button>
      </div>
      <div className="settings-timezone-foot">
        <span className="settings-muted">{preference?.automatic ? 'この端末と同期中' : '手動設定'}</span>
        <button type="button" disabled={saving} onClick={() => void save(deviceTimeZone, true)}>この端末に合わせる</button>
      </div>
      {error ? <p role="alert" className="settings-error">{error}</p> : null}
    </div>
  );
}

const THEMES: { id: Theme; lines: string[] }[] = [
  { id: 'black', lines: ['ミッドナイト', 'ブラック'] },
  { id: 'original', lines: ['ディープ', 'ネイビー'] },
  { id: 'white', lines: ['フロスト', 'ホワイト'] },
];

export function SettingsPanel({ onClose, theme, onThemeChange }: { onClose: () => void; theme: Theme; onThemeChange: (theme: Theme) => void }) {
  const { data } = useLifeWorldState();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div id="app-settings-panel" className="help-backdrop" role="dialog" aria-modal="true" aria-label="設定" onClick={onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-head">
          <h2>設定</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="閉じる" title="閉じる" autoFocus>
            <X size={18} aria-hidden />
          </button>
        </div>
        <section className="settings-section" aria-labelledby="settings-theme-title">
          <h3 id="settings-theme-title">外観</h3>
          <div className="theme-switch" role="radiogroup" aria-label="外観">
            {THEMES.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-label={option.lines.join('')}
                aria-checked={theme === option.id}
                tabIndex={theme === option.id ? 0 : -1}
                className={`theme-option${theme === option.id ? ' is-selected' : ''}`}
                onClick={() => onThemeChange(option.id)}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = (index + step + THEMES.length) % THEMES.length;
                  onThemeChange(THEMES[next].id);
                  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                  buttons?.[next]?.focus();
                }}
              >
                <span className={`theme-swatch theme-swatch--${option.id}`} aria-hidden="true" />
                <span className="theme-option-name">{option.lines.map((line) => <span key={line}>{line}</span>)}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="settings-life-title">
          <h3 id="settings-life-title">生活世界</h3>
          <label className="settings-life-visibility">
            <span>Allに表示する</span>
            <input type="checkbox" checked={data.preferences?.showInAll ?? false}
              onChange={event => lifeWorldStore.setShowInAll(event.target.checked)} />
          </label>
        </section>
        <section className="settings-section" aria-labelledby="settings-partner-title">
          <h3 id="settings-partner-title">パートナー</h3>
          <PartnerSettings />
        </section>
        <section className="settings-section" aria-labelledby="settings-timezone-title">
          <h3 id="settings-timezone-title">タイムゾーン</h3>
          <p className="settings-muted">today の日付と時刻付き期限に使用します。</p>
          {isCloudConfigured ? (
            <>
              <SignedIn><TimeZoneSetting /></SignedIn>
              <SignedOut><p className="settings-muted">保存するにはサインインしてください。</p></SignedOut>
            </>
          ) : <p className="settings-muted">クラウド接続が設定されていません。</p>}
        </section>
        <section className="settings-section" aria-labelledby="settings-mcp-title">
          <h3 id="settings-mcp-title">MCP接続履歴</h3>
          <p className="settings-muted">このアカウントでMCPツールを利用した接続元と、その最終利用日時です。現在の認可・トークンの有効性は確認できません。記録開始前の利用は表示されません。</p>
          {isCloudConfigured ? (
            <>
              <SignedIn><McpConnectionHistory /></SignedIn>
              <SignedOut><p className="settings-muted">表示するにはサインインしてください。</p></SignedOut>
            </>
          ) : (
            <p className="settings-muted">クラウド接続が設定されていません。</p>
          )}
        </section>
      </div>
    </div>
  );
}
