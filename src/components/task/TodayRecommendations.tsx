import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { todayRecommendations } from '../../lib/todayRecommendations';
import { taskStore } from '../../lib/taskStore';
import type { ItemMap } from '../../lib/taskModel';

export function TodayRecommendations({ items, todayDate, todayTime }: {
  items: ItemMap; todayDate: string; todayTime: string;
}) {
  const candidates = useMemo(() => todayRecommendations(items, todayDate, todayTime), [items, todayDate, todayTime]);
  const sectionRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const [hasAdded, setHasAdded] = useState(false);

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const buttons = sectionRef.current?.querySelectorAll<HTMLButtonElement>('button');
    const next = buttons?.[Math.min(index, buttons.length - 1)] ?? sectionRef.current?.querySelector<HTMLElement>('h2');
    next?.focus({ preventScroll: true });
  }, [candidates]);

  // Retain a focus destination after accepting the last recommendation.
  if (candidates.length === 0 && !hasAdded) return null;
  return (
    <section className="today-recommendations" ref={sectionRef} aria-labelledby="today-recommendations-heading">
      <h2 id="today-recommendations-heading" tabIndex={-1}>今日の候補</h2>
      {candidates.length > 0 ? (
        <ul>
          {candidates.map(({ item, context, reason, overdue }, index) => (
            <li key={item.id}>
              <div className="today-recommendation-text">
                <p className="today-recommendation-title">{item.text}</p>
                <div className="today-recommendation-meta">
                  <span className={overdue ? 'is-overdue' : undefined}>{reason} · {item.dueDate?.slice(5).replace('-', '/')}{item.dueTime ? ` ${item.dueTime}` : ''}</span>
                  {context ? <span>{context}</span> : null}
                </div>
              </div>
              <button type="button" className="today-recommendation-add"
                aria-label={`${item.text}をTodayに追加`} title="Todayに追加"
                onClick={event => {
                  const current = taskStore.getState().items[item.id];
                  if (!current || current.deletedAt || current.done || current.locked || current.assignedDate === todayDate) return;
                  if (document.activeElement === event.currentTarget) pendingFocus.current = index;
                  setHasAdded(true);
                  taskStore.toggleToday(item.id, todayDate);
                }}><Plus size={17} aria-hidden /></button>
            </li>
          ))}
        </ul>
      ) : <p className="today-recommendations-empty" role="status">候補をTodayに追加しました。</p>}
    </section>
  );
}
