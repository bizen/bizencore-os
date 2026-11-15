import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { requireActiveAccount } from './accountAccess';
import { loadItems, stampAfter, subtreeOf, writeItem } from './mcpTasks';

const LIFETIME_MS = 10 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const decision = v.union(v.literal('approve'), v.literal('cancel'));
type Ctx = QueryCtx | MutationCtx;

async function authenticatedUser(ctx: Ctx, expectedAccountId: string) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== expectedAccountId) throw new ConvexError('アカウントが変わりました。サインインを確認してください。');
    await requireActiveAccount(ctx, identity.subject);
    return identity.subject;
}

async function find(ctx: Ctx, userId: string, requestId: string) {
    await requireActiveAccount(ctx, userId);
    const request = await ctx.db.query('taskActions').withIndex('by_user_request', q => q.eq('userId', userId).eq('requestId', requestId)).unique();
    if (!request) throw new ConvexError('確認待ちの操作が見つかりません。依頼したアカウントでサインインしてください。');
    return request;
}

function snapshot(items: Awaited<ReturnType<typeof loadItems>>, taskId: string) {
    const target = items.find(item => item.id === taskId && item.type === 'task');
    if (!target) return null;
    const tree = subtreeOf(items, taskId);
    // All supported writes advance updatedAt. Include IDs so equal-size subtree changes are caught.
    const revision = JSON.stringify(tree.map(item => [item.id, item.updatedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    return { text: target.text, count: tree.length, revision, tree };
}

async function view(ctx: Ctx, request: Doc<'taskActions'>) {
    const current = request.status === 'pending' && request.expiresAt > Date.now()
        ? snapshot(await loadItems(ctx, request.userId), request.taskId) : null;
    const status = request.status !== 'pending' ? request.status
        : request.expiresAt <= Date.now() ? 'expired'
        : current?.revision !== request.revision ? 'changed' : 'pending';
    return { request_id: request.requestId, task_id: request.taskId, user_id: request.userId,
        text: request.text, count: request.count, revision: request.revision, status,
        expires_at: request.expiresAt, client_name: request.clientName,
        ...(request.deleted !== undefined ? { deleted: request.deleted } : {}),
        ...(status === 'pending' ? { subtasks: current!.tree.filter(item => item.id !== request.taskId).slice(0, 100).map(item => ({ id: item.id, text: item.text })) } : {}),
    };
}

export const prepareDelete = internalMutation({
    args: { userId: v.string(), clientId: v.string(), clientName: v.optional(v.string()), taskId: v.string() },
    handler: async (ctx, args) => {
        const current = snapshot(await loadItems(ctx, args.userId), args.taskId);
        if (!current) throw new ConvexError('task not found');
        const existing = await ctx.db.query('taskActions').withIndex('by_user_client_task', q => q.eq('userId', args.userId).eq('clientId', args.clientId).eq('taskId', args.taskId)).collect();
        for (const request of existing) {
            if (request.status !== 'pending' || request.expiresAt <= Date.now()) continue;
            if (request.revision === current.revision) return view(ctx, request);
            await ctx.db.patch(request._id, { status: 'changed' });
        }
        const requestId = crypto.randomUUID();
        const createdAt = Date.now();
        const row = { ...args, requestId, kind: 'delete_task' as const, text: current.text, count: current.count,
            revision: current.revision, status: 'pending' as const, createdAt, expiresAt: createdAt + LIFETIME_MS };
        const id = await ctx.db.insert('taskActions', row);
        await ctx.scheduler.runAfter(LIFETIME_MS, internal.taskActions.expire, { userId: args.userId, requestId });
        await ctx.scheduler.runAfter(RETENTION_MS, internal.taskActions.cleanup, { userId: args.userId, requestId });
        return view(ctx, { ...row, _id: id, _creationTime: createdAt });
    },
});

export const statusForClient = internalQuery({
    args: { userId: v.string(), clientId: v.string(), requestId: v.string(), taskId: v.string() },
    handler: async (ctx, args) => {
        const request = await find(ctx, args.userId, args.requestId);
        if (request.clientId !== args.clientId || request.taskId !== args.taskId) throw new ConvexError('確認待ちの操作が一致しません。');
        return view(ctx, request);
    },
});

async function decide(ctx: MutationCtx, request: Doc<'taskActions'>, choice: 'approve' | 'cancel') {
    const state = await view(ctx, request);
    if (state.status !== 'pending') return state;
    if (choice === 'cancel') {
        await ctx.db.patch(request._id, { status: 'cancelled' });
        return { ...state, status: 'cancelled' as const };
    }
    const items = await loadItems(ctx, request.userId);
    const current = snapshot(items, request.taskId);
    if (current?.revision !== request.revision) return { ...state, status: 'changed' as const };
    let stamp = stampAfter(items);
    for (const item of current.tree) {
        const updatedAt = stamp++;
        await writeItem(ctx, request.userId, { ...item, deletedAt: updatedAt, updatedAt });
    }
    // The tombstones and receipt commit in the same transaction, including concurrent approvals.
    await ctx.db.patch(request._id, { status: 'completed', deleted: current.count });
    return { ...state, status: 'completed' as const, deleted: current.count };
}

export const decideForClient = internalMutation({
    args: { userId: v.string(), clientId: v.string(), requestId: v.string(), taskId: v.string(), decision },
    handler: async (ctx, args) => {
        const request = await find(ctx, args.userId, args.requestId);
        if (request.clientId !== args.clientId || request.taskId !== args.taskId) throw new ConvexError('確認待ちの操作が一致しません。');
        return decide(ctx, request, args.decision);
    },
});

export const get = query({
    args: { requestId: v.string(), expectedAccountId: v.string() },
    handler: async (ctx, args) => {
        const userId = await authenticatedUser(ctx, args.expectedAccountId);
        const request = await ctx.db.query('taskActions').withIndex('by_user_request', q => q.eq('userId', userId).eq('requestId', args.requestId)).unique();
        return request ? view(ctx, request) : null;
    },
});

export const respond = mutation({
    args: { requestId: v.string(), expectedAccountId: v.string(), expectedRevision: v.string(), decision },
    handler: async (ctx, args) => {
        const request = await find(ctx, await authenticatedUser(ctx, args.expectedAccountId), args.requestId);
        if (args.expectedRevision !== request.revision) throw new ConvexError('確認内容が一致しません。画面を開き直してください。');
        return decide(ctx, request, args.decision);
    },
});

export const cleanup = internalMutation({
    args: { userId: v.string(), requestId: v.string() },
    handler: async (ctx, args) => {
        const request = await ctx.db.query('taskActions').withIndex('by_user_request', q => q.eq('userId', args.userId).eq('requestId', args.requestId)).unique();
        if (request && request.createdAt + RETENTION_MS <= Date.now()) await ctx.db.delete(request._id);
    },
});

export const expire = internalMutation({
    args: { userId: v.string(), requestId: v.string() },
    handler: async (ctx, args) => {
        const request = await ctx.db.query('taskActions').withIndex('by_user_request', q => q.eq('userId', args.userId).eq('requestId', args.requestId)).unique();
        // Persist expiry so cached/reactive queries also observe it without polling.
        if (request?.status === 'pending' && request.expiresAt <= Date.now()) await ctx.db.patch(request._id, { status: 'expired' });
    },
});
