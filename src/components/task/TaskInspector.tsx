import { Check, Copy, ExternalLink, FileText, Link2, Paperclip, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AI_TARGETS, buildTaskPrompt } from '../../lib/aiHandoff';
import { MAX_ATTACHMENTS, attachmentLabel, isUrl, liveAttachments } from '../../lib/attachments';
import { isCloudConfigured } from '../../lib/cloudConfig';
import { QUEST_IMG, QUEST_KINDS, QUEST_LABEL } from '../../lib/quests';
import { estimateInputValue, parseEstimate } from '../../lib/taskEstimate';
import type { Item, ItemMap, TaskKind } from '../../lib/taskModel';
import { TaskFileInput, TaskFileLink } from './TaskFileContext';

export interface TaskInspectorProps {
  item: Item;
  items: ItemMap;
  todayDate: string;
  onClose: () => void;
  onTextChange: (id: string, text: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onCompletionCriteriaChange: (id: string, value: string) => void;
  onSetDeadline: (id: string, dueDate: string | undefined, dueTime: string | undefined) => void;
  onToggleToday: (id: string) => void;
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

/**
 * タスクの詳細パネル。行に載せきれない項目と操作をここに集める。
 * 行のボタンは残したまま足しているので、どちらからでも同じ値を変えられる。
 */
export function TaskInspector(props: TaskInspectorProps) {
  const {
    item,
    items,
    todayDate,
    onClose,
    onTextChange,
    onNoteChange,
    onCompletionCriteriaChange,
    onSetDeadline,
    onToggleToday,
    onSetEstimate,
    onSetKind,
    onRemove,
    onAddAttachment,
    onRemoveAttachment,
  } = props;
  const titleRef = useAutoGrow();
  const noteRef = useAutoGrow();
  const criteriaRef = useAutoGrow();
  const [estimateDraft, setEstimateDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const contextRef = useAutoGrow();
  const attachments = liveAttachments(item.attachments);
  const isToday = item.assignedDate === todayDate;

  // 開いたら本文にフォーカスする
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [item.id, titleRef]);

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

  const copyCommand = async (id: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      window.prompt('コピーしてください', command);
    }
  };

  /** 入力欄の中身を添える。添えられたら欄を空にする */
  const addContext = (value: string) => {
    if (!value.trim()) return;
    if (onAddAttachment(item.id, { text: value })) setContextDraft('');
  };

  const prompt = buildTaskPrompt(item, items);

  return (
    <aside
      className="inspector"
      role="dialog"
      aria-label="タスクの詳細"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="inspector-head">
        <span className="inspector-kicker">詳細</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる（Esc）" title="閉じる（Esc）">
          <X size={16} />
        </button>
      </div>

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
                  {att.kind === 'link' ? (
                    <a className="context-title" href={att.url} target="_blank" rel="noopener noreferrer">
                      {attachmentLabel(att)}
                    </a>
                  ) : att.kind === 'file' && isCloudConfigured ? (
                    <TaskFileLink taskId={item.id} attachmentId={att.id} title={attachmentLabel(att)} />
                  ) : (
                    <span className="context-title">{attachmentLabel(att)}</span>
                  )}
                  {att.kind === 'text' && att.text && att.text.trim() !== attachmentLabel(att) ? (
                    <p className="context-text">{att.text}</p>
                  ) : null}
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
        {isCloudConfigured ? (
          <TaskFileInput
            taskId={item.id}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            onUploaded={(input) => { onAddAttachment(item.id, input); }}
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

      <section className="inspector-section">
        <h3 className="inspector-label">AI ハンドオフ</h3>
        <p className="inspector-hint">本文・メモ・サブタスクをまとめた指示文で始めます。</p>
        <div className="inspector-ai">
          {AI_TARGETS.map((target) =>
            target.kind === 'open' ? (
              <a
                key={target.id}
                className="inspector-ai-btn"
                href={target.url(prompt)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {target.name}
                <ExternalLink size={13} aria-hidden />
              </a>
            ) : (
              <button
                key={target.id}
                type="button"
                className="inspector-ai-btn"
                onClick={() => copyCommand(target.id, target.command(prompt))}
                title="起動コマンドをコピー"
              >
                {target.name}
                {copied === target.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copied === target.id ? <span className="inspector-copied">コピーしました</span> : null}
              </button>
            )
          )}
        </div>
      </section>

      <div className="inspector-foot">
        <button type="button" className="ghost-btn inspector-remove" onClick={() => onRemove(item.id)}>
          <Trash2 size={14} aria-hidden />
          削除
        </button>
      </div>
    </aside>
  );
}
