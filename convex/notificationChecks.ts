import type { MutationCtx } from './_generated/server';
import { isDateString, isTimeString } from '../src/lib/taskDates';
import { noticesEnabled } from '../src/lib/taskNotifications';

type SyncPayload = { deletedAt?: number; payload: string };

function notificationState(row?: SyncPayload | null) {
  if (!row || row.deletedAt) return '';
  try {
    const task = JSON.parse(row.payload);
    if (!task || task.type === 'section' || task.filed === true || task.locked === true ||
        typeof task.text !== 'string' || !task.text.trim()) return '';
    if (task.done === true) {
      return task.completedBy === 'ai' && Number.isFinite(task.stamps?.done) ? `done:${task.stamps.done}` : '';
    }
    if (typeof task.dueDate === 'string' && isDateString(task.dueDate) &&
        typeof task.dueTime === 'string' && isTimeString(task.dueTime)) return `${task.dueDate}T${task.dueTime}`;
  } catch {
    return '';
  }
  return '';
}

export function notificationStateChanged(before: SyncPayload | null, after: SyncPayload): boolean {
  return notificationState(before) !== notificationState(after);
}

export async function wakeNotificationChecks(ctx: MutationCtx, userId: string, includeMorning = false) {
  const now = Date.now();
  const devices = await ctx.db.query('notificationDevices').withIndex('by_user', q => q.eq('userId', userId)).take(20);
  for (const device of devices) {
    const { deadline, completion } = device.preferences;
    if ((includeMorning ? noticesEnabled(device.preferences) : deadline || completion) &&
        (device.nextCheckAt === undefined || device.nextCheckAt > now)) {
      await ctx.db.patch(device._id, { nextCheckAt: now });
    }
  }
}
