import { LockKeyhole, Minus, PanelRight, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { LABEL_COLORS, type Item, type LabelColor } from '../../lib/taskModel';
import { liveAttachments } from '../../lib/attachments';
import { handleMetaKeyDown } from '../../lib/metaCursor';
import { QUEST_IMG, QUEST_LABEL } from '../../lib/quests';
import { DeadlineField } from './DeadlineField';
import { LabelColorPicker } from './LabelColorPicker';

function fitTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitTextarea(el);
  }, [value]);
  return ref;
}

/**
 * チェックマークは線を描き込みたいので、アイコンフォントではなく path を直接持つ。
 * fill / mark / ring の3層で、押し込み・描き込み・広がる輪をそれぞれ担当する。
 */
function CheckBox({
  done,
  completedByAi,
  bursting,
  todayNumber,
  onToggle,
  blocked,
}: {
  done: boolean;
  completedByAi: boolean;
  bursting: boolean;
  todayNumber?: number;
  onToggle: () => void;
  blocked: boolean;
}) {
  return (
    <button
      type="button"
      className={`check${done ? ' is-checked' : ''}${completedByAi ? ' is-ai-checked' : ''}${bursting ? ' is-bursting' : ''}`}
      onClick={onToggle}
      tabIndex={-1}
      aria-pressed={done}
      disabled={!done && blocked}
      aria-label={done ? (completedByAi ? 'AIが完了・未完了に戻す' : '未完了に戻す') : '完了にする'}
      title={!done && blocked ? 'ロック中の子タスクがあるため完了できません' : '⌘Enter'}
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
  todayTime: string;
  todayNumber?: number;
  isActive: boolean;
  /** 完了の演出中だけ入る。値は点灯をずらす順番 */
  burstIndex?: number;
  noteOpen: boolean;
  deadlineOpen: boolean;
  colorOpen: boolean;
  isFocusedLabel: boolean;
  completionBlocked?: boolean;
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
  onSetDeadline: (id: string, dueDate: string | undefined, dueTime: string | undefined) => void;
  onDeadlineOpenChange: (id: string, open: boolean) => void;
  onColorOpenChange: (id: string, open: boolean) => void;
  onRemove: (id: string) => void;
  onTitleBlur: (id: string) => void;
  onSetLabelColor: (id: string, color: LabelColor | undefined) => void;
  onToggleLabelFocus: (id: string) => void;
  /** 詳細パネルを開く（タスクだけ） */
  onInspect: (id: string) => void;
}

export function TaskRow(props: TaskRowProps) {
  const {
    item,
    depth,
    context,
    todayDate,
    todayTime,
    todayNumber,
    isActive,
    burstIndex,
    noteOpen,
    deadlineOpen,
    colorOpen,
    isFocusedLabel,
    completionBlocked = false,
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
    onSetDeadline,
    onDeadlineOpenChange,
    onColorOpenChange,
    onRemove,
    onTitleBlur,
    onSetLabelColor,
    onToggleLabelFocus,
    onInspect,
  } = props;

  const titleRef = useAutoGrow(item.text);
  const noteRef = useAutoGrow(item.note ?? '');
  const isSection = item.type === 'section';
  const isToday = item.assignedDate === todayDate;
  const isOverdue = !item.done && !!item.dueDate && (item.dueDate < todayDate || (item.dueDate === todayDate && !!item.dueTime && item.dueTime < todayTime));
  const contextCount = liveAttachments(item.attachments).length;

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
      id={isSection && depth === 0 ? `label-${item.id}` : undefined}
      className={[
        'row',
        isSection ? 'row--section' : 'row--task',
        item.locked ? 'row--locked' : '',
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
          ) : item.locked ? (
            <span className="row-lock-mark" role="img" aria-label="ロック中・完了不可" title="ロック中・詳細から解除できます">
              <LockKeyhole size={14} aria-hidden />
            </span>
          ) : (
            <CheckBox
              done={item.done}
              completedByAi={item.done && item.completedBy === 'ai'}
              bursting={burstIndex !== undefined}
              todayNumber={todayNumber}
              onToggle={() => onToggleDone(item.id)}
              blocked={completionBlocked}
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
          {!isSection && item.completionCriteria ? (
            <button type="button" className="row-details" onClick={() => onInspect(item.id)} tabIndex={-1} aria-label="完了条件を編集">
              <span className="row-criteria">完了条件 {item.completionCriteria}</span>
            </button>
          ) : null}
          {noteOpen || item.note ? (
            <textarea
              ref={attachNote}
              rows={1}
              className="row-note"
              value={item.note ?? ''}
              placeholder="メモ"
              spellCheck={false}
              onChange={(e) => onNoteChange(item.id, e.target.value)}
              onFocus={(e) => {
                fitTextarea(e.currentTarget);
                onFocusRow(item.id);
              }}
              onBlur={(e) => { e.currentTarget.scrollTop = 0; }}
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

          {isSection ? (
            <button
              type="button"
              data-meta="focus"
              className={`meta-focus${isFocusedLabel ? ' is-on' : ''}`}
              onClick={() => onToggleLabelFocus(item.id)}
              onKeyDown={handleMetaKeyDown}
              onFocus={() => onFocusRow(item.id)}
              tabIndex={-1}
              aria-pressed={isFocusedLabel}
              aria-label={isFocusedLabel ? 'フォーカスから外す' : 'フォーカスに追加'}
              title={isFocusedLabel ? 'フォーカスから外す' : 'フォーカスに追加'}
            >
              {isFocusedLabel ? <Minus size={15} aria-hidden /> : <Plus size={15} aria-hidden />}
            </button>
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

              <DeadlineField
                dueDate={item.dueDate}
                dueTime={item.dueTime}
                isOverdue={isOverdue}
                isOpen={deadlineOpen}
                onOpenChange={(open) => onDeadlineOpenChange(item.id, open)}
                onSave={(dueDate, dueTime) => onSetDeadline(item.id, dueDate, dueTime)}
                dataMeta="deadline"
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

          {isSection ? null : (
            <button
              type="button"
              data-meta="inspect"
              className={`meta-inspect${contextCount > 0 ? ' has-context' : ''}`}
              onClick={() => onInspect(item.id)}
              onKeyDown={handleMetaKeyDown}
              onFocus={() => onFocusRow(item.id)}
              tabIndex={-1}
              aria-label={contextCount > 0 ? `詳細を開く（コンテキスト ${contextCount} 件）` : '詳細を開く'}
              title={contextCount > 0 ? `コンテキスト ${contextCount} 件・詳細（⌘I）` : '詳細（⌘I）'}
            >
              {contextCount > 0 ? (
                <>
                  <Paperclip size={12} aria-hidden />
                  <span className="meta-inspect-count">{contextCount}</span>
                </>
              ) : (
                <PanelRight size={14} />
              )}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
