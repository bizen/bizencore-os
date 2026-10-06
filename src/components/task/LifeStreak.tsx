import type { lifeWeek } from '../../lib/lifeWorldModel';

export function LifeStreak({ week }: { week: ReturnType<typeof lifeWeek> }) {
  return (
    <div className="life-streak" role="group" aria-label="今日までの7日間の達成状況">
      {week.map(day => {
        const status = day.done ? '達成' : day.scheduled ? '未達成' : '対象外';
        const label = `${day.date}${day.today ? '（今日）' : ''}: ${status}`;
        return <span key={day.date} role="img" aria-label={label} title={label}
          className={`life-streak-dot${day.done ? ' is-done' : !day.scheduled ? ' is-inactive' : ''}${day.today ? ' is-today' : ''}`} />;
      })}
    </div>
  );
}
