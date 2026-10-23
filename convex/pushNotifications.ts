'use node';
import webpush from 'web-push';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { notificationPath, validatePushSubscription } from '../src/lib/taskNotifications';

export const deliver = internalAction({ args: { id: v.id('notificationDeliveries') }, handler: async (ctx, { id }) => {
  const notice = await ctx.runQuery(internal.notifications.delivery, { id });
  if (!notice) return;
  let result: 'sent' | 'retry' | 'expired' | 'failed' = 'sent';
  try {
    validatePushSubscription(notice.subscription);
    const publicKey = process.env.WEB_PUSH_PUBLIC_KEY, privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
    if (!publicKey || !privateKey) throw Error('Web Push is not configured');
    await webpush.sendNotification(notice.subscription, JSON.stringify({ title: notice.title, body: notice.body, tag: notice.key, path: notificationPath(notice.taskId) }), {
      vapidDetails: { subject: 'https://app.bizencore.com', publicKey, privateKey },
      TTL: Math.max(0, Math.floor((notice.expiresAt - Date.now()) / 1000)), timeout: 10_000,
    });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    result = status === 404 || status === 410 ? 'expired' : status === undefined || status === 429 || status >= 500 ? 'retry' : 'failed';
  }
  await ctx.runMutation(internal.notifications.result, { id, result, endpoint: notice.subscription.endpoint });
} });
