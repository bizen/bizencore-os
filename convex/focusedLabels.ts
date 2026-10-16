import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { accountActive, requireActiveAccount } from './accountAccess';
import { changeFocusedLabel, MAX_FOCUSED_LABELS, normalizeFocusedLabels } from '../src/lib/focusedLabels';

export const get = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== accountId || !(await accountActive(ctx, accountId))) return null;
    const row = await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', accountId)).unique();
    return { accountId, labelIds: row?.focusedLabelIds ?? null };
  },
});

export const initialize = mutation({
  args: { accountId: v.string(), labelIds: v.array(v.string()) },
  handler: async (ctx, { accountId, labelIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== accountId) throw new Error('Unauthorized');
    await requireActiveAccount(ctx, accountId);
    if (labelIds.length > MAX_FOCUSED_LABELS || labelIds.some(id => !id || id.length > 256)) throw new Error('Invalid focused labels');
    const row = await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', accountId)).unique();
    if (row?.focusedLabelIds !== undefined) return;
    const focusedLabelIds = normalizeFocusedLabels(labelIds);
    if (row) await ctx.db.patch(row._id, { focusedLabelIds });
    else await ctx.db.insert('userPreferences', { userId: accountId, focusedLabelIds, timeZone: 'UTC', automatic: true, updatedAt: Date.now() });
  },
});

export const set = mutation({
  args: { accountId: v.string(), labelId: v.string(), focused: v.boolean() },
  handler: async (ctx, { accountId, labelId, focused }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== accountId) throw new Error('Unauthorized');
    await requireActiveAccount(ctx, accountId);
    if (!labelId || labelId.length > 256) throw new Error('Invalid focused label');
    const row = await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', accountId)).unique();
    const focusedLabelIds = changeFocusedLabel(row?.focusedLabelIds ?? [], labelId, focused);
    if (focusedLabelIds.length > MAX_FOCUSED_LABELS) throw new Error('Too many focused labels');
    if (row) await ctx.db.patch(row._id, { focusedLabelIds });
    else await ctx.db.insert('userPreferences', { userId: accountId, focusedLabelIds, timeZone: 'UTC', automatic: true, updatedAt: Date.now() });
  },
});
