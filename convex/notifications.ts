import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { accountActive, requireActiveAccount } from './accountAccess';
import { loadItem, loadItems } from './mcpTasks';
import { isLabelColor } from '../src/lib/taskModel';
import { isTimeString } from '../src/lib/taskDates';
import { defaultNotificationPreferences, noticesEnabled, planTaskNotices, validatePushSubscription } from '../src/lib/taskNotifications';
import { notificationPreferences, pushSubscription } from './notificationFields';
import { dispatchDuePatrol, officerInbox } from './grokBot';

async function user(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw Error('サインインしてください。');
  await requireActiveAccount(ctx, identity.subject);
  return identity.subject;
}
async function deviceFor(ctx: QueryCtx, userId: string, deviceId: string) {
  return ctx.db.query('notificationDevices').withIndex('by_user_device', q => q.eq('userId', userId).eq('deviceId', deviceId)).unique();
}
type Device = NonNullable<Awaited<ReturnType<typeof deviceFor>>>;
const settingsFor = (ctx: QueryCtx, userId: string) =>
  ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', userId)).unique();

async function noticesFor(ctx: QueryCtx, device: Device, timeZone: string, now: number, items: Awaited<ReturnType<typeof loadItems>>) {
  const map = Object.fromEntries(items.map(item => [item.id, { ...item, color: isLabelColor(item.color) ? item.color : undefined }]));
  const plan = planTaskNotices(map, device.preferences, timeZone, now, device.enabledAt);
  const morning = plan.notices.find(notice => notice.kind === 'morning');
  if (morning) {
    const inbox = await officerInbox(ctx, device.userId, false);
    if (inbox?.pending.length) Object.assign(morning, { inbox: true, title: '受信箱に対応待ちがあります', body: `${inbox.pending.length}件があなたの対応を待っています。` });
  }
  return plan;
}

async function currentNotice(ctx: QueryCtx, device: Device, timeZone: string, now: number,
  row: { key: string; kind: 'deadline' | 'morning' | 'completion'; taskId?: string }) {
  if (row.kind === 'morning') {
    if (!device.preferences.morning) return;
    const plan = await noticesFor(ctx, device, timeZone, now, await loadItems(ctx, device.userId));
    return plan.notices.find(notice => notice.key === row.key);
  }
  if (!row.taskId || !device.preferences[row.kind]) return;
  const item = await loadItem(ctx, device.userId, row.taskId);
  if (!item) return;
  const map = { [item.id]: { ...item, color: undefined } };
  const preferences = { ...device.preferences, morning: false };
  return planTaskNotices(map, preferences, timeZone, now, device.enabledAt).notices.find(notice => notice.key === row.key);
}

export const state = query({ args: { deviceId: v.string() }, handler: async (ctx, { deviceId }) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !(await accountActive(ctx, identity.subject))) return null;
  const device = await deviceFor(ctx, identity.subject, deviceId);
  return { preferences: device?.preferences ?? defaultNotificationPreferences, registered: !!device,
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY ?? null, webPushReady: !!(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY) };
} });

export const save = mutation({ args: { deviceId: v.string(), platform: v.union(v.literal('web'), v.literal('desktop')),
  preferences: notificationPreferences, subscription: v.optional(pushSubscription) }, handler: async (ctx, args) => {
  const userId = await user(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(args.deviceId) || !isTimeString(args.preferences.morningTime)) throw Error('通知設定が不正です。');
  const active = noticesEnabled(args.preferences);
  if (active && !(await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', userId)).unique())) throw Error('先に設定でタイムゾーンを保存してください。');
  if (args.platform === 'web' && active) {
    if (!args.subscription || !process.env.WEB_PUSH_PUBLIC_KEY || !process.env.WEB_PUSH_PRIVATE_KEY) throw Error('プッシュ通知の配信設定が必要です。');
    validatePushSubscription(args.subscription);
    const owned = await ctx.db.query('notificationDevices').withIndex('by_endpoint', q => q.eq('subscription.endpoint', args.subscription!.endpoint)).unique();
    if (owned && (owned.userId !== userId || owned.deviceId !== args.deviceId)) throw Error('このブラウザーの通知を一度解除してから設定してください。');
  }
  const previous = await deviceFor(ctx, userId, args.deviceId);
  const now = Date.now();
  const data = { userId, deviceId: args.deviceId, platform: args.platform, preferences: args.preferences,
    subscription: args.platform === 'web' && active ? args.subscription : undefined,
    enabledAt: previous && noticesEnabled(previous.preferences) && (!args.preferences.completion || previous.preferences.completion) ? previous.enabledAt : now,
    nextCheckAt: active ? now : undefined };
  if (previous) await ctx.db.patch(previous._id, data);
  else {
    if ((await ctx.db.query('notificationDevices').withIndex('by_user', q => q.eq('userId', userId)).take(20)).length >= 20) throw Error('通知端末の上限に達しました。');
    await ctx.db.insert('notificationDevices', data);
  }
} });

export const pending = query({ args: { deviceId: v.string() }, handler: async (ctx, { deviceId }) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !(await accountActive(ctx, identity.subject))) return [];
  const device = await deviceFor(ctx, identity.subject, deviceId);
  if (!device || device.platform !== 'desktop' || !noticesEnabled(device.preferences)) return [];
  const now = Date.now();
  const rows = await ctx.db.query('notificationDeliveries').withIndex('by_device_status', q => q.eq('device', device._id).eq('status', 'pending').gt('expiresAt', now)).take(50);
  if (rows.length === 0) return [];
  const settings = await settingsFor(ctx, device.userId);
  if (!settings) return [];
  const notices = await Promise.all(rows.map(async row => {
    const notice = await currentNotice(ctx, device, settings.timeZone, now, row);
    return notice ? { id: row._id, title: notice.title, body: notice.body, taskId: notice.taskId, inbox: notice.inbox } : null;
  }));
  return notices.filter(notice => notice !== null);
} });
export const acknowledge = mutation({ args: { id: v.id('notificationDeliveries') }, handler: async (ctx, { id }) => {
  const userId = await user(ctx), row = await ctx.db.get(id);
  if (!row || row.userId !== userId) throw Error('通知が見つかりません。');
  const device = await ctx.db.get(row.device);
  if (!device || device.platform !== 'desktop') throw Error('通知端末が一致しません。');
  await ctx.db.patch(id, { status: 'sent' });
} });

export const collect = internalMutation({ args: {}, handler: async ctx => {
  const now = Date.now();
  const devices = await ctx.db.query('notificationDevices').withIndex('by_next', q => q.gt('nextCheckAt', 0).lte('nextCheckAt', now)).take(25);
  const itemsByUser = new Map<string, Awaited<ReturnType<typeof loadItems>>>();
  for (const device of devices) {
    const settings = noticesEnabled(device.preferences) && await accountActive(ctx, device.userId) ? await settingsFor(ctx, device.userId) : null;
    if (!settings) { await ctx.db.patch(device._id, { nextCheckAt: undefined }); continue; }
    let items = itemsByUser.get(device.userId);
    if (!items) {
      items = await loadItems(ctx, device.userId);
      itemsByUser.set(device.userId, items);
    }
    const { notices, nextCheckAt } = await noticesFor(ctx, device, settings.timeZone, now, items);
    let queued = 0;
    for (const notice of notices) {
      if (await ctx.db.query('notificationDeliveries').withIndex('by_device_key', q => q.eq('device', device._id).eq('key', notice.key)).unique()) continue;
      const id = await ctx.db.insert('notificationDeliveries', { ...notice, userId: device.userId, device: device._id, status: 'pending', attempts: 0 });
      if (device.platform === 'web') await ctx.scheduler.runAfter(0, internal.pushNotifications.deliver, { id });
      if (++queued === 10) break;
    }
    await ctx.db.patch(device._id, { nextCheckAt: queued === 10 ? Math.min(now + 60_000, nextCheckAt ?? Infinity) : nextCheckAt });
  }
  for (const row of await ctx.db.query('notificationDeliveries').withIndex('by_expiry', q => q.lt('expiresAt', now - 86_400_000)).take(100)) await ctx.db.delete(row._id);
  await dispatchDuePatrol(ctx, now);
} });

export const delivery = internalQuery({ args: { id: v.id('notificationDeliveries') }, handler: async (ctx, { id }) => {
  const row = await ctx.db.get(id);
  if (!row || row.status !== 'pending' || row.expiresAt <= Date.now() || !(await accountActive(ctx, row.userId))) return null;
  const device = await ctx.db.get(row.device);
  if (!device || device.platform !== 'web' || !device.subscription || !noticesEnabled(device.preferences)) return null;
  const settings = await settingsFor(ctx, device.userId);
  const current = settings && await currentNotice(ctx, device, settings.timeZone, Date.now(), row);
  return current ? { ...row, ...current, subscription: device.subscription } : null;
} });
export const result = internalMutation({ args: { id: v.id('notificationDeliveries'), result: v.union(v.literal('sent'), v.literal('retry'), v.literal('expired'), v.literal('failed')), endpoint: v.optional(v.string()) }, handler: async (ctx, { id, result, endpoint }) => {
  const row = await ctx.db.get(id);
  if (!row || row.status !== 'pending') return;
  const attempts = row.attempts + 1;
  if (result === 'expired') {
    const device = await ctx.db.get(row.device);
    if (device && device.subscription?.endpoint === endpoint) await ctx.db.patch(device._id, { preferences: { ...device.preferences, deadline: false, morning: false, completion: false }, subscription: undefined, nextCheckAt: undefined });
  }
  if (result === 'retry' && attempts < 3 && row.expiresAt > Date.now() + attempts * 60_000) {
    await ctx.db.patch(id, { attempts });
    await ctx.scheduler.runAfter(attempts * 60_000, internal.pushNotifications.deliver, { id });
  } else await ctx.db.patch(id, { attempts, status: result === 'sent' ? 'sent' : 'failed' });
} });
