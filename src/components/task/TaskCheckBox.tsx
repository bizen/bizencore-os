export function TaskCheckBox({
  done, completedByAi, bursting = false, todayNumber, onToggle, blocked,
  tabIndex = -1, title = '⌘Enter',
}: {
  done: boolean;
  completedByAi: boolean;
  bursting?: boolean;
  todayNumber?: number;
  onToggle: () => void;
  blocked: boolean;
  tabIndex?: number;
  title?: string;
}) {
  return <button
    type="button"
    className={`check${done ? ' is-checked' : ''}${completedByAi ? ' is-ai-checked' : ''}${bursting ? ' is-bursting' : ''}`}
    onClick={onToggle}
    tabIndex={tabIndex}
    aria-pressed={done}
    disabled={!done && blocked}
    aria-label={done ? (completedByAi ? 'AIが完了・未完了に戻す' : '未完了に戻す') : '完了にする'}
    title={!done && blocked ? 'ロック中の子タスクがあるため完了できません' : title}
  >
    <span className="check-fill" aria-hidden />
    <svg className="check-mark" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.4 8.3 L6.5 11.4 L12.6 4.7" />
    </svg>
    {!done && todayNumber ? <span className="check-num">{todayNumber}</span> : null}
  </button>;
}
