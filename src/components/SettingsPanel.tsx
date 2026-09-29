import { useEffect } from 'react';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';

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
            <strong>{clientName || clientId}</strong>
            <time dateTime={new Date(lastUsedAt).toISOString()}>
              {new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(lastUsedAt)}
            </time>
          </div>
          {clientName ? <code>{clientId}</code> : null}
        </li>
      ))}
    </ul>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
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
