import { useEffect } from 'react';
import { ArrowDown, ArrowUp, Check, LockKeyhole, Trash2, Undo2 } from 'lucide-react';
import { LIFE_REPEAT_NAMES, lifeEntryDone, lifeEntriesForDate, lifeWeek, type LifeRepeat } from '../../lib/lifeWorldModel';
import { lifeWorldStore, useLifeWorldState } from '../../lib/lifeWorldStore';
import { useAutoGrow } from '../../lib/useAutoGrow';
import { InspectorDialog } from './InspectorDialog';
import { LifeStreak } from './LifeStreak';

export interface LifeInspection {
  id: string;
  date: string;
  accountId: string | null;
  initialFocus: 'title' | 'note';
  restoreFocus: () => void;
  includeAll?: boolean;
}

export function LifeWorldInspector({ selection, todayDate, onClose }: {
  selection: LifeInspection; todayDate: string; onClose: () => void;
}) {
  const { data, accountId, canUndo } = useLifeWorldState();
  const entry = data.entries[selection.id];
  const available = !!entry && !entry.deletedAt && accountId === selection.accountId;
  const titleRef = useAutoGrow(entry?.text ?? '');
  const noteRef = useAutoGrow(entry?.note ?? '');
  const rows = lifeEntriesForDate(data, selection.date, selection.includeAll);
  const index = rows.findIndex(row => row.id === selection.id);
  const done = available && lifeEntryDone(data, entry, selection.date);

  useEffect(() => {
    if (!available) { onClose(); return; }
    const input = selection.initialFocus === 'note' ? noteRef.current : titleRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [available, selection.id, selection.initialFocus, titleRef, noteRef, onClose]);

  if (!available) return null;
  return (
    <InspectorDialog label="生活タスクの詳細" onClose={onClose}>
      <div className="inspector-identity">
        <textarea ref={titleRef} rows={1} className="inspector-title" aria-label="生活タスクのタイトル"
          placeholder="今日やりたいこと" spellCheck={false} value={entry.text}
          onChange={event => lifeWorldStore.setText(entry.id, event.target.value)} />
        <dl className="inspector-attribution"><div><dt>場所</dt><dd>生活世界</dd></div></dl>
      </div>
      <div className="inspector-prop">
        <span className="inspector-label">タスクロック</span>
        <button type="button" role="switch" className="task-lock-toggle" aria-label="タスクロック"
          aria-checked={!!entry.locked} disabled={done && !entry.locked}
          title={done && !entry.locked ? '未完了に戻してからロックできます' : entry.locked ? 'ロックを解除する' : 'タスクをロックする'}
          onClick={() => lifeWorldStore.setLocked(entry.id, !entry.locked, selection.date)}>
          <LockKeyhole size={14} aria-hidden /><span className="task-lock-track" aria-hidden><span /></span>
        </button>
      </div>
      <section className="inspector-section">
        <h3 className="inspector-label">メモ</h3>
        <textarea ref={noteRef} rows={2} className="inspector-note" aria-label="生活タスクのメモ"
          placeholder="補足や、覚えておきたいこと" spellCheck={false} value={entry.note}
          onChange={event => lifeWorldStore.setNote(entry.id, event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); titleRef.current?.focus(); }
          }} />
      </section>
      <section className="inspector-section inspector-props">
        <div className="inspector-prop">
          <span className="inspector-label">{entry.repeat === 'once' ? '追加日' : '対象日'}</span><time dateTime={entry.repeat === 'once' ? entry.startDate : selection.date} className="life-inspector-date">{(entry.repeat === 'once' ? entry.startDate : selection.date).replaceAll('-', '/')}</time>
        </div>
        <div className="inspector-prop">
          <label className="inspector-label" htmlFor={`life-repeat-${entry.id}`}>繰り返し</label>
          <select id={`life-repeat-${entry.id}`} className="inspector-input life-inspector-repeat" aria-label="繰り返し"
            value={entry.repeat} onChange={event => lifeWorldStore.setRepeat(entry.id, event.target.value as LifeRepeat)}>
            {Object.entries(LIFE_REPEAT_NAMES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </div>
        <div className="inspector-prop">
          <span className="inspector-label">達成</span>
          <button type="button" className={`life-inspector-complete${done ? ' is-done' : ''}`} aria-pressed={done}
            aria-label={`${selection.date}の生活タスクを${done ? '未完了に戻す' : '完了にする'}`}
            disabled={index < 0 || entry.locked} onClick={() => lifeWorldStore.toggle(entry.id, selection.date, selection.includeAll)}>
            {entry.locked ? <LockKeyhole size={14} aria-hidden /> : <Check size={14} aria-hidden />}{entry.locked ? 'ロック中' : done ? '達成済み' : '未達成'}
          </button>
        </div>
      </section>
      {entry.repeat !== 'once' ? (
        <section className="inspector-section life-inspector-week">
          <h3 className="inspector-label">今日までの7日間</h3>
          <LifeStreak week={lifeWeek(data, entry, todayDate)} />
        </section>
      ) : null}
      <section className="inspector-section">
        <h3 className="inspector-label">並べ替え</h3>
        <div className="life-entry-actions">
          <button type="button" className="icon-btn" title="上へ移動" aria-label="生活タスクを上へ移動"
            disabled={index <= 0} onClick={() => lifeWorldStore.move(entry.id, selection.date, -1, selection.includeAll)}><ArrowUp size={16} aria-hidden /></button>
          <button type="button" className="icon-btn" title="下へ移動" aria-label="生活タスクを下へ移動"
            disabled={index < 0 || index === rows.length - 1} onClick={() => lifeWorldStore.move(entry.id, selection.date, 1, selection.includeAll)}><ArrowDown size={16} aria-hidden /></button>
          <button type="button" className="icon-btn" title="元に戻す" aria-label="生活世界の操作を元に戻す"
            disabled={!canUndo} onClick={lifeWorldStore.undo}><Undo2 size={16} aria-hidden /></button>
        </div>
      </section>
      <div className="inspector-foot">
        <button type="button" className="ghost-btn inspector-remove" aria-label="生活タスクを削除"
          onClick={() => lifeWorldStore.remove(entry.id)}><Trash2 size={14} aria-hidden />削除</button>
      </div>
    </InspectorDialog>
  );
}
