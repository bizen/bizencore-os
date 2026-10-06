import { AppWindow, Check, Copy, ExternalLink, FileText, Globe, Link2, LockKeyhole, Paperclip, Settings, Trash2, X } from 'lucide-react';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AI_TARGETS, aiConversationLink, buildTaskHandoff, readHandoffPreferences, saveHandoffPreferences, type HandoffPreferences } from '../../lib/aiHandoff';
import type { HandoffIntent } from '../../lib/taskWorkPrompt';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_TEXT, attachmentLabel, isUrl, liveAttachments } from '../../lib/attachments';
import { isCloudConfigured } from '../../lib/cloudConfig';
import { showDatePicker } from '../../lib/nativeDatePicker';
import { QUEST_IMG, QUEST_KINDS, QUEST_LABEL } from '../../lib/quests';
import { estimateInputValue, parseEstimate } from '../../lib/taskEstimate';
import type { Item, ItemMap, TaskKind } from '../../lib/taskModel';
import { TaskFileInput, TaskFileLink } from './TaskFileContext';
import { HandoffIntentControl } from './HandoffIntentControl';
import { ContextDocument } from './ContextDocument';
import { InspectorDialog } from './InspectorDialog';

export interface TaskInspectorProps {
  item: Item;
  items: ItemMap;
  initialFocus: 'title' | 'estimate';
  todayDate: string;
  onClose: () => void;
  onTextChange: (id: string, text: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onCompletionCriteriaChange: (id: string, value: string) => void;
  onSetDeadline: (id: string, dueDate: string | undefined, dueTime: string | undefined) => void;
  onToggleToday: (id: string) => void;
  onSetLocked: (id: string, locked: boolean) => void;
  onSetEstimate: (id: string, estimate: number | undefined) => void;
  onSetKind: (id: string, kind: TaskKind | undefined) => void;
  onRemove: (id: string) => void;
  onAddAttachment: (id: string, input: { id?: string; text?: string; storageId?: string; title?: string; mimeType?: string; size?: number }) => boolean;
  onRemoveAttachment: (id: string, attachmentId: string) => void;
}

/**
 * 中身に合わせて高さを伸ばす。box-sizing が border-box なので枠線の分も足す。
 * 開いた直後の動きやフォントの読み込み、画面の大きさの変化で行の幅や高さが
 * 変わるので、そのたびに測り直す（スマホで本文が途中で切れないように）。
 */
function useAutoGrow() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
  }, []);
  useLayoutEffect(fit);
  useEffect(() => {
    const frame = requestAnimationFrame(fit);
    const settle = setTimeout(fit, 250);
    window.addEventListener('resize', fit);
    document.fonts?.ready.then(fit).catch(() => {});
    // パネルに縦のスクロールバーが出ると、画面の大きさは同じまま欄の幅だけ狭くなる。
    // 幅が変わったら折り返しも変わるので、欄そのものを見張って測り直す
    let lastWidth = 0;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? 0;
            if (width !== lastWidth) {
              lastWidth = width;
              fit();
            }
          });
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [fit]);
  return ref;
}

function actorLabel(actor: Item['createdBy'], client?: string): string {
  if (actor === 'user') return 'by user';
  if (actor === 'ai') return `by agent${client ? ` · ${client}` : ''}`;
  return '不明';
}

function TaskAiHandoff({ item, items, canUseMcp }: { item: Item; items: ItemMap; canUseMcp: boolean }) {
  const [preferences, setPreferences] = useState(readHandoffPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const mode = canUseMcp ? preferences.mode : 'text';
  const destination = preferences.destination;
  const [intent, setIntent] = useState<HandoffIntent>('consult');
  const [copied, setCopied] = useState<string | null>(null);
  const prompt = buildTaskHandoff(item, items, mode, intent);

  const changePreferences = (changes: Partial<HandoffPreferences>) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    saveHandoffPreferences(next);
    setCopied(null);
  };

  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      window.prompt('コピーしてください', value);
    }
  };

  return (
    <section className="inspector-section inspector-handoff" onKeyDown={(event) => {
      if (settingsOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(false);
        settingsButtonRef.current?.focus();
      }
    }}>
      <div className="handoff-heading">
        <h3 className="inspector-label">エージェントハンドオフ</h3>
        <button ref={settingsButtonRef} type="button" className="icon-btn handoff-settings-toggle" aria-label="エージェントハンドオフの接続設定" title="接続設定" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(!settingsOpen)}>
          <Settings size={15} aria-hidden />
        </button>
      </div>
      {settingsOpen ? (
        <div className="handoff-settings" id={settingsId} role="region" aria-label="エージェントハンドオフの接続設定">
          <div className="handoff-option">
            <span className="handoff-option-label">渡し方</span>
            <div className="inspector-handoff-mode" role="group" aria-label="AIへの渡し方">
              <button type="button" className={mode === 'mcp' ? 'is-on' : ''} aria-pressed={mode === 'mcp'} disabled={!canUseMcp} onClick={() => changePreferences({ mode: 'mcp' })} title={canUseMcp ? '選んだAIにも同じアカウントのbizencore MCP接続が必要です' : 'MCP連携にはサインインが必要です'}>MCPで進める</button>
              <button type="button" className={mode === 'text' ? 'is-on' : ''} aria-pressed={mode === 'text'} onClick={() => changePreferences({ mode: 'text' })} title="現在の内容のコピーを渡す。進捗の自動反映と添付ファイルの転送はできません">内容だけ渡す</button>
            </div>
          </div>
          <div className="handoff-option">
            <span className="handoff-option-label">開く先</span>
            <div className="inspector-handoff-mode" role="group" aria-label="Claude・ChatGPTの開く先">
              <button type="button" className={destination === 'web' ? 'is-on' : ''} aria-pressed={destination === 'web'} onClick={() => changePreferences({ destination: 'web' })} title="Claude・ChatGPTをWebで開く"><Globe size={14} aria-hidden />Web</button>
              <button type="button" className={destination === 'desktop' ? 'is-on' : ''} aria-pressed={destination === 'desktop'} onClick={() => changePreferences({ destination: 'desktop' })} title="Claude・ChatGPTをインストール済みのデスクトップアプリで開く"><AppWindow size={14} aria-hidden />アプリ</button>
            </div>
          </div>
          {!canUseMcp ? <p className="inspector-hint" role="status">MCP連携にはサインインが必要です。</p> : null}
        </div>
      ) : null}
      <HandoffIntentControl intent={intent} onChange={(value) => { setIntent(value); setCopied(null); }} />
      <div className="inspector-ai">
        {AI_TARGETS.map((target) => {
          if (target.kind === 'open') {
            const link = aiConversationLink(target, prompt, destination, mode);
            if (destination === 'desktop' || !link.copyPrompt) return (
              <a
                key={target.id}
                className="inspector-ai-btn"
                href={link.url}
                target={destination === 'web' ? '_blank' : undefined}
                rel="noopener noreferrer"
                onClick={link.copyPrompt ? () => { void copy(target.id, prompt); } : undefined}
                title={link.copyPrompt ? '指示文を全文コピーしてアプリを開く。開いた会話に貼り付けてください' : destination === 'desktop' ? '指示文を入力した新しい会話をアプリで開く（送信はしません）' : 'Webで新しい会話を開く'}
              >
                {target.name}
                {copied === target.id ? <Check size={13} aria-hidden /> : destination === 'desktop' ? <AppWindow size={13} aria-hidden /> : <ExternalLink size={13} aria-hidden />}
                {copied === target.id ? <span className="inspector-copied">会話に貼り付けてください</span> : null}
              </a>
            );
            return (
              <button
                key={target.id}
                type="button"
                className="inspector-ai-btn"
                onClick={() => {
                  void copy(target.id, prompt);
                  window.open(link.url, '_blank', 'noopener,noreferrer');
                }}
                title="指示文をコピーして会話を開く"
              >
                {target.name}
                {copied === target.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copied === target.id ? <span className="inspector-copied">会話に貼り付けてください</span> : null}
              </button>
            );
          }
          return (
            <button
              key={target.id}
              type="button"
              className="inspector-ai-btn"
              onClick={() => void copy(target.id, target.command(prompt))}
              title="起動コマンドをコピー"
            >
              {target.name}
              {copied === target.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              {copied === target.id ? <span className="inspector-copied">コピーしました</span> : null}
            </button>
          );
        })}
      </div>
      <p className="handoff-summary" aria-label="現在のハンドオフ設定">
        <span title={mode === 'mcp' ? '引き継ぎ先のAIでbizencore MCP接続が必要です' : '進捗の自動反映と添付ファイルの転送はできません'}>{mode === 'mcp' ? 'MCPで引き継ぎ' : '内容のみ'}</span>
        <span aria-hidden>·</span>
        <span title="Claude・ChatGPTの開く先。Claude Code・CodexはCLIコマンドをコピーします">{destination === 'desktop' ? <AppWindow size={12} aria-hidden /> : <Globe size={12} aria-hidden />}{destination === 'desktop' ? 'アプリ' : 'Web'}</span>
      </p>
    </section>
  );
}

/**
 * タスクの詳細パネル。行に載せきれない項目と操作をここに集める。
 * 作業想定時間など、行に置かない項目もここで編集する。
 */
export function TaskInspector(props: TaskInspectorProps) {
  const {
    item,
    items,
    initialFocus,
    todayDate,
    onClose,
    onTextChange,
    onNoteChange,
    onCompletionCriteriaChange,
    onSetDeadline,
    onToggleToday,
    onSetLocked,
    onSetEstimate,
    onSetKind,
    onRemove,
    onAddAttachment,
    onRemoveAttachment,
  } = props;
  const titleRef = useAutoGrow();
  const noteRef = useAutoGrow();
  const criteriaRef = useAutoGrow();
  const estimateRef = useRef<HTMLInputElement | null>(null);
  const [estimateDraft, setEstimateDraft] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const [contextError, setContextError] = useState('');
  const contextRef = useAutoGrow();
  const attachments = liveAttachments(item.attachments);
  const isToday = item.assignedDate === todayDate;

  // 通常は本文へ。⌥E から開いたときは想定時間へ直行する
  useEffect(() => {
    if (initialFocus === 'estimate') {
      estimateRef.current?.focus();
      estimateRef.current?.select();
      return;
    }
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [item.id, initialFocus, titleRef]);

  const commitEstimate = () => {
    if (estimateDraft === null) return;
    const parsed = parseEstimate(estimateDraft);
    if (parsed === null) {
      setEstimateDraft(null);
      return;
    }
    onSetEstimate(item.id, parsed);
    setEstimateDraft(null);
  };

  /** 入力欄の中身を添える。添えられたら欄を空にする */
  const addContext = (value: string) => {
    if (!value.trim()) return;
    if (value.trim().length > MAX_ATTACHMENT_TEXT) { setContextError('文章は 100,000 文字以下にしてください。内容は保存されていません。'); return; }
    if (onAddAttachment(item.id, { text: value })) { setContextDraft(''); setContextError(''); }
    else setContextError('追加できませんでした。資料の数・合計容量、または端末の保存容量を確認してください。');
  };

  return (
    <InspectorDialog label="タスクの詳細" onClose={onClose}>
      <div className="inspector-identity">
        <textarea
          ref={titleRef}
          rows={1}
          className="inspector-title"
          value={item.text}
          placeholder="タスク"
          spellCheck={false}
          onChange={(e) => onTextChange(item.id, e.target.value)}
          aria-label="タスク"
        />
        <dl className="inspector-attribution">
          <div>
            <dt>作成</dt>
            <dd>{actorLabel(item.createdBy, item.createdByClient)}</dd>
          </div>
          {item.done ? (
            <div>
              <dt>完了</dt>
              <dd>{actorLabel(item.completedBy, item.completedByClient)}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="inspector-prop">
        <span className="inspector-label">タスクロック</span>
        <button
          type="button"
          role="switch"
          className="task-lock-toggle"
          aria-label="タスクロック"
          aria-checked={!!item.locked}
          disabled={item.done && !item.locked}
          title={item.done && !item.locked ? '未完了に戻してからロックできます' : item.locked ? 'ロックを解除する' : 'タスクをロックする'}
          onClick={() => onSetLocked(item.id, !item.locked)}
        >
          <LockKeyhole size={14} aria-hidden />
          <span className="task-lock-track" aria-hidden><span /></span>
        </button>
      </div>

      <section className="inspector-section">
        <h3 className="inspector-label">メモ</h3>
        <textarea
          ref={noteRef}
          rows={2}
          className="inspector-note"
          value={item.note ?? ''}
          placeholder="補足や、渡したい文脈"
          spellCheck={false}
          onChange={(e) => onNoteChange(item.id, e.target.value)}
          aria-label="メモ"
        />
      </section>

      <section className="inspector-section">
        <h3 className="inspector-label">完了条件</h3>
        <textarea
          ref={criteriaRef}
          rows={2}
          className="inspector-note"
          value={item.completionCriteria ?? ''}
          placeholder="何ができたら完了か"
          onChange={(e) => onCompletionCriteriaChange(item.id, e.target.value)}
          aria-label="完了条件"
        />
      </section>

      <section className="inspector-section inspector-context">
        <div className="inspector-context-head">
          <h3 className="inspector-label">コンテキスト</h3>
          {attachments.length > 0 ? <span className="inspector-count">{attachments.length}</span> : null}
        </div>

        {attachments.length > 0 ? (
          <ul className="context-list">
            {attachments.map((att) => (
              <li key={att.id} className={`context-item context-item--${att.kind}`}>
                <span className="context-icon" aria-hidden>
                  {att.kind === 'link' ? <Link2 size={14} /> : att.kind === 'file' ? <Paperclip size={14} /> : <FileText size={14} />}
                </span>
                <div className="context-body">
                  {att.kind === 'text' && att.text ? (
                    <ContextDocument document={{ id: att.id, title: attachmentLabel(att), text: att.text, revision: att.revision }} />
                  ) : att.kind === 'link' ? (
                    <a className="context-title" href={att.url} target="_blank" rel="noopener noreferrer">
                      {attachmentLabel(att)}
                    </a>
                  ) : att.kind === 'file' && isCloudConfigured ? (
                    <TaskFileLink taskId={item.id} attachmentId={att.id} title={attachmentLabel(att)} />
                  ) : (
                    <span className="context-title">{attachmentLabel(att)}</span>
                  )}
                  {att.kind === 'link' && att.title ? <span className="context-sub">{att.url}</span> : null}
                </div>
                {att.by === 'ai' ? (
                  <span className="context-by" title="AI が添えた">
                    AI
                  </span>
                ) : null}
                <button
                  type="button"
                  className="icon-btn context-remove"
                  onClick={() => onRemoveAttachment(item.id, att.id)}
                  aria-label="外す"
                  title="外す"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <textarea
          ref={contextRef}
          rows={1}
          className="inspector-note context-input"
          value={contextDraft}
          placeholder="リンクか文章を貼って Enter"
          spellCheck={false}
          onChange={(e) => setContextDraft(e.target.value)}
          onPaste={(e) => {
            // 空の欄に URL だけを貼ったら、その場で添える
            const pasted = e.clipboardData.getData('text');
            if (!contextDraft.trim() && isUrl(pasted)) {
              e.preventDefault();
              addContext(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addContext(contextDraft);
            }
          }}
          aria-label="コンテキストを添える"
        />
        {contextError ? <p className="context-error" role="alert">{contextError}</p> : null}
        {isCloudConfigured ? (
          <TaskFileInput
            key={item.id}
            taskId={item.id}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            attachmentIds={attachments.map(attachment => attachment.id)}
            onUploaded={(input) => onAddAttachment(item.id, input)}
          />
        ) : null}
      </section>

      <section className="inspector-section inspector-props">
        <div className="inspector-prop">
          <span className="inspector-label">期限</span>
          <div className="inspector-deadline">
            <input
              type="date"
              className="inspector-input"
              value={item.dueDate ?? ''}
              onChange={(e) => onSetDeadline(item.id, e.target.value || undefined, item.dueTime)}
              onClick={(e) => showDatePicker(e.currentTarget)}
              aria-label="期限の日付"
            />
            {item.dueDate ? (
              <input
                type="time"
                className="inspector-input"
                value={item.dueTime ?? ''}
                onChange={(e) => onSetDeadline(item.id, item.dueDate, e.target.value || undefined)}
                aria-label="期限の時刻（任意）"
              />
            ) : null}
          </div>
        </div>
        <div className="inspector-prop">
          <span className="inspector-label">today</span>
          <button
            type="button"
            className={`meta-today${isToday ? ' is-on' : ''}`}
            onClick={() => onToggleToday(item.id)}
            aria-pressed={isToday}
            title="⌥T"
          >
            today
          </button>
        </div>

        <div className="inspector-prop">
          <label className="inspector-label" htmlFor={`estimate-${item.id}`}>
            想定時間
          </label>
          <input
            ref={estimateRef}
            id={`estimate-${item.id}`}
            className="inspector-input"
            value={estimateDraft ?? estimateInputValue(item.estimate)}
            placeholder="例: 45m"
            onChange={(e) => setEstimateDraft(e.target.value)}
            onBlur={commitEstimate}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEstimate();
              }
            }}
          />
        </div>

        <div className="inspector-prop">
          <span className="inspector-label">種別</span>
          <div className="inspector-kinds" role="radiogroup" aria-label="クエスト種別">
            <button
              type="button"
              role="radio"
              aria-checked={!item.kind}
              className={`inspector-kind${!item.kind ? ' is-on' : ''}`}
              onClick={() => onSetKind(item.id, undefined)}
            >
              なし
            </button>
            {QUEST_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={item.kind === kind}
                className={`inspector-kind${item.kind === kind ? ' is-on' : ''}`}
                onClick={() => onSetKind(item.id, kind)}
              >
                <img src={QUEST_IMG[kind]} alt="" />
                {QUEST_LABEL[kind]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {isCloudConfigured ? (
        <>
          <SignedIn><TaskAiHandoff key={item.id} item={item} items={items} canUseMcp /></SignedIn>
          <SignedOut><TaskAiHandoff key={item.id} item={item} items={items} canUseMcp={false} /></SignedOut>
        </>
      ) : <TaskAiHandoff key={item.id} item={item} items={items} canUseMcp={false} />}

      <div className="inspector-foot">
        <button type="button" className="ghost-btn inspector-remove" onClick={() => onRemove(item.id)}>
          <Trash2 size={14} aria-hidden />
          削除
        </button>
      </div>
    </InspectorDialog>
  );
}
