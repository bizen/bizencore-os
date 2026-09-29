import { Check, Copy, ExternalLink, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AI_TARGETS, buildTaskPrompt } from '../../lib/aiHandoff';
import { QUEST_IMG, QUEST_KINDS, QUEST_LABEL } from '../../lib/quests';
import { estimateInputValue, parseEstimate } from '../../lib/taskEstimate';
import type { Item, ItemMap, TaskKind } from '../../lib/taskModel';

export interface TaskInspectorProps {
  item: Item;
  items: ItemMap;
  todayDate: string;
  onClose: () => void;
  onTextChange: (id: string, text: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onToggleToday: (id: string) => void;
  onSetEstimate: (id: string, estimate: number | undefined) => void;
  onSetKind: (id: string, kind: TaskKind | undefined) => void;
  onRemove: (id: string) => void;
}

function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

/**
 * タスクの詳細パネル。行に載せきれない項目と操作をここに集める。
 * 行のボタンは残したまま足しているので、どちらからでも同じ値を変えられる。
 */
export function TaskInspector(props: TaskInspectorProps) {
  const { item, items, todayDate, onClose, onTextChange, onNoteChange, onToggleToday, onSetEstimate, onSetKind, onRemove } =
    props;
  const titleRef = useAutoGrow(item.text);
  const noteRef = useAutoGrow(item.note ?? '');
  const [estimateDraft, setEstimateDraft] = useState(estimateInputValue(item.estimate));
  const [copied, setCopied] = useState<string | null>(null);
  const isToday = item.assignedDate === todayDate;

  // 別のタスクに切り替わったら、想定時間の下書きを合わせ直す
  useEffect(() => {
    setEstimateDraft(estimateInputValue(item.estimate));
  }, [item.id, item.estimate]);

  // 開いたら本文にフォーカスする
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [item.id, titleRef]);

  const commitEstimate = () => {
    const parsed = parseEstimate(estimateDraft);
    if (parsed === null) {
      setEstimateDraft(estimateInputValue(item.estimate));
      return;
    }
    onSetEstimate(item.id, parsed);
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

      <section className="inspector-section inspector-props">
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
            value={estimateDraft}
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
        <h3 className="inspector-label">AI に送る</h3>
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
