import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Cloud, CloudCheck, CloudOff, CloudUpload, Plus, RefreshCw, Repeat2, Trash2, Undo2 } from 'lucide-react';
import { LIFE_REPEAT_NAMES, lifeCheckKey, lifeEntriesForDate, lifeWeek, shiftLifeDate, type LifeEntry, type LifeRepeat } from '../../lib/lifeWorldModel';
import { lifeWorldStore, useLifeWorldState } from '../../lib/lifeWorldStore';
import { useAutoGrow } from '../../lib/useAutoGrow';

function LifeRow({ entry, done, date, week, open, first, last, onOpen, register, onKeyDown }: {
  entry: LifeEntry; done: boolean; date: string; open: boolean; first: boolean; last: boolean;
  week: ReturnType<typeof lifeWeek>;
  onOpen: () => void;
  register: (id: string, el: HTMLTextAreaElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => void;
}) {
  const titleRef = useAutoGrow(entry.text);
  const noteRef = useAutoGrow(entry.note);
  return (
    <li className={`row row--task life-row${done ? ' is-done' : ''}`} data-life-id={entry.id}>
      <div className="row-main">
        <div className="row-mark">
          <button type="button" className={`check${done ? ' is-checked' : ''}`}
            aria-pressed={done} aria-label={`${entry.text.trim() || '生活タスク'}を${done ? '未完了に戻す' : '完了にする'}`}
            onClick={() => lifeWorldStore.toggle(entry.id, date)}>
            <span className="check-fill" aria-hidden />
            {done ? <Check size={15} className="life-check-icon" aria-hidden /> : null}
          </button>
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
              <div className="life-streak" role="group" aria-label="今日までの7日間の達成状況">
                {week.map(day => {
                  const status = day.done ? '達成' : day.scheduled ? '未達成' : '対象外';
                  const label = `${day.date}${day.today ? '（今日）' : ''}: ${status}`;
                  return <span key={day.date} role="img" aria-label={label} title={label}
                    className={`life-streak-dot${day.done ? ' is-done' : !day.scheduled ? ' is-inactive' : ''}${day.today ? ' is-today' : ''}`} />;
                })}
              </div>
            </div>
          ) : null}
          {!open && entry.note ? <p className="row-note">{entry.note}</p> : null}
        </div>
        <button type="button" className="life-icon-btn" aria-label="生活タスクの詳細"
          aria-expanded={open} aria-controls={`life-details-${entry.id}`} title="メモ・繰り返し" onClick={onOpen}>
          <ChevronDown size={16} aria-hidden className={open ? 'is-open' : undefined} />
        </button>
      </div>
      {open ? (
        <div id={`life-details-${entry.id}`} className="life-details">
          <textarea ref={noteRef} rows={1} className="row-note" value={entry.note}
            aria-label="生活タスクのメモ" placeholder="メモ"
            onChange={event => lifeWorldStore.setNote(entry.id, event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                event.preventDefault(); onOpen(); titleRef.current?.focus();
              }
            }} />
          <div className="life-entry-tools">
            <label className="life-repeat-control"><Repeat2 size={14} aria-hidden />
              <select aria-label="繰り返し" value={entry.repeat}
                onChange={event => lifeWorldStore.setRepeat(entry.id, event.target.value as LifeRepeat)}>
                {Object.entries(LIFE_REPEAT_NAMES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
            <div className="life-entry-actions">
              <button type="button" className="life-icon-btn" title="上へ移動" aria-label="生活タスクを上へ移動"
                disabled={first} onClick={() => lifeWorldStore.move(entry.id, date, -1)}><ArrowUp size={14} aria-hidden /></button>
              <button type="button" className="life-icon-btn" title="下へ移動" aria-label="生活タスクを下へ移動"
                disabled={last} onClick={() => lifeWorldStore.move(entry.id, date, 1)}><ArrowDown size={14} aria-hidden /></button>
              <button type="button" className="life-icon-btn" title="削除（元に戻せます）" aria-label="生活タスクを削除"
                onClick={() => lifeWorldStore.remove(entry.id)}><Trash2 size={14} aria-hidden /></button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function LifeWorld({ todayDate }: { todayDate: string }) {
  const { data, canUndo, saveFailed, syncStatus } = useLifeWorldState();
  const syncLabel = { local: '端末に保存', loading: 'アカウント同期を準備中', pending: 'アカウント同期中', synced: 'アカウント同期済み', error: 'アカウント同期に失敗・再試行' }[syncStatus];
  const SyncIcon = syncStatus === 'synced' ? CloudCheck : syncStatus === 'error' ? CloudOff
    : syncStatus === 'local' ? Cloud : CloudUpload;
  // null follows the account's day, including a midnight/time-zone change.
  const [chosenDate, setChosenDate] = useState<string | null>(null);
  const date = chosenDate && chosenDate < todayDate ? chosenDate : todayDate;
  const [openId, setOpenId] = useState<string | null>(null);
  const titles = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef<string | null>(null);
  const rows = lifeEntriesForDate(data, date);

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
  const add = (afterId?: string) => focus(lifeWorldStore.add(date, afterId));
  const changeDate = (next: string | null) => { setChosenDate(next); setOpenId(null); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, entry: LifeEntry) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Enter' && mod) {
      event.preventDefault(); lifeWorldStore.toggle(entry.id, date);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault(); add(entry.id);
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); lifeWorldStore.move(entry.id, date, event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault(); setOpenId(null); event.currentTarget.blur();
    } else if (!mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const atBoundary = event.key === 'ArrowUp' ? event.currentTarget.selectionStart === 0
        : event.currentTarget.selectionEnd === event.currentTarget.value.length;
      if (!atBoundary) return;
      const target = rows[rows.findIndex(row => row.id === entry.id) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) { event.preventDefault(); focus(target.id); }
    }
  };

  return (
    <section className="life-world" aria-labelledby="life-world-heading" onKeyDown={event => {
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
        <div className="life-date-nav">
          <button type="button" className="life-icon-btn" aria-label="生活世界の前日を見る" title="前日"
            onClick={() => changeDate(shiftLifeDate(date, -1))}><ChevronLeft size={15} aria-hidden /></button>
          <time dateTime={date}>{new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))}</time>
          <button type="button" className="life-icon-btn" aria-label="生活世界の翌日を見る" title="翌日"
            disabled={date >= todayDate} onClick={() => changeDate(shiftLifeDate(date, 1))}><ChevronRight size={15} aria-hidden /></button>
          {date !== todayDate ? <button type="button" className="life-return-today" onClick={() => changeDate(null)}>今日</button> : null}
        </div>
        <button type="button" className="life-icon-btn" aria-label="生活世界の操作を元に戻す" title="元に戻す"
          disabled={!canUndo} onClick={lifeWorldStore.undo}><Undo2 size={15} aria-hidden /></button>
        <button type="button" className="life-icon-btn" aria-label="生活世界に追加" title="追加" onClick={() => add()}><Plus size={18} aria-hidden /></button>
      </header>
      <ul className="row-list life-list">
        {rows.map((entry, index) => <LifeRow key={`${date}:${entry.id}`} entry={entry} date={date} week={lifeWeek(data, entry, todayDate)}
          done={data.checks[lifeCheckKey(entry.id, date)]?.done === true} open={openId === entry.id}
          first={index === 0} last={index === rows.length - 1}
          onOpen={() => setOpenId(current => current === entry.id ? null : entry.id)}
          register={(id, el) => { if (el) titles.current.set(id, el); else titles.current.delete(id); }}
          onKeyDown={onKeyDown} />)}
      </ul>
      {rows.length === 0 ? <button type="button" className="life-add-empty" onClick={() => add()}><Plus size={14} aria-hidden />今日やりたいこと</button> : null}
      {saveFailed ? <p className="life-save-error" role="alert">端末に保存できませんでした。画面を閉じる前に保存領域を確認してください。</p> : null}
    </section>
  );
}
