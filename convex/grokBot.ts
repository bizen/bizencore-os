import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { accountActive, requireActiveAccount } from './accountAccess';
import { grokBotConfig } from './lib/grokBotConfig';
import { loadItem, loadItems, subtreeOf, toView } from './mcpTasks';
import { deadlineInstant } from '../src/lib/taskNotifications';
import { dateInTimeZone, isTimeString, timeInTimeZone } from '../src/lib/taskDates';
import { grokBotChallengePattern, isGrokBotRedirect } from '../src/lib/grokBotOAuth';

type Item = Awaited<ReturnType<typeof loadItems>>[number];
type Work = Doc<'taskWork'>;
type AssignmentId = Id<'grokBotAssignments'>;
const botScope = { userId: v.string(), assignmentId: v.optional(v.id('grokBotAssignments')) };
const userTask = { ...botScope, taskId: v.string() };
const retryAfter = 60_000;
const assignmentsFor = (ctx: QueryCtx, userId: string) =>
    ctx.db.query('grokBotAssignments').withIndex('by_user', q => q.eq('userId', userId));
const assignmentFor = (ctx: QueryCtx, userId: string, labelId: string) =>
    ctx.db.query('grokBotAssignments').withIndex('by_user_label', q => q.eq('userId', userId).eq('labelId', labelId)).unique();
const pilotFor = (userId: string) => {
    const pilot = grokBotConfig();
    return pilot?.userId === userId ? pilot : null;
};

function webhookFor({ webhookUrl, webhookKey }: { webhookUrl?: string; webhookKey?: string }) {
    return webhookUrl && webhookKey ? { webhookUrl, webhookKey } : null;
}

async function connectionFor(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const connection = assignmentId ? await ctx.db.get(assignmentId) : pilotFor(userId);
    return connection?.userId === userId ? connection : null;
}

async function labelOfTask(ctx: QueryCtx, userId: string, task: Item) {
    const seen = new Set([task.id]);
    let parentId = task.parentId;
    while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = await loadItem(ctx, userId, parentId);
        if (parent?.type === 'section') return parent;
        parentId = parent?.parentId ?? null;
    }
    return null;
}

async function taskAssignment(ctx: QueryCtx, userId: string, taskId: string) {
    const task = await loadItem(ctx, userId, taskId);
    if (task?.type !== 'task' || !open(task)) return null;
    const label = await labelOfTask(ctx, userId, task);
    if (!label) return null;
    const assignment = await assignmentFor(ctx, userId, label.id);
    if (assignment ? !webhookFor(assignment) : pilotFor(userId)?.labelId !== label.id) return null;
    return { task, label, assignmentId: assignment?._id };
}

const hashToken = async (token: string) => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    byte => byte.toString(16).padStart(2, '0'),
).join('');

async function scope(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const config = await connectionFor(ctx, userId, assignmentId);
    if (!config) return null;
    const items = await loadItems(ctx, userId);
    const label = items.find(item => item.id === config.labelId && item.type === 'section');
    if (!label) return null;
    const children = new Map<string, Item[]>();
    for (const item of items) {
        if (item.type !== 'task' || !item.parentId) continue;
        const siblings = children.get(item.parentId) ?? [];
        siblings.push(item);
        children.set(item.parentId, siblings);
    }
    const tasks = new Map<string, Item>();
    const pending = [...(children.get(label.id) ?? [])];
    for (const item of pending) {
        if (tasks.has(item.id)) continue;
        tasks.set(item.id, item);
        for (const child of children.get(item.id) ?? []) pending.push(child);
    }
    return { label, tasks, items };
}

async function requireScope(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const assigned = await scope(ctx, userId, assignmentId);
    if (!assigned) throw new ConvexError('The assigned label is unavailable');
    return assigned;
}

function taskInScope(assigned: Awaited<ReturnType<typeof requireScope>>, taskId: string) {
    const task = assigned.tasks.get(taskId);
    if (!task || !task.text.trim()) throw new ConvexError('Task not found in the assigned label');
    return task;
}

const open = (task: Item | undefined) => !!task?.text.trim() && !task.done && !task.filed;
const taskWork = (ctx: QueryCtx, userId: string, taskId: string) =>
    ctx.db.query('taskWork').withIndex('by_user_task', q => q.eq('userId', userId).eq('taskId', taskId));
const delegationFor = (ctx: QueryCtx, userId: string, taskId: string) =>
    ctx.db.query('grokBotDelegations').withIndex('by_user_task', q => q.eq('userId', userId).eq('taskId', taskId)).unique();

async function mayExecute(ctx: QueryCtx, userId: string, taskId: string, labelId: string, assignmentId?: AssignmentId) {
    const delegation = await delegationFor(ctx, userId, taskId);
    return delegation?.labelId === labelId && delegation.assignmentId === assignmentId;
}

async function taskDecisions(ctx: QueryCtx, userId: string, taskId: string, status: 'waiting' | 'answered', forBot?: { assignmentId?: AssignmentId }) {
    const rows = await ctx.db.query('taskWork').withIndex('by_user_task_status', q => q.eq('userId', userId).eq('taskId', taskId).eq('status', status)).collect();
    return forBot ? rows.filter(row => row.assignmentId === forBot.assignmentId) : rows;
}

function view(row: Work) {
    return { id: row._id, status: row.status, text: row.text, links: row.links, answer: row.answer,
        createdAt: row._creationTime, answeredAt: row.answeredAt, wakeAt: row.wakeAt, wakeStatus: row.wakeStatus };
}

async function history(ctx: QueryCtx, userId: string, taskId: string, forBot?: { assignmentId?: AssignmentId }) {
    const [recent, waiting, answered] = await Promise.all([
        (forBot ? ctx.db.query('taskWork').withIndex('by_user_task_assignment', q =>
            q.eq('userId', userId).eq('taskId', taskId).eq('assignmentId', forBot.assignmentId)) : taskWork(ctx, userId, taskId)).order('desc').take(50),
        taskDecisions(ctx, userId, taskId, 'waiting', forBot),
        taskDecisions(ctx, userId, taskId, 'answered', forBot),
    ]);
    return [...new Map([...recent, ...waiting, ...answered].map(row => [row._id, row])).values()];
}

export async function officerInbox(ctx: QueryCtx, userId: string, includeAnswered = true) {
    const pilot = pilotFor(userId);
    if (!pilot && !(await assignmentsFor(ctx, userId).take(1)).length) return null;
    const taskScopes = new Map<string, ReturnType<typeof taskAssignment>>();
    const decisions = async (status: 'waiting' | 'answered') => {
        const rows = await ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', status)).collect();
        return (await Promise.all(rows.map(async row => {
            let lookup = taskScopes.get(row.taskId);
            if (!lookup) {
                lookup = taskAssignment(ctx, userId, row.taskId);
                taskScopes.set(row.taskId, lookup);
            }
            const assigned = await lookup;
            return assigned && assigned.assignmentId === row.assignmentId
                ? { ...view(row), taskId: assigned.task.id, title: assigned.task.text, label: assigned.label.text } : null;
        }))).filter(row => row !== null);
    };
    const waiting = await decisions('waiting');
    return { waiting, answered: includeAnswered ? await decisions('answered') : [] };
}

async function currentUser(ctx: QueryCtx, expectedUserId: string) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== expectedUserId || !(await accountActive(ctx, identity.subject))) return null;
    return identity.subject;
}

export const assignments = query({
    args: { expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) return [];
        const rows = await assignmentsFor(ctx, userId).collect();
        const skins = rows.length ? await ctx.db.query('grokBotSkins').withIndex('by_user', q => q.eq('userId', userId)).collect() : [];
        const imageByAssignment = new Map(skins.map(skin => [skin.assignmentId, skin.image]));
        const pilot = pilotFor(userId);
        return [...rows.map(row => ({
            id: row._id, labelId: row.labelId, name: row.name ?? 'Grok Bot', connectorName: row.connectorName, connectorConnected: !!row.connectedAt,
            webhookConfigured: !!webhookFor(row), connected: !!row.connectedAt && !!webhookFor(row),
            managed: true, skin: imageByAssignment.get(row._id),
        })), ...(pilot ? [{
            id: undefined, labelId: pilot.labelId, name: 'Grok Bot', connectorName: undefined, connectorConnected: true,
            webhookConfigured: true, connected: true, managed: false, skin: undefined,
        }] : [])];
    },
});

const labelArgs = { expectedUserId: v.string(), labelId: v.string() };
const credentialArgs = { ...labelArgs, token: v.string() };
const webhookArgs = { webhookUrl: v.string(), webhookKey: v.string() };
const skinFor = (ctx: QueryCtx, assignmentId: AssignmentId) =>
    ctx.db.query('grokBotSkins').withIndex('by_assignment', q => q.eq('assignmentId', assignmentId)).unique();

function validateSkin(image: string) {
    // PNG signature and IHDR for a 64 × 64 image.
    if (image.length <= 24_576 && /^data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABA[A-Za-z0-9+/]*={0,2}$/.test(image)) return;
    throw new ConvexError('スキン画像を保存できませんでした。別の画像を選んでください。');
}

async function requireLabel(ctx: QueryCtx, expectedUserId: string, labelId: string) {
    const userId = await currentUser(ctx, expectedUserId);
    const label = userId ? await loadItem(ctx, userId, labelId) : null;
    if (!userId || label?.type !== 'section') throw new ConvexError('ラベルが見つかりません。同期後にもう一度お試しください。');
    return { userId, label };
}

async function newTokenHash(ctx: QueryCtx, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ConvexError('接続キーを発行できませんでした。');
    const tokenHash = await hashToken(token);
    if (await ctx.db.query('grokBotAssignments').withIndex('by_token', q => q.eq('tokenHash', tokenHash)).unique() ||
        grokBotConfig()?.token === token) throw new ConvexError('接続キーを再発行してください。');
    return tokenHash;
}

function validateWebhook(url: string, key: string) {
    const webhookUrl = url.trim();
    const webhookKey = key.trim().replace(/^(?:Authorization:\s*)?Bearer\s+/i, '');
    if (!/^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[\w-]{1,256}$/.test(webhookUrl)) {
        throw new ConvexError('Routineの「POST to」に表示されるURLを入力してください。');
    }
    if (!/^[!-~]{1,512}$/.test(webhookKey)) throw new ConvexError('Routineの「key」に表示されるキーを入力してください。');
    return { webhookUrl, webhookKey };
}

export const addAssignment = mutation({
    args: { ...credentialArgs, name: v.optional(v.string()), webhookUrl: v.optional(v.string()), webhookKey: v.optional(v.string()), skin: v.optional(v.string()) },
    handler: async (ctx, args) => {
        const { labelId, token } = args;
        const { userId, label } = await requireLabel(ctx, args.expectedUserId, labelId);
        if (pilotFor(userId)?.labelId === labelId || await assignmentFor(ctx, userId, labelId)) throw new ConvexError('このラベルにはすでに担当Botがいます。');
        const name = args.name?.trim();
        if (name !== undefined && (!name || name.length > 80)) throw new ConvexError('Bot名は80文字まで入力できます。');
        const webhook = args.webhookUrl !== undefined || args.webhookKey !== undefined
            ? validateWebhook(args.webhookUrl ?? '', args.webhookKey ?? '') : {};
        const labelName = Array.from(label.text.trim() || 'ラベル').slice(0, 32).join('');
        const connectorName = 'webhookUrl' in webhook ? undefined : `Terminal · ${labelName} · ${labelId.slice(-8)}`;
        if (args.skin !== undefined) validateSkin(args.skin);
        const assignmentId = await ctx.db.insert('grokBotAssignments', {
            userId, labelId, name, connectorName, ...webhook, tokenHash: await newTokenHash(ctx, token),
        });
        if (args.skin !== undefined) await ctx.db.insert('grokBotSkins', { userId, assignmentId, image: args.skin });
        return assignmentId;
    },
});

export const webhookSetupTarget = internalQuery({
    args: labelArgs,
    handler: async (ctx, { expectedUserId, labelId }) => {
        const { userId } = await requireLabel(ctx, expectedUserId, labelId);
        const assignment = await assignmentFor(ctx, userId, labelId);
        if (!assignment || webhookFor(assignment)) throw new ConvexError('接続画面を開き直してください。');
        return { assignmentId: assignment._id, tokenHash: assignment.tokenHash };
    },
});

export const saveAssignmentWebhook = internalMutation({
    args: { ...labelArgs, ...webhookArgs, assignmentId: v.id('grokBotAssignments'), tokenHash: v.string() },
    handler: async (ctx, { expectedUserId, labelId, assignmentId, tokenHash, webhookUrl, webhookKey }) => {
        const { userId } = await requireLabel(ctx, expectedUserId, labelId);
        const assignment = await ctx.db.get(assignmentId);
        if (assignment?.userId !== userId || assignment.labelId !== labelId || assignment.tokenHash !== tokenHash || webhookFor(assignment)) {
            throw new ConvexError('接続設定が更新されました。接続画面を開き直してください。');
        }
        await ctx.db.patch(assignmentId, { webhookUrl, webhookKey });
    },
});

export const connectAssignmentWebhook = action({
    args: { ...labelArgs, ...webhookArgs },
    handler: async (ctx, { webhookUrl, webhookKey, ...args }) => {
        const webhook = validateWebhook(webhookUrl, webhookKey);
        const target: { assignmentId: AssignmentId; tokenHash: string } = await ctx.runQuery(internal.grokBot.webhookSetupTarget, args);
        if (!await notifyBot(webhook, { trigger: 'connection_check' })) {
            throw new ConvexError('Routineを呼び出せませんでした。一時停止を解除し、POST toとkeyが最新か確認してください。');
        }
        await ctx.runMutation(internal.grokBot.saveAssignmentWebhook, { ...args, ...target, ...webhook });
    },
});

export const setAssignmentSkin = mutation({
    args: { expectedUserId: v.string(), assignmentId: v.id('grokBotAssignments'), skin: v.string() },
    handler: async (ctx, { expectedUserId, assignmentId, skin }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const assignment = userId ? await ctx.db.get(assignmentId) : null;
        if (!userId || assignment?.userId !== userId) throw new ConvexError('担当Botが見つかりません。');
        validateSkin(skin);
        const saved = await skinFor(ctx, assignmentId);
        if (saved) await ctx.db.patch(saved._id, { image: skin });
        else await ctx.db.insert('grokBotSkins', { userId, assignmentId, image: skin });
    },
});

export const rotateAssignmentToken = mutation({
    args: credentialArgs,
    handler: async (ctx, { expectedUserId, labelId, token }) => {
        const { userId } = await requireLabel(ctx, expectedUserId, labelId);
        const assignment = await assignmentFor(ctx, userId, labelId);
        if (!assignment) throw new ConvexError('担当Botが見つかりません。');
        await ctx.db.patch(assignment._id, { tokenHash: await newTokenHash(ctx, token), connectedAt: undefined,
            oauthGrant: undefined, oauthTokenHash: undefined });
    },
});

export const approveOAuth = mutation({
    args: { expectedUserId: v.string(), assignmentId: v.id('grokBotAssignments'), codeHash: v.string(), challenge: v.string(), redirectUri: v.string() },
    handler: async (ctx, { expectedUserId, assignmentId, codeHash, challenge, redirectUri }) => {
        if (!/^[a-f0-9]{64}$/.test(codeHash) || !grokBotChallengePattern.test(challenge) || !isGrokBotRedirect(redirectUri)) {
            throw new ConvexError('Grok Botから接続を開き直してください。');
        }
        const userId = await currentUser(ctx, expectedUserId);
        const assignment = userId ? await ctx.db.get(assignmentId) : null;
        if (!assignment || assignment.userId !== userId || (await loadItem(ctx, userId, assignment.labelId))?.type !== 'section') {
            throw new ConvexError('このラベルの接続を開けません。Terminalでラベルを確認してください。');
        }
        await ctx.db.patch(assignmentId, { oauthGrant: { codeHash, challenge, redirectUri, expiresAt: Date.now() + 120_000 } });
    },
});

export const oauthLabel = query({
    args: { expectedUserId: v.string(), assignment: v.string() },
    handler: async (ctx, { expectedUserId, assignment }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const id = ctx.db.normalizeId('grokBotAssignments', assignment);
        const row = userId && id ? await ctx.db.get(id) : null;
        if (!userId || !row || row.userId !== userId) return null;
        const label = await loadItem(ctx, userId, row.labelId);
        return label?.type === 'section' ? { id: row._id, name: label.text.trim() || 'ラベル' } : null;
    },
});

export const exchangeOAuth = internalMutation({
    args: { assignmentId: v.string(), codeHash: v.string(), challenge: v.string(), redirectUri: v.string(), tokenHash: v.string() },
    handler: async (ctx, { assignmentId, codeHash, challenge, redirectUri, tokenHash }) => {
        const id = ctx.db.normalizeId('grokBotAssignments', assignmentId);
        const assignment = id ? await ctx.db.get(id) : null;
        const grant = assignment?.oauthGrant;
        if (!id || !assignment || !grant || grant.expiresAt <= Date.now() || grant.codeHash !== codeHash ||
            grant.challenge !== challenge || grant.redirectUri !== redirectUri ||
            !(await accountActive(ctx, assignment.userId)) ||
            (await loadItem(ctx, assignment.userId, assignment.labelId))?.type !== 'section') return false;
        await ctx.db.patch(id, { oauthGrant: undefined, oauthTokenHash: tokenHash });
        return true;
    },
});

export const removeAssignment = mutation({
    args: labelArgs,
    handler: async (ctx, { expectedUserId, labelId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) throw new ConvexError('サインインしてください。');
        const assignment = await assignmentFor(ctx, userId, labelId);
        if (!assignment) return;
        const [saved, skin] = await Promise.all([scheduleFor(ctx, userId, assignment._id), skinFor(ctx, assignment._id)]);
        if (saved) await ctx.db.delete(saved._id);
        if (skin) await ctx.db.delete(skin._id);
        await ctx.db.delete(assignment._id);
    },
});

export const authorize = internalQuery({
    args: { token: v.string(), assignment: v.optional(v.string()) },
    handler: async (ctx, { token, assignment }) => {
        const pilot = grokBotConfig();
        if (pilot && assignment === undefined) {
            let mismatch = token.length ^ pilot.token.length;
            for (let i = 0; i < pilot.token.length; i++) mismatch |= pilot.token.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
            if (!mismatch) return await accountActive(ctx, pilot.userId) ? { userId: pilot.userId } : null;
        }
        const tokenHash = await hashToken(token);
        const row = assignment === undefined
            ? await ctx.db.query('grokBotAssignments').withIndex('by_token', q => q.eq('tokenHash', tokenHash)).unique()
            : await ctx.db.query('grokBotAssignments').withIndex('by_oauth_token', q => q.eq('oauthTokenHash', tokenHash)).unique();
        if (assignment !== undefined && row?._id !== assignment) return null;
        if (!row || !(await accountActive(ctx, row.userId)) || (await loadItem(ctx, row.userId, row.labelId))?.type !== 'section') return null;
        return { userId: row.userId, assignmentId: row._id, tokenHash, connectedAt: row.connectedAt, webhookConfigured: !!webhookFor(row) };
    },
});

export const markConnected = internalMutation({
    args: { assignmentId: v.id('grokBotAssignments'), tokenHash: v.string() },
    handler: async (ctx, { assignmentId, tokenHash }) => {
        const assignment = await ctx.db.get(assignmentId);
        if (assignment && !assignment.connectedAt && (assignment.tokenHash === tokenHash || assignment.oauthTokenHash === tokenHash)) {
            await ctx.db.patch(assignmentId, { connectedAt: Date.now() });
        }
    },
});

export const inbox = query({
    args: { expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        return userId ? officerInbox(ctx, userId) : null;
    },
});

export const taskHistory = query({
    args: { taskId: v.string(), expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId, taskId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) return null;
        const [rows, hasAssignment] = await Promise.all([history(ctx, userId, taskId), assignmentsFor(ctx, userId).take(1)]);
        const assigned = hasAssignment.length || pilotFor(userId) ? await taskAssignment(ctx, userId, taskId) : null;
        if (!rows.length && !assigned) return null;
        return { rows: rows.map(row => ({ ...view(row), canReply: !!assigned && row.assignmentId === assigned.assignmentId })),
            canReply: !!assigned, mayExecute: !!assigned && await mayExecute(ctx, userId, taskId, assigned.label.id, assigned.assignmentId) };
    },
});

export const setDelegation = mutation({
    args: { expectedUserId: v.string(), taskId: v.string(), execute: v.boolean() },
    handler: async (ctx, { expectedUserId, taskId, execute }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const assigned = userId ? await taskAssignment(ctx, userId, taskId) : null;
        if (!userId || !assigned) throw new ConvexError('現在の担当範囲にあるタスクを選んでください。');
        const existing = await delegationFor(ctx, userId, taskId);
        const role = { labelId: assigned.label.id, assignmentId: assigned.assignmentId };
        if (execute && existing) await ctx.db.patch(existing._id, role);
        else if (execute) await ctx.db.insert('grokBotDelegations', { userId, taskId, ...role });
        else if (existing) await ctx.db.delete(existing._id);
    },
});

export const assignedTasks = internalQuery({
    args: { ...botScope, taskId: v.optional(v.string()), offset: v.optional(v.number()) },
    handler: async (ctx, { userId, assignmentId, taskId, offset = 0 }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        if (taskId) {
            const task = taskInScope(assigned, taskId);
            const subtasks = subtreeOf([...assigned.tasks.values()], taskId).slice(1);
            return { task: await toView(ctx, userId, task, assigned.label.text, subtasks), task_version: task.updatedAt,
                bot_role: await mayExecute(ctx, userId, task.id, assigned.label.id, assignmentId) ? 'execute' : 'review', work: (await history(ctx, userId, taskId, { assignmentId })).map(view) };
        }
        const tasks = [...assigned.tasks.values()].filter(open);
        const page = tasks.slice(offset, offset + 50);
        return { label: assigned.label.text, tasks: await Promise.all(page.map(async task => ({
            id: task.id, title: task.text, parent_id: task.parentId, locked: !!task.locked,
            bot_role: await mayExecute(ctx, userId, task.id, assigned.label.id, assignmentId) ? 'execute' : 'review',
            due_date: task.dueDate, due_time: task.dueTime,
            awaiting_reply: (await taskDecisions(ctx, userId, task.id, 'waiting', { assignmentId })).length,
            answered: (await taskDecisions(ctx, userId, task.id, 'answered', { assignmentId })).length,
        }))), next_offset: offset + page.length < tasks.length ? offset + page.length : null };
    },
});

export const addAssignedTask = internalMutation({
    args: { ...botScope, title: v.string(), note: v.optional(v.string()), key: v.string() },
    handler: async (ctx, { userId, assignmentId, title, note, key }) => {
        const { label } = await requireScope(ctx, userId, assignmentId);
        const created: unknown = await ctx.runMutation(internal.mcpTasks.add, {
            userId, text: title, note, parentId: label.id, idempotencyKey: assignmentId ? `grok-bot:${await hashToken(`${assignmentId}:${key}`)}` : `grok-bot:${key}`, clientName: 'Grok Bot',
        });
        if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string' ||
            !('text' in created) || typeof created.text !== 'string') throw new ConvexError('Could not create the task');
        const assigned = await taskAssignment(ctx, userId, created.id);
        if (!assigned || assigned.label.id !== label.id || assigned.assignmentId !== assignmentId) throw new ConvexError('The previously created task is no longer open in the assigned label');
        return { id: created.id, text: created.text };
    },
});

function priorWork(ctx: QueryCtx, userId: string, taskId: string, key: string, assignmentId?: AssignmentId) {
    return ctx.db.query('taskWork').withIndex('by_user_task_key_assignment', q =>
        q.eq('userId', userId).eq('taskId', taskId).eq('key', key).eq('assignmentId', assignmentId)).unique();
}

export const requestDecision = internalMutation({
    args: { ...userTask, question: v.string(), key: v.string() },
    handler: async (ctx, { userId, assignmentId, taskId, question, key }) => {
        const task = taskInScope(await requireScope(ctx, userId, assignmentId), taskId);
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            if (previous.text !== question || previous.links !== undefined) throw new ConvexError('Idempotency key already used');
            return view(previous);
        }
        if (!open(task)) throw new ConvexError('Task is already closed');
        const waiting = await taskDecisions(ctx, userId, taskId, 'waiting', { assignmentId });
        if (waiting.some(row => row.text === question)) throw new ConvexError('This question is already waiting for a reply');
        if (waiting.length >= 10) throw new ConvexError('This task already has 10 open questions');
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, text: question, key, status: 'waiting' });
        return { id, status: 'waiting' };
    },
});

export const claimDecision = internalMutation({
    args: { ...userTask, questionId: v.string(), claimKey: v.string() },
    handler: async (ctx, { userId, assignmentId, taskId, questionId, claimKey }) => {
        const task = taskInScope(await requireScope(ctx, userId, assignmentId), taskId);
        if (!open(task)) throw new ConvexError('Task is already closed');
        const id = ctx.db.normalizeId('taskWork', questionId);
        const row = id ? await ctx.db.get(id) : null;
        if (!row || row.userId !== userId || row.taskId !== taskId || row.assignmentId !== assignmentId || row.status !== 'answered') return { claimed: false };
        const now = Date.now();
        if ((row.claimUntil ?? 0) > now && row.claimKey !== claimKey) return { claimed: false };
        await ctx.db.patch(row._id, { claimKey, claimUntil: now + 30 * 60_000 });
        return { claimed: true, answer: row.answer };
    },
});

export const recordWorkResult = internalMutation({
    args: { ...userTask, summary: v.string(), links: v.array(v.string()), complete: v.boolean(),
        appliedQuestionId: v.optional(v.string()), claimKey: v.optional(v.string()), expectedTaskVersion: v.optional(v.number()), key: v.string() },
    handler: async (ctx, { userId, assignmentId, taskId, summary, links, complete, appliedQuestionId, claimKey, expectedTaskVersion, key }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        const task = taskInScope(assigned, taskId);
        const status = complete ? 'complete' : 'progress';
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            if (previous.status !== status || previous.text !== summary || previous.appliedQuestionId !== appliedQuestionId || JSON.stringify(previous.links) !== JSON.stringify(links)) {
                throw new ConvexError('Idempotency key already used');
            }
            return view(previous);
        }
        const questionId = appliedQuestionId ? ctx.db.normalizeId('taskWork', appliedQuestionId) : null;
        if (appliedQuestionId) {
            const question = questionId ? await ctx.db.get(questionId) : null;
            if (!question || question.userId !== userId || question.taskId !== taskId || question.assignmentId !== assignmentId || question.status !== 'answered' || !claimKey || question.claimKey !== claimKey) {
                throw new ConvexError('An active claim is required to apply this answer');
            }
        }
        if (complete && !(await mayExecute(ctx, userId, taskId, assigned.label.id, assignmentId))) throw new ConvexError('This task is review-only for Grok Bot');
        if (complete && expectedTaskVersion !== task.updatedAt) throw new ConvexError('Task changed; read it again before reporting completion');
        if (complete && !task.done) {
            if (subtreeOf(assigned.items, taskId).slice(1).some(child => child.type !== 'task' || !assigned.tasks.has(child.id) || !child.done)) {
                throw new ConvexError('Finish the subtasks before completing this task');
            }
            const [waiting, answered] = await Promise.all([
                taskDecisions(ctx, userId, taskId, 'waiting', { assignmentId }), taskDecisions(ctx, userId, taskId, 'answered', { assignmentId }),
            ]);
            if (waiting.length || answered.some(row => row._id !== questionId)) throw new ConvexError('Resolve pending decisions before completing this task');
            await ctx.runMutation(internal.mcpTasks.complete, { userId, taskId, clientName: 'Grok Bot' });
        }
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, key, text: summary, status, links, appliedQuestionId });
        if (questionId) await ctx.db.patch(questionId, { status: 'applied', claimKey: undefined, claimUntil: undefined });
        return { id, status };
    },
});

async function queueWake(ctx: MutationCtx, id: Id<'taskWork'>, wakeAt: number) {
    await ctx.db.patch(id, { wakeAt, wakeStatus: 'queued' });
    await ctx.scheduler.runAfter(0, internal.grokBot.wake, { id, wakeAt });
}

export const reply = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string(), answer: v.string() },
    handler: async (ctx, { id, expectedUserId, answer }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const row = await ctx.db.get(id);
        if (!userId || row?.userId !== userId) throw new ConvexError('依頼が見つかりません。');
        const text = answer.trim();
        if (!text || text.length > 8000) throw new ConvexError('回答は1〜8000文字で入力してください。');
        if (row.status !== 'waiting') {
            if (row.answer === text) return;
            throw new ConvexError('この依頼にはすでに回答があります。');
        }
        const assigned = await taskAssignment(ctx, userId, row.taskId);
        if (!assigned || assigned.assignmentId !== row.assignmentId) throw new ConvexError('このタスクは現在の担当範囲にありません。');
        const now = Date.now();
        await ctx.db.patch(id, { status: 'answered', answer: text, answeredAt: now });
        await queueWake(ctx, id, now);
    },
});

export const retry = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string() },
    handler: async (ctx, { id, expectedUserId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const row = await ctx.db.get(id);
        if (!userId || row?.userId !== userId || row.status !== 'answered') throw new ConvexError('再通知できる依頼が見つかりません。');
        const assigned = await taskAssignment(ctx, userId, row.taskId);
        if (!assigned || assigned.assignmentId !== row.assignmentId) throw new ConvexError('このタスクは現在の担当範囲にありません。');
        const now = Date.now();
        if (row.wakeStatus !== 'failed' && now - (row.wakeAt ?? 0) < retryAfter) throw new ConvexError('少し待ってから再通知してください。');
        await queueWake(ctx, id, now);
    },
});

const wakeArgs = { id: v.id('taskWork'), wakeAt: v.number() };

export const wakeTarget = internalQuery({
    args: wakeArgs,
    handler: async (ctx, { id, wakeAt }) => {
        const row = await ctx.db.get(id);
        if (!row || row.status !== 'answered' || row.wakeAt !== wakeAt || !(await accountActive(ctx, row.userId))) return null;
        const assigned = await taskAssignment(ctx, row.userId, row.taskId);
        if (!assigned || assigned.assignmentId !== row.assignmentId) return null;
        const config = await connectionFor(ctx, row.userId, row.assignmentId);
        if (!config || ('_id' in config && !config.connectedAt)) return null;
        const webhook = webhookFor(config);
        return webhook ? { ...webhook, taskId: row.taskId } : null;
    },
});

export const wakeResult = internalMutation({
    args: { ...wakeArgs, accepted: v.boolean() },
    handler: async (ctx, { id, wakeAt, accepted }) => {
        const row = await ctx.db.get(id);
        if (row?.wakeAt !== wakeAt || row.status !== 'answered') return;
        await requireActiveAccount(ctx, row.userId);
        await ctx.db.patch(id, { wakeStatus: accepted ? 'accepted' : 'failed' });
    },
});

export const wake = internalAction({
    args: wakeArgs,
    handler: async (ctx, args) => {
        const target = await ctx.runQuery(internal.grokBot.wakeTarget, args);
        const accepted = !!target && await notifyBot(target, { trigger: 'reply', task_id: target.taskId, question_id: args.id });
        await ctx.runMutation(internal.grokBot.wakeResult, { ...args, accepted });
    },
});

async function notifyBot(config: { webhookUrl: string; webhookKey: string }, payload: Record<string, string>) {
    try {
        const response = await fetch(config.webhookUrl, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.webhookKey}` },
            body: JSON.stringify(payload),
        });
        return response.status === 200;
    } catch {
        return false;
    }
}

const scheduleFor = (ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) =>
    ctx.db.query('grokBotSchedules').withIndex('by_user_assignment', q => q.eq('userId', userId).eq('assignmentId', assignmentId)).unique();
const timezoneFor = async (ctx: QueryCtx, userId: string) =>
    (await ctx.db.query('userPreferences').withIndex('by_user', q => q.eq('userId', userId)).unique())?.timeZone ?? null;

function nextPatrol(time: string, timeZone: string, now: number, lastRunAt?: number) {
    const today = dateInTimeZone(timeZone, now);
    const start = Date.parse(`${today}T00:00:00Z`);
    const lastDay = lastRunAt ? dateInTimeZone(timeZone, lastRunAt) : undefined;
    for (let offset = 0; offset < 4; offset++) {
        const day = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
        if (lastDay === day) continue;
        const at = deadlineInstant(day, time, timeZone);
        if (at !== null && at >= Math.floor(now / 60_000) * 60_000) return at;
    }
}

export async function refreshPatrolTimeZone(ctx: MutationCtx, userId: string, timeZone: string) {
    const now = Date.now();
    for (const saved of await ctx.db.query('grokBotSchedules').withIndex('by_user', q => q.eq('userId', userId)).collect()) {
        if (saved.enabled && saved.assignmentId) await ctx.db.patch(saved._id, {
            savedAt: now, nextCheckAt: nextPatrol(saved.time, timeZone, now, saved.lastRunAt),
        });
    }
}

const scheduleArgs = { expectedUserId: v.string(), labelId: v.optional(v.string()) };

async function scheduleAssignment(ctx: QueryCtx, userId: string, labelId?: string) {
    const pilot = pilotFor(userId);
    if (!labelId) return pilot ? { assignmentId: undefined, labelId: pilot.labelId } : null;
    const assignment = await assignmentFor(ctx, userId, labelId);
    if (assignment) return { assignmentId: assignment._id, labelId };
    return pilot?.labelId === labelId ? { assignmentId: undefined, labelId } : null;
}

export const schedule = query({
    args: scheduleArgs,
    handler: async (ctx, { expectedUserId, labelId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId) : null;
        if (!userId || !target) return null;
        const [saved, timeZone] = await Promise.all([scheduleFor(ctx, userId, target.assignmentId), timezoneFor(ctx, userId)]);
        return { timeZone, enabled: saved?.enabled ?? false, time: saved?.time ?? '03:00',
            lastRunAt: saved?.lastRunAt, lastStatus: saved?.lastStatus };
    },
});

export const saveSchedule = mutation({
    args: { ...scheduleArgs, enabled: v.boolean(), time: v.string() },
    handler: async (ctx, { expectedUserId, labelId, enabled, time }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId) : null;
        if (!userId || !target || (await loadItem(ctx, userId, target.labelId))?.type !== 'section') throw new ConvexError('Grok Botの担当ラベルが見つかりません。');
        if (!isTimeString(time)) throw new ConvexError('巡回時刻を入力してください。');
        const [saved, timeZone] = await Promise.all([scheduleFor(ctx, userId, target.assignmentId), timezoneFor(ctx, userId)]);
        if (enabled && !timeZone) throw new ConvexError('先に設定でタイムゾーンを保存してください。');
        const savedAt = Date.now();
        const nextCheckAt = target.assignmentId && enabled && timeZone ? nextPatrol(time, timeZone, savedAt, saved?.lastRunAt) : undefined;
        if (saved) await ctx.db.patch(saved._id, { enabled, time, savedAt, nextCheckAt });
        else await ctx.db.insert('grokBotSchedules', { userId, assignmentId: target.assignmentId, enabled, time, savedAt, nextCheckAt });
    },
});

export async function dispatchDuePatrol(ctx: MutationCtx, now: number) {
    const due = await ctx.db.query('grokBotSchedules').withIndex('by_next', q => q.gt('nextCheckAt', 0).lte('nextCheckAt', now)).take(25);
    for (const saved of due) {
        const assignment = saved.assignmentId ? await ctx.db.get(saved.assignmentId) : null;
        const timeZone = saved.enabled && assignment && await accountActive(ctx, saved.userId) ? await timezoneFor(ctx, saved.userId) : null;
        const label = assignment && timeZone ? await loadItem(ctx, saved.userId, assignment.labelId) : null;
        if (!timeZone || label?.type !== 'section') {
            await ctx.db.patch(saved._id, { nextCheckAt: undefined });
            continue;
        }
        const day = dateInTimeZone(timeZone, now);
        const shouldRun = assignment?.connectedAt && webhookFor(assignment) && dateInTimeZone(timeZone, saved.nextCheckAt) === day;
        const nextCheckAt = nextPatrol(saved.time, timeZone, now, shouldRun ? now : saved.nextCheckAt);
        await ctx.db.patch(saved._id, shouldRun
            ? { nextCheckAt, lastDay: day, lastRunAt: now, lastStatus: 'queued' }
            : { nextCheckAt });
        if (shouldRun) await ctx.scheduler.runAfter(0, internal.grokBot.runPatrol, { id: saved._id, at: now, labelId: label.id });
    }
    const config = grokBotConfig();
    if (!config || !(await accountActive(ctx, config.userId))) return;
    const [saved, timeZone] = await Promise.all([scheduleFor(ctx, config.userId), timezoneFor(ctx, config.userId)]);
    if (!saved?.enabled || !timeZone) return;
    const day = dateInTimeZone(timeZone, now);
    if (saved.lastDay === day || timeInTimeZone(timeZone, now) < saved.time) return;
    if (dateInTimeZone(timeZone, saved.savedAt) === day && timeInTimeZone(timeZone, saved.savedAt) > saved.time) return;
    await ctx.db.patch(saved._id, { lastDay: day, lastRunAt: now, lastStatus: 'queued' });
    await ctx.scheduler.runAfter(0, internal.grokBot.runPatrol, { id: saved._id, at: now, labelId: config.labelId });
}

const patrolArgs = { id: v.id('grokBotSchedules'), at: v.number(), labelId: v.string() };

export const patrolTarget = internalQuery({
    args: patrolArgs,
    handler: async (ctx, { id, at, labelId }) => {
        const saved = await ctx.db.get(id);
        if (!saved?.enabled || saved.savedAt > at || saved.lastRunAt !== at || saved.lastStatus !== 'queued' ||
            !(await accountActive(ctx, saved.userId))) return null;
        const target = await connectionFor(ctx, saved.userId, saved.assignmentId);
        if (target?.labelId !== labelId || ('_id' in target && !target.connectedAt) ||
            (await loadItem(ctx, saved.userId, labelId))?.type !== 'section') return null;
        return webhookFor(target);
    },
});

export const patrolResult = internalMutation({
    args: { ...patrolArgs, accepted: v.boolean() },
    handler: async (ctx, { id, at, accepted }) => {
        const saved = await ctx.db.get(id);
        if (!saved || saved.lastRunAt !== at || !(await accountActive(ctx, saved.userId))) return;
        await ctx.db.patch(id, { lastStatus: accepted ? 'accepted' : 'failed' });
    },
});

export const runPatrol = internalAction({
    args: patrolArgs,
    handler: async (ctx, args) => {
        const target = await ctx.runQuery(internal.grokBot.patrolTarget, args);
        const accepted = !!target && await notifyBot(target, { trigger: 'patrol' });
        await ctx.runMutation(internal.grokBot.patrolResult, { ...args, accepted });
    },
});
