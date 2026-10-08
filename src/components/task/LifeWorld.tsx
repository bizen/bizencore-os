import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Cloud, CloudCheck, CloudOff, CloudUpload, EyeOff, LockKeyhole, PanelRight, Plus, RefreshCw, Repeat2, Undo2 } from 'lucide-react';
import { LIFE_REPEAT_NAMES, LIFE_SECTION_ID, lifeEntryDone, lifeEntriesForDate, lifeWeek, shiftLifeDate, type LifeEntry } from '../../lib/lifeWorldModel';
import { lifeWorldStore, useLifeWorldState } from '../../lib/lifeWorldStore';
import { useAutoGrow } from '../../lib/useAutoGrow';
import { LifeStreak } from './LifeStreak';
import type { LifeInspection } from './LifeWorldInspector';

function LifeRow({ entry, done, date, week, open, onOpen, register, onKeyDown, includeAll }: {
  entry: LifeEntry; done: boolean; date: string; open: boolean;
  week: ReturnType<typeof lifeWeek>;
  onOpen: () => void;
  register: (id: string, el: HTMLTextAreaElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => void;
  includeAll: boolean;
}) {
  const titleRef = useAutoGrow(entry.text);
  return (
    <li className={`row row--task row--root life-row${open ? ' is-active' : ''}${done ? ' is-done' : ''}${entry.locked ? ' row--locked' : ''}`} data-life-id={entry.id}>
      <div className="row-main">
        <div className="row-mark">
          {entry.locked ? <span className="row-lock-mark" role="img" aria-label="ロック中・完了不可" title="ロック中・詳細から解除できます">
            <LockKeyhole size={14} aria-hidden />
          </span> : <button type="button" className={`check${done ? ' is-checked' : ''}`}
            aria-pressed={done} aria-label={`${entry.text.trim() || '生活タスク'}を${done ? '未完了に戻す' : '完了にする'}`}
            title="⌘Enter"
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
          {entry.note ? <p className="row-note">{entry.note}</p> : null}
        </div>
        <div className="row-meta">
          <button type="button" className="meta-inspect" aria-label="生活タスクの詳細"
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
  const emptyAddButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const needle = query.trim().toLowerCase();
  const rows = lifeEntriesForDate(data, date, !!allRootIds).filter(entry => !needle || `${entry.text}\n${entry.note}`.toLowerCase().includes(needle));

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = titles.current.get(id);
    if (el) { el.focus(); pendingFocus.current = null; }
  });

  const focus = (id: string | undefined) => {
    if (!id) return;
    const el = titles.current.get(id);
    if (el) el.focus();
    else pendingFocus.current = id;
  };
  const add = (afterId?: string) => focus(lifeWorldStore.add(date, afterId, !!allRootIds));
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
    if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyI') {
      event.preventDefault(); inspect(entry.id);
    } else if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
      event.preventDefault(); inspect(entry.id, 'note');
    } else if (event.key === 'Enter' && mod) {
      event.preventDefault(); lifeWorldStore.toggle(entry.id, date, !!allRootIds);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault(); add(entry.id);
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); lifeWorldStore.move(entry.id, date, event.key === 'ArrowUp' ? -1 : 1, !!allRootIds);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.currentTarget.blur();
    } else if (!mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const atBoundary = event.key === 'ArrowUp' ? event.currentTarget.selectionStart === 0
        : event.currentTarget.selectionEnd === event.currentTarget.value.length;
      if (!atBoundary) return;
      const target = rows[rows.findIndex(row => row.id === entry.id) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) { event.preventDefault(); focus(target.id); }
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
        {rows.map(entry => <LifeRow key={`${date}:${entry.id}`} entry={entry} date={date} week={lifeWeek(data, entry, todayDate)}
          includeAll={!!allRootIds}
          done={lifeEntryDone(data, entry, date)} open={inspectedId === entry.id}
          onOpen={() => inspect(entry.id)}
          register={(id, el) => { if (el) titles.current.set(id, el); else titles.current.delete(id); }}
          onKeyDown={onKeyDown} />)}
      </ul>
      {rows.length === 0 ? <button ref={emptyAddButton} type="button" className="life-add-empty" onClick={() => add()}><Plus size={14} aria-hidden />今日やりたいこと</button> : null}
      {saveFailed ? <p className="life-save-error" role="alert">端末に保存できませんでした。画面を閉じる前に保存領域を確認してください。</p> : null}
    </section>
  );
}
