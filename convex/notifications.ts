import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { accountActive, requireActiveAccount } from './accountAccess';
import { loadItems } from './mcpTasks';
import { isLabelColor } from '../src/lib/taskModel';
import { isTimeString } from '../src/lib/taskDates';
import { defaultNotificationPreferences, noticesEnabled, taskNotices, validatePushSubscription } from '../src/lib/taskNotifications';
import { notificationPreferences, pushSubscription } from './notificationFields';

async function user(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw Error('サインインしてください。');
  await requireActiveAccount(ctx, identity.subject);
  return identity.subject;
}
async function deviceFor(ctx: QueryCtx, userId: string, deviceId: string) {
  return ctx.db.query('notificationDevices').withIndex('by_user_device', q => q.eq('userId', userId).eq('deviceId', deviceId)).unique();
}
async function noticesFor(ctx: QueryCtx, device: NonNullable<Awaited<ReturnType<typeof deviceFor>>>, now: number) {
  const prefs = await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', device.userId)).unique();
  if (!prefs || !noticesEnabled(device.preferences)) return [];
  const items = await loadItems(ctx, device.userId);
  const map = Object.fromEntries(items.map(item => [item.id, { ...item, color: isLabelColor(item.color) ? item.color : undefined }]));
  return taskNotices(map, device.preferences, prefs.timeZone, now, device.enabledAt);
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
  const rows = await ctx.db.query('notificationDeliveries').withIndex('by_device_status', q => q.eq('device', device._id).eq('status', 'pending').gt('expiresAt', Date.now())).take(50);
  const valid = new Map((await noticesFor(ctx, device, Date.now())).map(notice => [notice.key, notice]));
  return rows.filter(row => row.expiresAt > Date.now() && valid.has(row.key)).map(row => {
    const { title, body, taskId } = valid.get(row.key)!;
    return { id: row._id, title, body, taskId };
  });
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
  for (const device of devices) {
    await ctx.db.patch(device._id, { nextCheckAt: now + 60_000 });
    if (!(await accountActive(ctx, device.userId))) { await ctx.db.patch(device._id, { nextCheckAt: undefined }); continue; }
    const candidates = await noticesFor(ctx, device, now);
    let queued = 0;
    for (const notice of candidates) {
      if (await ctx.db.query('notificationDeliveries').withIndex('by_device_key', q => q.eq('device', device._id).eq('key', notice.key)).unique()) continue;
      const id = await ctx.db.insert('notificationDeliveries', { ...notice, userId: device.userId, device: device._id, status: 'pending', attempts: 0 });
      if (device.platform === 'web') await ctx.scheduler.runAfter(0, internal.pushNotifications.deliver, { id });
      if (++queued === 10) break;
    }
  }
  for (const row of await ctx.db.query('notificationDeliveries').withIndex('by_expiry', q => q.lt('expiresAt', now - 86_400_000)).take(100)) await ctx.db.delete(row._id);
} });

export const delivery = internalQuery({ args: { id: v.id('notificationDeliveries') }, handler: async (ctx, { id }) => {
  const row = await ctx.db.get(id);
  if (!row || row.status !== 'pending' || row.expiresAt <= Date.now() || !(await accountActive(ctx, row.userId))) return null;
  const device = await ctx.db.get(row.device);
  if (!device || device.platform !== 'web' || !device.subscription || !noticesEnabled(device.preferences)) return null;
  const current = (await noticesFor(ctx, device, Date.now())).find(notice => notice.key === row.key);
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
