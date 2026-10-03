import { useRef, useState } from 'react';
import { ArrowDown, Check, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { SHORTCUTS } from '../lib/shortcuts';

const MCP_URL = 'https://app.bizencore.com/mcp';

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const mcpRef = useRef<HTMLElement>(null);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="help-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="ヘルプ"
      onClick={onClose}
    >
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h2 className="help-title">ヘルプ</h2>
          <div className="help-head-actions">
            <button
              type="button"
              className="help-jump"
              onClick={() => mcpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              MCP接続 <ArrowDown size={13} aria-hidden />
            </button>
            <button type="button" className="ghost-btn" onClick={onClose} autoFocus>
              閉じる
            </button>
          </div>
        </div>
        <h3 className="help-section-title">キーボードショートカット</h3>
        <dl className="help-list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="help-row">
              <dt className="help-keys">{shortcut.keys}</dt>
              <dd className="help-label">{shortcut.label}</dd>
            </div>
          ))}
        </dl>
        <p className="muted help-foot">
          Windows / Linux では ⌘ を Ctrl、⌥ を Alt に読み替えてください。
        </p>
        <section ref={mcpRef} className="help-mcp" aria-labelledby="help-mcp-title">
          <h3 id="help-mcp-title">MCP接続</h3>
          <div className="help-mcp-url">
            <code>{MCP_URL}</code>
            <button
              type="button"
              className="help-mcp-copy"
              onClick={copyUrl}
              aria-label={copied ? 'コピー済み' : '接続URLをコピー'}
              title={copied ? 'コピー済み' : '接続URLをコピー'}
            >
              {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
            </button>
          </div>
          <p className="help-mcp-intro">接続時にbizencoreアカウントで認証します。</p>
          <p className="help-mcp-intro">AIとの会話では「bizencoreのwork_on_taskで進めて」と伝えてください。MCP Apps対応クライアントではピッカーで選べます。MCP Appsが使えなければ選択フォーム、フォームも使えなければ番号リストを使います。どちらも、まずラベルを選び、次にそのラベルのタスクを選びます。タスクの詳細パネルから始める場合は「MCPで進める」を選んでください。情報が足りなければAIと相談してから作業し、完了または途中経過を記録します。</p>

          <details className="help-mcp-guide">
            <summary>ChatGPT <ChevronRight size={15} aria-hidden /></summary>
            <ol>
              <li>Web版の設定で「Apps」の開発者モードを有効にする。</li>
              <li>「Apps → Create」で上のURLを登録し、ツールをスキャンする。</li>
              <li>bizencoreで認証し、チャットのツールから作成したアプリを選ぶ。</li>
            </ol>
            <p>タスクの追加・更新には、フルMCP対応のBusiness / Enterprise / Eduワークスペースが必要です。</p>
            <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target="_blank" rel="noopener noreferrer">
              公式手順 <ExternalLink size={12} aria-hidden />
            </a>
          </details>

          <details className="help-mcp-guide">
            <summary>Claude <ChevronRight size={15} aria-hidden /></summary>
            <ol>
              <li>「Customize → Connectors → + → Add custom connector」を開く。</li>
              <li>上のURLを登録し、「Connect」からbizencoreで認証する。</li>
              <li>チャットの「+ → Connectors」でbizencoreを有効にする。</li>
            </ol>
            <p>Team / Enterpriseでは、先に組織のOwnerによる追加が必要です。</p>
            <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noopener noreferrer">
              公式手順 <ExternalLink size={12} aria-hidden />
            </a>
          </details>

          <details className="help-mcp-guide">
            <summary>Codex <ChevronRight size={15} aria-hidden /></summary>
            <p>ターミナルで登録・認証します。ツールが見えない場合は新しいセッションを開いてください。</p>
            <pre><code>{`codex mcp add bizencore --url ${MCP_URL}\ncodex mcp login bizencore`}</code></pre>
            <p>CLIでは <code>$bizencore-work-on-task</code> を起動すると、ラベルとタスクを会話で選べます（スキルのインストールが必要）。Desktopではチャットで「bizencoreのwork_on_taskを使って」と依頼できます。</p>
            <a href="https://developers.openai.com/codex/mcp" target="_blank" rel="noopener noreferrer">
              公式手順 <ExternalLink size={12} aria-hidden />
            </a>
          </details>

          <details className="help-mcp-guide">
            <summary>Claude Code <ChevronRight size={15} aria-hidden /></summary>
            <p>ターミナルで登録し、Claude Codeの「/mcp」から認証します。</p>
            <pre><code>{`claude mcp add --transport http --scope user bizencore ${MCP_URL}`}</code></pre>
            <p>CLIでは「/mcp__bizencore__work_on_task」を起動できます。DesktopのCodeタブでは、コマンドが見えなければチャットで同じ名前を指定してください。</p>
            <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noopener noreferrer">
              公式手順 <ExternalLink size={12} aria-hidden />
            </a>
          </details>
        </section>
      </div>
    </div>
  );
}
