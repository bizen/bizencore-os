import { ConvexError, v } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { internal } from './_generated/api';
import { deletionFor } from './accountAccess';

function secretKey() {
    return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CLERK_SECRET_KEY;
}

async function clerkUser(userId: string, method: 'GET' | 'DELETE') {
    const secret = secretKey();
    if (!secret) throw new Error('Account deletion is not configured');
    return fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
        method, headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000),
    });
}

export const status = query({
    args: {},
    handler: async ctx => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return null;
        const job = await deletionFor(ctx, identity.subject);
        return { userId: identity.subject, phase: job?.phase ?? 'active', retrying: job?.retrying ?? false,
            available: Boolean(secretKey()) };
    },
});

export const request = action({
    args: { expectedAccountId: v.string(), confirmation: v.string() },
    handler: async (ctx, args): Promise<{ phase: 'data' | 'identity' | 'complete' }> => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || identity.subject !== args.expectedAccountId) throw new ConvexError('アカウントが変わりました。サインインを確認してください。');
        if (args.confirmation !== '削除') throw new ConvexError('確認欄に「削除」と入力してください。');
        const existing = await ctx.runQuery(internal.accountDeletion.job, { userId: identity.subject });
        if (existing) return { phase: existing.phase };
        // Validate the backend key against the authenticated account before any destructive write.
        try {
            const response = await clerkUser(identity.subject, 'GET');
            if (!response.ok) throw new Error('Identity verification failed');
            const user = await response.json() as { id?: string };
            if (user.id !== identity.subject) throw new Error('Identity mismatch');
        } catch {
            throw new ConvexError('削除を開始できませんでした。サーバーの認証設定または通信を確認してください。データは削除していません。');
        }
        return ctx.runMutation(internal.accountDeletion.begin, { userId: identity.subject });
    },
});

export const job = internalQuery({
    args: { userId: v.string() },
    handler: (ctx, { userId }) => deletionFor(ctx, userId),
});

export const begin = internalMutation({
    args: { userId: v.string() },
    handler: async (ctx, { userId }): Promise<{ phase: 'data' | 'identity' | 'complete' }> => {
        const existing = await deletionFor(ctx, userId);
        if (existing) return { phase: existing.phase };
        await ctx.db.insert('accountDeletions', { userId, phase: 'data', attempts: 0, updatedAt: Date.now(), retrying: false, nextAttemptAt: Date.now() });
        const own = await ctx.db.query('partnerAccounts').withIndex('by_user', q => q.eq('userId', userId)).unique();
        if (own?.partnerId) {
            const peer = await ctx.db.query('partnerAccounts').withIndex('by_user', q => q.eq('userId', own.partnerId!)).unique();
            if (peer?.partnerId === userId) await ctx.db.patch(peer._id, { partnerId: undefined, sharedLabelIds: [] });
        }
        if (own) await ctx.db.patch(own._id, { partnerId: undefined, sharedLabelIds: [] });
        await ctx.scheduler.runAfter(0, internal.accountDeletion.worker, { userId });
        await ctx.scheduler.runAfter(120000, internal.accountDeletion.watchdog, { userId });
        return { phase: 'data' };
    },
});

export const deleteBatch = internalMutation({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const deletion = await deletionFor(ctx, userId);
        if (!deletion || deletion.phase !== 'data') return;
        const files = await ctx.db.query('fileOwners').withIndex('by_user', q => q.eq('userId', userId)).take(25);
        for (const file of files) {
            if (await ctx.db.system.get(file.storageId)) await ctx.storage.delete(file.storageId);
            await ctx.db.delete(file._id);
        }
        let more = files.length > 0;
        if (!more) {
            // Bounded batches cover every account-owned table, including legacy data.
            const tables = ['syncItems', 'lifeEntries', 'lifeChecks', 'lifePreferences', 'countStocks',
                'mcpConnections', 'userPreferences', 'partnerAccounts', 'taskListEntries', 'tasks', 'goals'] as const;
            for (const table of tables) {
                const rows = await ctx.db.query(table).withIndex('by_user', q => q.eq('userId', userId)).take(table === 'syncItems' ? 8 : 25);
                for (const row of rows) await ctx.db.delete(row._id);
                if (rows.length) { more = true; break; }
            }
        }
        if (!more) {
            const requests = await ctx.db.query('mcpIdempotency').withIndex('by_user_createdAt', q => q.eq('userId', userId)).take(25);
            for (const row of requests) await ctx.db.delete(row._id);
            more = requests.length > 0;
        }
        if (!more) {
            const invites = await ctx.db.query('partnerInvites').withIndex('by_owner', q => q.eq('ownerId', userId)).take(25);
            for (const row of invites) await ctx.db.delete(row._id);
            more = invites.length > 0;
        }
        await ctx.db.patch(deletion._id, { phase: more ? 'data' : 'identity', retrying: false, attempts: 0, updatedAt: Date.now(), nextAttemptAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.accountDeletion.worker, { userId });
    },
});

export const finish = internalMutation({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const deletion = await deletionFor(ctx, userId);
        if (deletion?.phase === 'identity') await ctx.db.patch(deletion._id, { phase: 'complete', retrying: false, attempts: 0, updatedAt: Date.now() });
    },
});

export const retry = internalMutation({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const deletion = await deletionFor(ctx, userId);
        if (!deletion || deletion.phase === 'complete') return;
        const attempts = deletion.attempts + 1;
        const delay = Math.min(60000 * 2 ** Math.min(attempts - 1, 6), 3600000);
        await ctx.db.patch(deletion._id, { attempts, retrying: true, updatedAt: Date.now(), nextAttemptAt: Date.now() + delay });
        await ctx.scheduler.runAfter(delay, internal.accountDeletion.worker, { userId });
    },
});

export const worker = internalAction({
    args: { userId: v.string() },
    handler: async (ctx, { userId }): Promise<void> => {
        try {
            const deletion = await ctx.runQuery(internal.accountDeletion.job, { userId });
            if (!deletion || deletion.phase === 'complete') return;
            if (deletion.phase === 'data') {
                await ctx.runMutation(internal.accountDeletion.deleteBatch, { userId });
            } else {
                const response = await clerkUser(userId, 'DELETE');
                if (!response.ok && response.status !== 404) throw new Error('Identity deletion failed');
                await ctx.runMutation(internal.accountDeletion.finish, { userId });
            }
        } catch {
            await ctx.runMutation(internal.accountDeletion.retry, { userId });
        }
    },
});

// Mutations are durable; recover an action that crashed before it could schedule a retry.
export const watchdog = internalMutation({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const deletion = await deletionFor(ctx, userId);
        if (!deletion || deletion.phase === 'complete') return;
        const now = Date.now();
        if (now >= deletion.nextAttemptAt + 120000) {
            await ctx.db.patch(deletion._id, { retrying: true, updatedAt: now, nextAttemptAt: now });
            await ctx.scheduler.runAfter(0, internal.accountDeletion.worker, { userId });
        }
        await ctx.scheduler.runAfter(Math.max(120000, deletion.nextAttemptAt - now + 120000), internal.accountDeletion.watchdog, { userId });
    },
});
