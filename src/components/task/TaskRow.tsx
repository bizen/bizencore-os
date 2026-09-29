import { Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { LABEL_COLORS, type Item, type LabelColor, type TaskKind } from '../../lib/taskModel';
import { handleMetaKeyDown } from '../../lib/metaCursor';
import { EstimateField } from './EstimateField';
import { LabelColorPicker } from './LabelColorPicker';

const QUEST_IMG: Record<TaskKind, string> = {
  main: '/quests/mainquest.png',
  tanomi: '/quests/tanomigoto.png',
};

const QUEST_LABEL: Record<TaskKind, string> = {
  main: 'メインクエスト',
  tanomi: '頼みごと',
};

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
 * チェックマークは線を描き込みたいので、アイコンフォントではなく path を直接持つ。
 * fill / mark / ring の3層で、押し込み・描き込み・広がる輪をそれぞれ担当する。
 */
function CheckBox({
  done,
  bursting,
  todayNumber,
  onToggle,
}: {
  done: boolean;
  bursting: boolean;
  todayNumber?: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`check${done ? ' is-checked' : ''}${bursting ? ' is-bursting' : ''}`}
      onClick={onToggle}
      tabIndex={-1}
      aria-pressed={done}
      aria-label={done ? '未完了に戻す' : '完了にする'}
      title="⌘Enter"
    >
      <span className="check-fill" aria-hidden />
      <svg className="check-mark" viewBox="0 0 16 16" aria-hidden>
        <path d="M3.4 8.3 L6.5 11.4 L12.6 4.7" />
      </svg>
      {!done && todayNumber ? <span className="check-num">{todayNumber}</span> : null}
    </button>
  );
}

export interface TaskRowProps {
  item: Item;
  depth: number;
  /** 親から離れて棚に置かれたサブタスクに添える親の名前 */
  context?: string;
  todayDate: string;
  todayNumber?: number;
  isActive: boolean;
  /** 完了の演出中だけ入る。値は点灯をずらす順番 */
  burstIndex?: number;
  noteOpen: boolean;
  estimateEditing: boolean;
  colorOpen: boolean;
  registerTitle: (id: string, el: HTMLTextAreaElement | null) => void;
  registerNote: (id: string, el: HTMLTextAreaElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, item: Item) => void;
  onNoteKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, item: Item) => void;
  onFocusRow: (id: string) => void;
  onTextChange: (id: string, text: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onToggleDone: (id: string) => void;
  onToggleToday: (id: string) => void;
  onCycleKind: (id: string) => void;
  onSetEstimate: (id: string, estimate: number | undefined) => void;
  onEstimateEditingChange: (id: string, editing: boolean) => void;
  onColorOpenChange: (id: string, open: boolean) => void;
  onRemove: (id: string) => void;
  onTitleBlur: (id: string) => void;
  onSetLabelColor: (id: string, color: LabelColor | undefined) => void;
}

export function TaskRow(props: TaskRowProps) {
  const {
    item,
    depth,
    context,
    todayDate,
    todayNumber,
    isActive,
    burstIndex,
    noteOpen,
    estimateEditing,
    colorOpen,
    registerTitle,
    registerNote,
    onKeyDown,
    onNoteKeyDown,
    onFocusRow,
    onTextChange,
    onNoteChange,
    onToggleDone,
    onToggleToday,
    onCycleKind,
    onSetEstimate,
    onEstimateEditingChange,
    onColorOpenChange,
    onRemove,
    onTitleBlur,
    onSetLabelColor,
  } = props;

  const titleRef = useAutoGrow(item.text);
  const noteRef = useAutoGrow(item.note ?? '');
  const isSection = item.type === 'section';
  const isToday = item.assignedDate === todayDate;

  const attachTitle = (el: HTMLTextAreaElement | null) => {
    titleRef.current = el;
    registerTitle(item.id, el);
  };

  const attachNote = (el: HTMLTextAreaElement | null) => {
    noteRef.current = el;
    registerNote(item.id, el);
  };

  return (
    <li
      className={[
        'row',
        isSection ? 'row--section' : 'row--task',
        depth === 0 ? 'row--root' : '',
        item.done ? 'is-done' : '',
        isActive ? 'is-active' : '',
        burstIndex === undefined ? '' : 'is-bursting',
      ]
        .filter(Boolean)
        .join(' ')}
      data-row-id={item.id}
      style={
        {
          '--depth': depth,
          '--burst-i': Math.min(burstIndex ?? 0, 6),
          ...(item.color ? { '--label-color': LABEL_COLORS[item.color] } : null),
        } as React.CSSProperties
      }
    >
      <div className="row-main">
        <div className="row-mark">
          {isSection ? (
            <span className="row-section-mark" aria-hidden />
          ) : (
            <CheckBox
              done={item.done}
              bursting={burstIndex !== undefined}
              todayNumber={todayNumber}
              onToggle={() => onToggleDone(item.id)}
            />
          )}
        </div>

        <div className="row-text">
          {context ? <span className="row-context">{context} ›</span> : null}
          <textarea
            ref={attachTitle}
            rows={1}
            className={`row-title${isSection ? ' row-title--section' : ''}`}
            value={item.text}
            placeholder={isSection ? 'ラベル' : 'タスク'}
            spellCheck={false}
            onChange={(e) => onTextChange(item.id, e.target.value)}
            onFocus={() => onFocusRow(item.id)}
            onBlur={() => onTitleBlur(item.id)}
            onKeyDown={(e) => onKeyDown(e, item)}
            aria-label={isSection ? 'ラベル' : 'タスク'}
          />
          {noteOpen || item.note ? (
            <textarea
              ref={attachNote}
              rows={1}
              className="row-note"
              value={item.note ?? ''}
              placeholder="メモ"
              spellCheck={false}
              onChange={(e) => onNoteChange(item.id, e.target.value)}
              onFocus={() => onFocusRow(item.id)}
              onKeyDown={(e) => onNoteKeyDown(e, item)}
              aria-label="メモ"
            />
          ) : null}
        </div>

        <div className={`row-meta${isSection ? ' row-meta--section' : ''}`}>
          {isSection ? (
            <LabelColorPicker
              color={item.color}
              isOpen={colorOpen}
              onOpenChange={(open) => onColorOpenChange(item.id, open)}
              onSelect={(color) => onSetLabelColor(item.id, color)}
              dataMeta="color"
              onChipKeyDown={handleMetaKeyDown}
              onChipFocus={() => onFocusRow(item.id)}
            />
          ) : null}

          {isSection ? null : (
            <>
              <button
                type="button"
                data-meta="kind"
                className={`meta-kind${item.kind ? ' is-set' : ''}`}
                onClick={() => onCycleKind(item.id)}
                onKeyDown={handleMetaKeyDown}
                onFocus={() => onFocusRow(item.id)}
                tabIndex={-1}
                aria-label={item.kind ? QUEST_LABEL[item.kind] : 'クエスト種別を選ぶ'}
                title={`${item.kind ? QUEST_LABEL[item.kind] : 'クエスト種別'}（⌥M）`}
              >
                {item.kind ? <img src={QUEST_IMG[item.kind]} alt="" /> : <span aria-hidden>◇</span>}
              </button>

              <button
                type="button"
                data-meta="today"
                className={`meta-today${isToday ? ' is-on' : ''}`}
                onClick={() => onToggleToday(item.id)}
                onKeyDown={handleMetaKeyDown}
                onFocus={() => onFocusRow(item.id)}
                tabIndex={-1}
                aria-pressed={isToday}
                aria-label={isToday ? 'today から外す' : 'today に入れる'}
                title="⌥T"
              >
                today
              </button>

              <EstimateField
                estimate={item.estimate}
                isEditing={estimateEditing}
                onSave={(estimate) => onSetEstimate(item.id, estimate)}
                onEditingChange={(editing) => onEstimateEditingChange(item.id, editing)}
                dataMeta="estimate"
                onChipKeyDown={handleMetaKeyDown}
                onChipFocus={() => onFocusRow(item.id)}
              />
            </>
          )}

          <button
            type="button"
            data-meta="remove"
            className="meta-remove"
            onClick={() => onRemove(item.id)}
            onKeyDown={handleMetaKeyDown}
            onFocus={() => onFocusRow(item.id)}
            tabIndex={-1}
            aria-label={isSection ? 'ラベルを削除' : '削除'}
            title={isSection ? 'ラベルを削除' : '⌘⌫'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}
