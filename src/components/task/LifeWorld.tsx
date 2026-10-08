import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Cloud, CloudCheck, CloudOff, CloudUpload, EyeOff, LockKeyhole, PanelRight, Plus, RefreshCw, Repeat2, Trash2, Undo2 } from 'lucide-react';
import { LIFE_REPEAT_NAMES, LIFE_SECTION_ID, lifeCompletionBlocked, lifeEntryDone, lifeSubtreeEntries, lifeTreeRows, lifeWeek, shiftLifeDate, type LifeEntry } from '../../lib/lifeWorldModel';
import { lifeWorldStore, useLifeWorldState } from '../../lib/lifeWorldStore';
import { fitTextarea, useAutoGrow } from '../../lib/useAutoGrow';
import { focusFirstMeta, handleMetaKeyDown } from '../../lib/metaCursor';
import { LifeStreak } from './LifeStreak';
import type { LifeInspection } from './LifeWorldInspector';
import { TaskTreeGuides } from './TaskTreeGuides';

function LifeRow({ entry, done, date, week, open, onOpen, register, registerNote, onKeyDown, onNoteKeyDown, onRemove, includeAll, depth, hasChildren, blocked, noteOpen }: {
  entry: LifeEntry; done: boolean; date: string; open: boolean;
  week: ReturnType<typeof lifeWeek>;
  onOpen: () => void;
  register: (id: string, el: HTMLTextAreaElement | null) => void;
  registerNote: (id: string, el: HTMLTextAreaElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => void;
  onNoteKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => void;
  onRemove: () => void;
  includeAll: boolean;
  depth: number; hasChildren: boolean; blocked: boolean; noteOpen: boolean;
}) {
  const titleRef = useAutoGrow(entry.text);
  const noteRef = useAutoGrow(entry.note);
  return (
    <li className={`row row--task${depth === 0 ? ' row--root' : ''} life-row${open ? ' is-active' : ''}${done ? ' is-done' : ''}${entry.locked ? ' row--locked' : ''}`}
      style={{ '--depth': depth } as CSSProperties} data-life-id={entry.id}>
      <div className="row-main">
        <TaskTreeGuides depth={depth} hasChildren={hasChildren} />
        <div className="row-mark">
          {entry.locked ? <span className="row-lock-mark" role="img" aria-label="ロック中・完了不可" title="ロック中・詳細から解除できます">
            <LockKeyhole size={14} aria-hidden />
          </span> : <button type="button" className={`check${done ? ' is-checked' : ''}`}
            aria-pressed={done} aria-label={`${entry.text.trim() || '生活タスク'}を${done ? '未完了に戻す' : '完了にする'}`}
            disabled={!done && blocked} tabIndex={-1}
            title={!done && blocked ? 'ロック中の子タスクがあるため完了できません' : '⌘Enter'}
            onClick={() => lifeWorldStore.toggle(entry.id, date, includeAll)}>
            <span className="check-fill" aria-hidden />
            <svg className="check-mark" viewBox="0 0 16 16" aria-hidden><path d="M3.4 8.3 L6.5 11.4 L12.6 4.7" /></svg>
          </button>}
        </div>
        <div className="row-text">
          <textarea rows={1} className="row-title" value={entry.text} placeholder="今日やりたいこと"
            aria-label="生活タスク" spellCheck={false}
            ref={el => { titleRef.current = el; register(entry.id, el); }}
            onChange={event => lifeWorldStore.setText(entry.id, event.target.value)}
            onKeyDown={event => onKeyDown(event, entry)} />
          {entry.repeat !== 'once' ? (
            <div className="life-habit-meta">
              <span className="life-repeat-label"><Repeat2 size={12} aria-hidden />{LIFE_REPEAT_NAMES[entry.repeat]}</span>
              <LifeStreak week={week} />
            </div>
          ) : null}
          {noteOpen || entry.note ? <textarea rows={1} className="row-note" value={entry.note} placeholder="メモ"
            aria-label="生活タスクのメモ" spellCheck={false}
            ref={el => { noteRef.current = el; registerNote(entry.id, el); }}
            onChange={event => lifeWorldStore.setNote(entry.id, event.target.value)}
            onFocus={event => fitTextarea(event.currentTarget)} onBlur={event => { event.currentTarget.scrollTop = 0; }}
            onKeyDown={event => onNoteKeyDown(event, entry)} /> : null}
        </div>
        <div className="row-meta">
          <button type="button" className="meta-remove" data-meta="remove" aria-label="生活タスクを削除"
            title="⌘⌫" tabIndex={-1} onKeyDown={handleMetaKeyDown} onClick={onRemove}><Trash2 size={14} aria-hidden /></button>
          <button type="button" className="meta-inspect" data-meta="inspect" aria-label="生活タスクの詳細"
            tabIndex={-1} onKeyDown={handleMetaKeyDown}
            aria-expanded={open} title="詳細（⌘I）" onClick={onOpen}><PanelRight size={14} aria-hidden /></button>
        </div>
      </div>
    </li>
  );
}

export function LifeWorld({ todayDate, inspectedId, onInspect, onDateChange, allRootIds, query = '' }: {
  todayDate: string;
  inspectedId: string | null;
  onInspect: (selection: LifeInspection) => void;
  onDateChange: () => void;
  allRootIds?: string[];
  query?: string;
}) {
  const { data, canUndo, saveFailed, syncStatus } = useLifeWorldState();
  const syncLabel = { local: '端末に保存', loading: 'アカウント同期を準備中', pending: 'アカウント同期中', synced: 'アカウント同期済み', error: 'アカウント同期に失敗・再試行' }[syncStatus];
  const SyncIcon = syncStatus === 'synced' ? CloudCheck : syncStatus === 'error' ? CloudOff
    : syncStatus === 'local' ? Cloud : CloudUpload;
  // null follows the account's day, including a midnight/time-zone change.
  const [chosenDate, setChosenDate] = useState<string | null>(null);
  const date = !allRootIds && chosenDate && chosenDate < todayDate ? chosenDate : todayDate;
  const titles = useRef(new Map<string, HTMLTextAreaElement>());
  const notes = useRef(new Map<string, HTMLTextAreaElement>());
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const emptyAddButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ id: string; field: 'title' | 'note'; caret?: number } | null>(null);
  const rows = lifeTreeRows(data, date, !!allRootIds, query);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const el = (pending.field === 'note' ? notes : titles).current.get(pending.id);
    if (el) { el.focus(); if (pending.caret !== undefined) el.setSelectionRange(pending.caret, pending.caret); pendingFocus.current = null; }
  });

  const focus = (id: string | undefined, field: 'title' | 'note' = 'title', caret?: number) => {
    if (!id) return;
    const el = (field === 'note' ? notes : titles).current.get(id);
    if (el) { el.focus(); if (caret !== undefined) el.setSelectionRange(caret, caret); }
    else pendingFocus.current = { id, field, caret };
  };
  const add = (afterId?: string) => focus(lifeWorldStore.add(date, afterId, !!allRootIds));
  const remove = (id: string) => {
    const index = rows.findIndex(row => row.entry.id === id);
    const descendants = new Set(lifeSubtreeEntries(data, id).map(entry => entry.id));
    const previous = rows.slice(0, index).reverse().find(row => !descendants.has(row.entry.id));
    const next = rows.slice(index + 1).find(row => !descendants.has(row.entry.id));
    lifeWorldStore.remove(id);
    if (previous || next) focus((previous ?? next)!.entry.id);
    else requestAnimationFrame(() => emptyAddButton.current?.focus());
  };
  const changeDate = (next: string | null) => { setChosenDate(next); onDateChange(); };
  const inspect = (id: string, initialFocus: 'title' | 'note' = 'title') => onInspect({
    id, date, initialFocus, includeAll: !!allRootIds, accountId: lifeWorldStore.getSnapshot().accountId,
    restoreFocus: () => {
      const target = titles.current.get(id) ?? titles.current.values().next().value ?? emptyAddButton.current;
      target?.focus();
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    const caret = event.currentTarget.selectionStart;
    if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyI') {
      event.preventDefault(); inspect(entry.id);
    } else if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
      event.preventDefault(); setNoteOpenId(entry.id); focus(entry.id, 'note');
    } else if (event.key === 'Enter' && mod) {
      event.preventDefault(); lifeWorldStore.toggle(entry.id, date, !!allRootIds);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault(); add(entry.id);
    } else if (event.key === 'Tab' || (mod && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))) {
      event.preventDefault();
      if (event.shiftKey || event.key === 'ArrowLeft') lifeWorldStore.outdent(entry.id);
      else lifeWorldStore.indent(entry.id);
      focus(entry.id, 'title', caret);
    } else if ((mod || event.altKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); lifeWorldStore.move(entry.id, date, event.key === 'ArrowUp' ? -1 : 1, !!allRootIds);
      focus(entry.id, 'title', caret);
    } else if (event.key === 'Backspace' && (mod || (!entry.text && !entry.note && lifeSubtreeEntries(data, entry.id).length === 1))) {
      event.preventDefault(); remove(entry.id);
    } else if (event.key === 'ArrowRight' && !mod && !event.altKey && !event.shiftKey && caret === event.currentTarget.value.length &&
        event.currentTarget.selectionEnd === caret) {
      if (focusFirstMeta(event.currentTarget.closest('.row'))) event.preventDefault();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.currentTarget.blur();
    } else if (!mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const atBoundary = event.key === 'ArrowUp' ? event.currentTarget.selectionStart === 0
        : event.currentTarget.selectionEnd === event.currentTarget.value.length;
      if (!atBoundary) return;
      const target = rows[rows.findIndex(row => row.entry.id === entry.id) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) { event.preventDefault(); focus(target.entry.id); }
    }
  };
  const onNoteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) || (event.key === 'Backspace' && !entry.note)) {
      event.preventDefault(); if (!entry.note.trim()) setNoteOpenId(null); focus(entry.id);
    }
  };

  return (
    <section id={`label-${LIFE_SECTION_ID}`} className={`life-world${allRootIds ? ' life-world--all' : ''}`} aria-labelledby="life-world-heading" onKeyDown={event => {
      const mod = event.metaKey || event.ctrlKey;
      if (!event.nativeEvent.isComposing && mod && !event.shiftKey && event.code === 'KeyZ') {
        event.preventDefault(); lifeWorldStore.undo();
      }
      // The page's view/search commands work here; task-delete/complete commands do not leak out.
      if ((event.altKey && /^Digit[1-9]$/.test(event.code)) ||
          (mod && (event.code === 'KeyF' || event.code === 'Slash'))) return;
      event.stopPropagation();
    }}>
      <header className="life-world-heading">
        <h2 id="life-world-heading"><span className="life-world-mark" aria-hidden />生活世界
          {syncStatus === 'error' ? <button type="button" className="life-sync-retry" title={syncLabel}
            aria-label={syncLabel} onClick={lifeWorldStore.retrySync}><RefreshCw size={13} aria-hidden /></button>
            : <span className="life-sync-status" role="status" aria-label={syncLabel} title={syncLabel}><SyncIcon size={13} aria-hidden /></span>}
        </h2>
        {allRootIds ? (
          <button type="button" className="life-icon-btn" aria-label="Allで生活世界を非表示にする" title="Allで非表示"
            onClick={() => lifeWorldStore.setShowInAll(false)}><EyeOff size={15} aria-hidden /></button>
        ) : <div className="life-date-nav">
          <button type="button" className="life-icon-btn" aria-label="生活世界の前日を見る" title="前日"
            onClick={() => changeDate(shiftLifeDate(date, -1))}><ChevronLeft size={15} aria-hidden /></button>
          <time dateTime={date}>{new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))}</time>
          <button type="button" className="life-icon-btn" aria-label="生活世界の翌日を見る" title="翌日"
            disabled={date >= todayDate} onClick={() => changeDate(shiftLifeDate(date, 1))}><ChevronRight size={15} aria-hidden /></button>
          {date !== todayDate ? <button type="button" className="life-return-today" onClick={() => changeDate(null)}>今日</button> : null}
        </div>}
        <button type="button" className="life-icon-btn" aria-label="生活世界の操作を元に戻す" title="元に戻す"
          disabled={!canUndo} onClick={lifeWorldStore.undo}><Undo2 size={15} aria-hidden /></button>
      </header>
      <ul className="row-list life-list">
        {rows.map(({ entry, depth, hasChildren }) => <LifeRow key={`${date}:${entry.id}`} entry={entry} date={date} week={lifeWeek(data, entry, todayDate)}
          includeAll={!!allRootIds}
          depth={depth} hasChildren={hasChildren} blocked={lifeCompletionBlocked(data, entry.id)} noteOpen={noteOpenId === entry.id}
          done={lifeEntryDone(data, entry, date)} open={inspectedId === entry.id}
          onOpen={() => inspect(entry.id)}
          register={(id, el) => { if (el) titles.current.set(id, el); else titles.current.delete(id); }}
          registerNote={(id, el) => { if (el) notes.current.set(id, el); else notes.current.delete(id); }}
          onRemove={() => remove(entry.id)} onNoteKeyDown={onNoteKeyDown} onKeyDown={onKeyDown} />)}
      </ul>
      {rows.length === 0 ? <button ref={emptyAddButton} type="button" className="life-add-empty" onClick={() => add()}><Plus size={14} aria-hidden />今日やりたいこと</button> : null}
      {saveFailed ? <p className="life-save-error" role="alert">端末に保存できませんでした。画面を閉じる前に保存領域を確認してください。</p> : null}
    </section>
  );
}
