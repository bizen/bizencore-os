import type { lifeWeek } from '../../lib/lifeWorldModel';

type Week = ReturnType<typeof lifeWeek>;

export function LifeStreak({ week, onChange, isDisabled }: {
  week: Week;
  onChange?: (date: string, done: boolean) => void;
  isDisabled?: (day: Week[number]) => boolean;
}) {
  return (
    <div className={`life-streak${onChange ? ' life-streak--editable' : ''}`} role="group" aria-label="今日までの7日間の達成状況">
      {week.map(day => {
        const status = day.done ? '達成' : day.scheduled ? '未達成' : '対象外';
        const label = `${day.date}${day.today ? '（今日）' : ''}: ${status}`;
        const dotClass = `life-streak-dot${day.done ? ' is-done' : !day.scheduled ? ' is-inactive' : ''}${day.today ? ' is-today' : ''}`;
        if (onChange) {
          const disabled = !day.scheduled || isDisabled?.(day) === true;
          const actionLabel = disabled ? label : `${label}（${day.done ? '未達成に戻す' : '達成にする'}）`;
          return <button key={day.date} type="button" className="life-streak-day" aria-label={actionLabel}
            aria-pressed={day.done} disabled={disabled} title={actionLabel} onClick={() => onChange(day.date, !day.done)}>
            <time dateTime={day.date}>{day.date.slice(5).replace('-', '/')}</time>
            <span className={dotClass} aria-hidden />
          </button>;
        }
        return <span key={day.date} role="img" aria-label={label} title={label}
          className={dotClass} />;
      })}
    </div>
  );
}
