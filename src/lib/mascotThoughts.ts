import { dateInTimeZone, localDateString } from './taskDates';
import { deadlineInstant } from './taskNotifications';
import { flattenToday, isLive, todayCarryDays, type ItemMap } from './taskModel';

export type MascotThought = { key: string; kind: string; taskId?: string; title?: string; ending: string };

const lines = {
  curious: ['、いつやるのかな……', '、ちょっと気になる……', 'が終わったら、すっきりしそう……'],
  today: ['から始めるのかな……', '、今日できるかな……', '、今日の一歩だね……'],
  carry: ['、ずっと気になってる……', '、今日は進むかな……', '、少しずつでもいいよね……'],
  deadline: ['、そろそろ期限だね……', '、もうすぐ期限かぁ……', '、期限が近づいてるね……'],
  joy: ['、終わったんだね……！', '、ひとつ片づいたね……', '、できたね……！'],
  rest: ['ちょっと伸びしようかな……', 'ひと息つこうかな……', 'ここで、のんびり待ってるね……'],
};

export function mascotThoughts(items: ItemMap, now: number, since: number, timeZone: string | null): MascotThought[] {
  const today = timeZone ? dateInTimeZone(timeZone, now) : localDateString(now);
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDate = tomorrow.toISOString().slice(0, 10);
  const tasks = Object.values(items).filter(item => isLive(item) && item.type === 'task' && !item.filed && !item.locked && item.text.trim());
  const first = flattenToday(items, today, timeZone).find(row => tasks.includes(row.item) && !row.item.done)?.item;
  const thoughts: MascotThought[] = [];
  const add = (kind: keyof typeof lines, task?: typeof first, stamp = '') => {
    lines[kind].forEach((ending, index) => thoughts.push({ key: `${kind}:${task?.id ?? index}:${stamp}`, kind, taskId: task?.id,
      title: task?.text.replace(/\p{Cc}/gu, ' ').trim(), ending }));
  };
  for (const item of tasks) {
    if (item.done) {
      const completedAt = item.stamps?.done;
      if (completedAt !== undefined && completedAt >= since && completedAt <= now && now - completedAt < 300_000) add('joy', item, String(completedAt));
      continue;
    }
    add('curious', item);
    if (item.id === first?.id) add('today', item);
    if (todayCarryDays(item, today) > 0) add('carry', item);
    if (item.dueDate && item.dueDate >= today && item.dueDate <= tomorrowDate) {
      const due = item.dueTime ? deadlineInstant(item.dueDate, item.dueTime, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : null;
      if (!item.dueTime || (due !== null && due > now)) add('deadline', item);
    }
  }
  add('rest');
  return thoughts;
}

export function pickMascotThought(thoughts: MascotThought[], recent: MascotThought[], random = Math.random): MascotThought | undefined {
  const last = recent.at(-1);
  const gentle = thoughts.filter(thought => thought.key !== last?.key &&
    !(last && ['carry', 'deadline'].includes(last.kind) && ['carry', 'deadline'].includes(thought.kind)));
  const fresh = gentle.filter(thought => !recent.some(previous => previous.key === thought.key));
  const available = fresh.length ? fresh : gentle;
  const kinds = [...new Set(available.map(thought => thought.kind))];
  const kind = kinds[Math.floor(random() * kinds.length)];
  const choices = available.filter(thought => thought.kind === kind);
  return choices[Math.floor(random() * choices.length)];
}
