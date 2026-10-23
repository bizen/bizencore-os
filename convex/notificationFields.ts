import { v } from 'convex/values';
export const notificationPreferences = v.object({ deadline: v.boolean(), morning: v.boolean(), completion: v.boolean(), morningTime: v.string() });
export const pushSubscription = v.object({ endpoint: v.string(), keys: v.object({ p256dh: v.string(), auth: v.string() }) });
export const noticeFields = { key: v.string(), kind: v.union(v.literal('deadline'), v.literal('morning'), v.literal('completion')), title: v.string(), body: v.string(), taskId: v.optional(v.string()), expiresAt: v.number() };
