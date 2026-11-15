import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { useMutation, useQuery } from 'convex/react';
import { Bell, Cable, Palette, Search, Settings2, Shield, Users, X } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { isTimeZone } from '../lib/taskDates';
import type { Theme } from '../lib/theme';
import { saveMascotStyle, useMascotStyle } from '../lib/mascotStyle';
import { mcpClientName } from '../lib/mcpClientName';
import { initialPartnerInvite } from '../lib/partnerModel';
import { SETTINGS_PAGES, findSettingsPages, type SettingsPage } from '../lib/settingsNavigation';
import { PartnerSettings } from './PartnerSettings';
import { lifeWorldStore, useLifeWorldState } from '../lib/lifeWorldStore';
import { NotificationSettings } from './NotificationSettings';
import { AccountDeletionSetting } from './AccountDeletionSetting';

function McpConnectionHistory() {
  const connections = useQuery(api.sync.listMcpConnections);

  if (connections === undefined) return <p className="settings-muted">読み込み中...</p>;
  if (connections === null) return <p className="settings-muted">表示するにはサインインしてください。</p>;
  if (connections.length === 0) {
    return <p className="settings-muted">記録されたMCPの利用はまだありません。</p>;
  }

  return (
    <ul className="settings-connections">
      {connections.map(({ clientId, clientName, lastUsedAt }) => {
        const displayName = mcpClientName(clientId, clientName);
        return (
          <li key={clientId} className="settings-connection">
            <div className="settings-connection-main">
              <strong>{displayName || clientId}</strong>
              <time dateTime={new Date(lastUsedAt).toISOString()}>
                最終利用 {new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(lastUsedAt)}
              </time>
            </div>
            {displayName !== clientId ? <code>{clientId}</code> : null}
          </li>
        );
      })}
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

const PAGE_ICONS = { general: Settings2, appearance: Palette, notifications: Bell, partner: Users, connections: Cable, account: Shield };

export function SettingsPanel({
  onClose,
  theme,
  onThemeChange,
}: {
  onClose: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const { data } = useLifeWorldState();
  const mascotStyle = useMascotStyle();
  const [page, setPage] = useState<SettingsPage>(() =>
    initialPartnerInvite() ? 'partner' : 'general',
  );
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const matches = findSettingsPages(query);
  const searching = Boolean(query.trim());
  const current = SETTINGS_PAGES.find((item) => item.id === page)!;

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current
      ?.querySelector<HTMLButtonElement>('.settings-close')
      ?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      const active = document.activeElement;
      if (!panel || event.defaultPrevented || event.isComposing) return;
      // Sign-in dialogs rendered outside this panel manage their own focus.
      if (!panel.contains(active) && active !== document.body) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...panel.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          element.getClientRects().length > 0,
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && (active === first || active === document.body)) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (active === last || active === document.body)
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const contents: Record<SettingsPage, ReactNode> = {
    general: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-life-title"
        >
          <h3 id="settings-life-title">生活世界</h3>
          <div className="settings-group settings-block">
            <label className="settings-life-visibility">
              <span className="settings-row-copy">
                <strong>Allに表示する</strong>
                <span className="settings-muted" id="settings-life-description">
                  生活世界のタスクを、Allの一覧に含めます。
                </span>
              </span>
              <input
                className="settings-toggle"
                type="checkbox"
                aria-label="Allに表示する"
                aria-describedby="settings-life-description"
                checked={data.preferences?.showInAll ?? false}
                onChange={(event) =>
                  lifeWorldStore.setShowInAll(event.target.checked)
                }
              />
            </label>
          </div>
        </section>
        <section
          className="settings-section"
          aria-labelledby="settings-timezone-title"
        >
          <h3 id="settings-timezone-title">タイムゾーン</h3>
          <div className="settings-group settings-block">
            <p className="settings-muted">
              today の日付と時刻付き期限に使用します。
            </p>
            {isCloudConfigured ? (
              <>
                <SignedIn>
                  <TimeZoneSetting />
                </SignedIn>
                <SignedOut>
                  <p className="settings-muted">
                    保存するにはサインインしてください。
                  </p>
                </SignedOut>
              </>
            ) : (
              <p className="settings-muted">
                クラウド接続が設定されていません。
              </p>
            )}
          </div>
        </section>
      </>
    ),
    appearance: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-theme-title"
        >
          <h3 id="settings-theme-title">表示</h3>
          <div className="settings-group settings-block">
            <div className="settings-row settings-theme-row">
              <div className="settings-row-copy">
                <strong>テーマ</strong>
                <span className="settings-muted">
                  この端末の画面の配色を選びます。
                </span>
              </div>
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
                      const step =
                        event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 1
                          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                            ? -1
                            : 0;
                      if (!step) return;
                      event.preventDefault();
                      const next =
                        (index + step + THEMES.length) % THEMES.length;
                      onThemeChange(THEMES[next].id);
                      const buttons =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          '[role="radio"]',
                        );
                      buttons?.[next]?.focus();
                    }}
                  >
                    <span
                      className={`theme-swatch theme-swatch--${option.id}`}
                      aria-hidden="true"
                    />
                    <span className="theme-option-name">
                      {option.lines.map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row settings-mascot-style">
              <label
                className="settings-row-copy"
                htmlFor="settings-mascot-style"
              >
                <strong>チルノのスタイル</strong>
                <span
                  className="settings-muted"
                  id="settings-mascot-description"
                >
                  チルノの見た目を切り替えます。
                </span>
              </label>
              <select
                id="settings-mascot-style"
                aria-label="チルノのスタイル"
                aria-describedby="settings-mascot-description"
                value={mascotStyle}
                onChange={(event) =>
                  saveMascotStyle(
                    event.target.value === 'flat' ? 'flat' : 'matte',
                  )
                }
              >
                <option value="matte">マット（標準）</option>
                <option value="flat">フラット</option>
              </select>
            </div>
          </div>
        </section>
      </>
    ),
    notifications: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-notifications-title"
        >
          <h3 id="settings-notifications-title">この端末</h3>
          <div className="settings-group settings-block">
            {isCloudConfigured ? (
              <>
                <SignedIn>
                  <NotificationSettings />
                </SignedIn>
                <SignedOut>
                  <p className="settings-muted">
                    通知にはサインインが必要です。
                  </p>
                </SignedOut>
              </>
            ) : (
              <p className="settings-muted">通知にはクラウド接続が必要です。</p>
            )}
          </div>
        </section>
      </>
    ),
    partner: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-partner-title"
        >
          <h3 id="settings-partner-title">パートナー</h3>
          <div className="settings-group settings-block">
            <PartnerSettings />
          </div>
        </section>
      </>
    ),
    connections: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-mcp-title"
        >
          <h3 id="settings-mcp-title">MCP接続履歴</h3>
          <div className="settings-group settings-block">
            <p className="settings-muted">
              このアカウントでMCPツールを利用した接続元と、その最終利用日時です。現在の認可・トークンの有効性は確認できません。記録開始前の利用は表示されません。
            </p>
            {isCloudConfigured ? (
              <>
                <SignedIn>
                  <McpConnectionHistory />
                </SignedIn>
                <SignedOut>
                  <p className="settings-muted">
                    表示するにはサインインしてください。
                  </p>
                </SignedOut>
              </>
            ) : (
              <p className="settings-muted">
                クラウド接続が設定されていません。
              </p>
            )}
          </div>
        </section>
      </>
    ),
    account: (
      <>
        <section
          className="settings-section"
          aria-labelledby="settings-account-delete-title"
        >
          <h3 id="settings-account-delete-title">アカウント削除</h3>
          <div className="settings-group settings-block">
            {isCloudConfigured ? (
              <>
                <SignedIn>
                  <AccountDeletionSetting />
                </SignedIn>
                <SignedOut>
                  <p className="settings-muted">
                    削除するにはサインインしてください。
                  </p>
                </SignedOut>
              </>
            ) : (
              <p className="settings-muted">
                クラウド接続が設定されていません。
              </p>
            )}
          </div>
        </section>
      </>
    ),
  };

  return (
    <div
      id="app-settings-panel"
      className="help-backdrop settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="設定"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="settings-panel" ref={panelRef}>
        <aside className="settings-sidebar" aria-label="設定のカテゴリ">
          <div className="settings-head">
            <h2>設定</h2>
            <button
              type="button"
              className="settings-close"
              onClick={onClose}
              aria-label="閉じる"
              title="閉じる"
            >
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="settings-search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              aria-label="設定を検索"
              placeholder="設定を検索"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                contentRef.current?.scrollTo({ top: 0 });
              }}
            />
            {query ? (
              <button
                type="button"
                aria-label="検索をクリア"
                onClick={() => setQuery('')}
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>
          <nav className="settings-nav" aria-label="設定カテゴリ">
            {matches.map((item) => {
              const Icon = PAGE_ICONS[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={
                    !searching && page === item.id ? 'page' : undefined
                  }
                  aria-controls={`settings-page-${item.id}`}
                  onClick={() => {
                    setPage(item.id);
                    setQuery('');
                    contentRef.current?.scrollTo({ top: 0 });
                  }}
                >
                  <Icon size={18} aria-hidden />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        <div
          className="settings-content"
          ref={contentRef}
          aria-labelledby="settings-current-title"
        >
          <header className="settings-page-heading">
            <h2 id="settings-current-title">
              {searching ? '検索結果' : current.label}
            </h2>
            <p className="settings-muted">
              {searching
                ? `「${query.trim()}」に一致するカテゴリ：${matches.length}件`
                : current.description}
            </p>
          </header>
          {searching && matches.length === 0 ? (
            <div className="settings-empty">
              <Search size={26} aria-hidden />
              <p>一致する設定がありません。</p>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setQuery('')}
              >
                検索をクリア
              </button>
            </div>
          ) : null}
          {SETTINGS_PAGES.map((item) => (
            <div
              key={item.id}
              className="settings-page"
              id={`settings-page-${item.id}`}
              role="region"
              aria-label={item.label}
              hidden={
                searching
                  ? !matches.some((match) => match.id === item.id)
                  : page !== item.id
              }
            >
              {contents[item.id]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
