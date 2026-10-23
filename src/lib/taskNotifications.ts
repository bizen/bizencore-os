import { dateInTimeZone, isDateString, isTimeString, timeInTimeZone } from './taskDates';
import { flattenToday, type ItemMap } from './taskModel';

export type NotificationPreferences = { deadline: boolean; morning: boolean; completion: boolean; morningTime: string };
export const defaultNotificationPreferences: NotificationPreferences = { deadline: false, morning: false, completion: false, morningTime: '09:00' };
export type TaskNotice = { key: string; kind: 'deadline' | 'morning' | 'completion'; title: string; body: string; taskId?: string; expiresAt: number };
export const noticesEnabled = (prefs: NotificationPreferences) => prefs.deadline || prefs.morning || prefs.completion;

/** Convert a wall-clock deadline; reject non-existent times at a DST transition. */
export function deadlineInstant(day: string, time: string, timeZone: string): number | null {
  if (!isDateString(day) || !isTimeString(time)) return null;
  const wall = Date.parse(`${day}T${time}:00Z`);
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const local = Date.parse(`${dateInTimeZone(timeZone, instant)}T${timeInTimeZone(timeZone, instant)}:00Z`);
    instant += wall - local;
  }
  return dateInTimeZone(timeZone, instant) === day && timeInTimeZone(timeZone, instant) === time ? instant : null;
}

export function taskNotices(items: ItemMap, prefs: NotificationPreferences, timeZone: string, now: number, enabledAt: number): TaskNotice[] {
  const notices: TaskNotice[] = [];
  const today = dateInTimeZone(timeZone, now);
  for (const item of Object.values(items)) {
    if (item.type !== 'task' || item.deletedAt || item.filed || !item.text.trim()) continue;
    const title = item.text.replace(/\p{Cc}/gu, ' ').trim().slice(0, 160);
    if (prefs.deadline && !item.done && !item.locked && item.dueDate && item.dueTime) {
      const due = deadlineInstant(item.dueDate, item.dueTime, timeZone);
      if (due !== null && due > now && due - now <= 30 * 60_000) notices.push({
        key: `deadline:${item.id}:${due}`, kind: 'deadline', title: 'まもなく期限',
        body: `${title}（あと${Math.ceil((due - now) / 60_000)}分）`, taskId: item.id, expiresAt: due,
      });
    }
    const completedAt = item.stamps?.done;
    if (prefs.completion && item.done && item.completedBy === 'ai' && completedAt !== undefined && completedAt >= enabledAt && completedAt <= now && now - completedAt < 86_400_000) notices.push({
      key: `completion:${item.id}:${completedAt}`, kind: 'completion', title: 'エージェントがタスクを完了しました', body: title,
      taskId: item.id, expiresAt: completedAt + 86_400_000,
    });
  }
  if (prefs.morning && isTimeString(prefs.morningTime)) {
    const start = deadlineInstant(today, prefs.morningTime, timeZone);
    if (start !== null && now >= start && now - start < 30 * 60_000) {
      const tasks = flattenToday(items, today, timeZone).map(row => row.item).filter(item => !item.done && !item.locked && item.text.trim());
      const carried = tasks.filter(item => item.assignedDate && item.assignedDate < today).length;
      notices.push({ key: `morning:${today}`, kind: 'morning', title: '今日のToday',
        body: tasks.length ? `${tasks.length}件、持ち越し${carried}件。最初は「${tasks[0].text.replace(/\p{Cc}/gu, ' ').slice(0, 160)}」` : 'Todayのタスクはありません。',
        expiresAt: start + 30 * 60_000,
      });
    }
  }
  return notices;
}

export function notificationPath(taskId?: string): string {
  return taskId ? `/?task=${encodeURIComponent(taskId)}` : '/?view=today';
}

export function validatePushSubscription(value: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
  const url = new URL(value.endpoint);
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || value.endpoint.length > 4096 ||
    !(host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'web.push.apple.com' || host.endsWith('.notify.windows.com')) ||
    !/^[A-Za-z0-9_-]{87}=?$/.test(value.keys.p256dh) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(value.keys.auth)) throw Error('Invalid push subscription');
}
