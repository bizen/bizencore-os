import { ConvexError } from 'convex/values';
import type { QueryCtx } from './_generated/server';

export const deletionFor = (ctx: QueryCtx, userId: string) =>
    ctx.db.query('accountDeletions').withIndex('by_user', q => q.eq('userId', userId)).unique();

export async function accountActive(ctx: QueryCtx, userId: string): Promise<boolean> {
    return !(await deletionFor(ctx, userId));
}

export async function requireActiveAccount(ctx: QueryCtx, userId: string): Promise<void> {
    if (!(await accountActive(ctx, userId))) throw new ConvexError('このアカウントは削除中、または削除済みです。');
}
