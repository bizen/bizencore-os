import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { accountActive, requireActiveAccount } from './accountAccess';
import { grokBotConfig } from './lib/grokBotConfig';
import { loadItem, loadItems, subtreeOf, toView } from './mcpTasks';
import { snapshot } from './taskActions';
import { deadlineInstant } from '../src/lib/taskNotifications';
import { dateInTimeZone, isDateString, isTimeString, timeInTimeZone } from '../src/lib/taskDates';
import { grokBotChallengePattern, isGrokBotRedirect } from '../src/lib/grokBotOAuth';

type Item = Awaited<ReturnType<typeof loadItems>>[number];
type Work = Doc<'taskWork'>;
type AssignmentId = Id<'grokBotAssignments'>;
const botScope = { userId: v.string(), assignmentId: v.optional(v.id('grokBotAssignments')) };
const userTask = { ...botScope, taskId: v.string() };
const retryAfter = 60_000;
/** The VP is stored as an assignment with role 'vp' and no label; it never counts as a label's Bot. */
const isVp = (row: { role?: 'vp' } | null | undefined) => row?.role === 'vp';
const vpLabelId = '';
const labelAssignments = async (ctx: QueryCtx, userId: string) =>
    (await ctx.db.query('grokBotAssignments').withIndex('by_user', q => q.eq('userId', userId)).collect()).filter(row => !isVp(row));
const assignmentFor = async (ctx: QueryCtx, userId: string, labelId: string) =>
    (await ctx.db.query('grokBotAssignments').withIndex('by_user_label', q => q.eq('userId', userId).eq('labelId', labelId)).collect()).find(row => !isVp(row)) ?? null;
const vpFor = async (ctx: QueryCtx, userId: string) =>
    (await ctx.db.query('grokBotAssignments').withIndex('by_user_label', q => q.eq('userId', userId).eq('labelId', vpLabelId)).collect()).find(isVp) ?? null;
const pilotFor = (userId: string) => {
    const pilot = grokBotConfig();
    return pilot?.userId === userId ? pilot : null;
};

function webhookFor({ webhookUrl, webhookKey }: { webhookUrl?: string; webhookKey?: string }) {
    return webhookUrl && webhookKey ? { webhookUrl, webhookKey } : null;
}

async function connectionFor(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const connection = assignmentId ? await ctx.db.get(assignmentId) : pilotFor(userId);
    return connection?.userId === userId && !('role' in connection && isVp(connection)) ? connection : null;
}

function labelIn(byId: Map<string, Item>, task: Item) {
    const seen = new Set([task.id]);
    for (let parent = task.parentId ? byId.get(task.parentId) : undefined; parent && !seen.has(parent.id);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
        if (parent.type === 'section') return parent;
        seen.add(parent.id);
    }
    return null;
}

/** 未仕分け: a root-level task (its parent is missing or absent) that no label contains. */
const unsorted = (byId: Map<string, Item>, task: Item) => task.type === 'task' && !(task.parentId && byId.has(task.parentId));

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

async function botRole(ctx: QueryCtx, userId: string, taskId: string, labelId: string, assignmentId?: AssignmentId) {
    const delegation = await delegationFor(ctx, userId, taskId);
    const execute = delegation?.labelId === labelId && delegation.assignmentId === assignmentId;
    return { execute, reviewRequired: execute && !!delegation.reviewCompletion };
}

async function taskDecisions(ctx: QueryCtx, userId: string, taskId: string, status: Work['status'], forBot?: { assignmentId?: AssignmentId }) {
    const rows = await ctx.db.query('taskWork').withIndex('by_user_task_status', q => q.eq('userId', userId).eq('taskId', taskId).eq('status', status)).collect();
    return forBot ? rows.filter(row => row.assignmentId === forBot.assignmentId) : rows;
}

function view(row: Work) {
    return { id: row._id, status: row.status, text: row.text, links: row.links, answer: row.answer,
        createdAt: row._creationTime, answeredAt: row.answeredAt, wakeAt: row.wakeAt, wakeStatus: row.wakeStatus,
        kind: row.kind, options: row.options, recommendation: row.recommendation, irreversible: row.irreversible, assumptions: row.assumptions };
}

/** Rows that stay in a history beyond the recent page: anything the human or the Bot still has to act on. */
const openStatuses = ['waiting', 'answered', 'review', 'returned'] as const;

async function history(ctx: QueryCtx, userId: string, taskId: string, forBot?: { assignmentId?: AssignmentId }) {
    const [recent, ...unresolved] = await Promise.all([
        (forBot ? ctx.db.query('taskWork').withIndex('by_user_task_assignment', q =>
            q.eq('userId', userId).eq('taskId', taskId).eq('assignmentId', forBot.assignmentId)) : taskWork(ctx, userId, taskId)).order('desc').take(50),
        ...openStatuses.map(status => taskDecisions(ctx, userId, taskId, status, forBot)),
    ]);
    return [...new Map([...recent, ...unresolved.flat()].map(row => [row._id, row])).values()];
}

/**
 * Waiting decisions and pending reviews, most blocking first: a label whose Bot cannot execute anything else,
 * then the larger open subtree, then the oldest. Answered rows wait for the Bot and follow separately.
 */
export async function officerInbox(ctx: QueryCtx, userId: string, includeAnswered = true) {
    const pilot = pilotFor(userId);
    const assignments = await labelAssignments(ctx, userId);
    if (!pilot && !assignments.length) return null;
    const rowsFor = (status: Work['status']) => ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', status)).collect();
    const none = Promise.resolve<Work[]>([]);
    const [waiting, reviews, answered, returned] = await Promise.all([rowsFor('waiting'), rowsFor('review'),
        includeAnswered ? rowsFor('answered') : none, includeAnswered ? rowsFor('returned') : none]);
    if (!waiting.length && !reviews.length && !answered.length && !returned.length) return { pending: [], answered: [] };
    const items = await loadItems(ctx, userId);
    const byId = new Map(items.map(item => [item.id, item]));
    const children = new Map<string, Item[]>();
    for (const item of items) {
        if (item.type !== 'task' || !item.parentId) continue;
        children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
    }
    const labelOf = (task: Item) => labelIn(byId, task);
    const place = (row: Work) => {
        const task = byId.get(row.taskId);
        const label = task?.type === 'task' && open(task) ? labelOf(task) : null;
        if (!task || !label) return null;
        const assignment = assignments.find(candidate => candidate.labelId === label.id);
        if (assignment ? !webhookFor(assignment) || assignment._id !== row.assignmentId : pilot?.labelId !== label.id || row.assignmentId !== undefined) return null;
        return { ...view(row), taskId: task.id, title: task.text, label: label.text, labelId: label.id, assignmentId: row.assignmentId };
    };
    const placed = (rows: Work[]) => rows.map(place).filter(row => row !== null);
    const pending = placed([...waiting, ...reviews]);
    const openCounts = new Map<string, number>();
    const openTasksIn = (id: string, seen = new Set<string>()): number => {
        const known = openCounts.get(id);
        if (known !== undefined) return known;
        if (seen.has(id)) return 0;
        seen.add(id);
        const count = (open(byId.get(id)) ? 1 : 0) + (children.get(id) ?? []).reduce((sum, child) => sum + openTasksIn(child.id, seen), 0);
        openCounts.set(id, count);
        return count;
    };
    const blocked = new Set(pending.map(row => `${row.labelId}:${row.taskId}`));
    const delegations = pending.length ? await ctx.db.query('grokBotDelegations').withIndex('by_user', q => q.eq('userId', userId)).collect() : [];
    const stalledLabels = new Map<string, boolean>();
    const stalled = (labelId: string, assignmentId?: AssignmentId) => {
        const known = stalledLabels.get(labelId);
        if (known !== undefined) return known;
        const executable = delegations.filter(row => {
            const task = byId.get(row.taskId);
            return row.labelId === labelId && row.assignmentId === assignmentId && task?.type === 'task' && open(task) && labelOf(task)?.id === labelId;
        });
        const result = executable.length > 0 && executable.every(row => blocked.has(`${labelId}:${row.taskId}`));
        stalledLabels.set(labelId, result);
        return result;
    };
    const ordered = pending.map(row => ({ ...row, stalled: stalled(row.labelId, row.assignmentId), openTasks: openTasksIn(row.taskId) }))
        .sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.openTasks - a.openTasks || a.createdAt - b.createdAt);
    return { pending: ordered, answered: placed([...answered, ...returned]).sort((a, b) => a.createdAt - b.createdAt) };
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
        const rows = await labelAssignments(ctx, userId);
        const skins = rows.length ? await ctx.db.query('grokBotSkins').withIndex('by_user', q => q.eq('userId', userId)).collect() : [];
        const imageByAssignment = new Map(skins.map(skin => [skin.assignmentId, skin.image]));
        const pilot = pilotFor(userId);
        return [...rows.map(row => assignmentView(row, imageByAssignment.get(row._id))), ...(pilot ? [{
            id: undefined, labelId: pilot.labelId, name: 'Grok Bot', connectorName: undefined, connectorConnected: true,
            webhookConfigured: true, connected: true, managed: false, skin: undefined,
        }] : [])];
    },
});

function assignmentView(row: Doc<'grokBotAssignments'>, skin?: string) {
    return { id: row._id, labelId: row.labelId, name: row.name ?? 'Grok Bot', connectorName: row.connectorName, connectorConnected: !!row.connectedAt,
        webhookConfigured: !!webhookFor(row), connected: !!row.connectedAt && !!webhookFor(row), managed: true, skin };
}

/** The user's VP connection, shaped like a label assignment so the same connection UI can manage it. */
export const vp = query({
    args: { expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const row = userId ? await vpFor(ctx, userId) : null;
        return row ? assignmentView(row, (await skinFor(ctx, row._id))?.image) : null;
    },
});

/** A connection target: a label's Bot, or with vp the user's VP. */
const labelArgs = { expectedUserId: v.string(), labelId: v.optional(v.string()), vp: v.optional(v.literal(true)) };
const credentialArgs = { ...labelArgs, token: v.string() };
type Target = { expectedUserId: string; labelId?: string; vp?: true };
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

async function requireTarget(ctx: QueryCtx, { expectedUserId, labelId, vp }: Target) {
    if (!vp) {
        const { userId, label } = await requireLabel(ctx, expectedUserId, labelId ?? '');
        return { userId, vp: false, labelId: label.id, labelName: label.text };
    }
    const userId = await currentUser(ctx, expectedUserId);
    if (!userId || labelId !== undefined) throw new ConvexError('サインインしてください。');
    return { userId, vp: true, labelId: vpLabelId, labelName: 'VP' };
}

const targetAssignment = (ctx: QueryCtx, target: { userId: string; vp: boolean; labelId: string }) =>
    target.vp ? vpFor(ctx, target.userId) : assignmentFor(ctx, target.userId, target.labelId);

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
        const target = await requireTarget(ctx, args);
        const { userId, labelId } = target;
        if ((!target.vp && pilotFor(userId)?.labelId === labelId) || await targetAssignment(ctx, target)) {
            throw new ConvexError(target.vp ? 'VPはすでに接続されています。' : 'このラベルにはすでに担当Botがいます。');
        }
        const name = args.name?.trim();
        if (name !== undefined && (!name || name.length > 80)) throw new ConvexError('Bot名は80文字まで入力できます。');
        const webhook = args.webhookUrl !== undefined || args.webhookKey !== undefined
            ? validateWebhook(args.webhookUrl ?? '', args.webhookKey ?? '') : {};
        const labelName = Array.from(target.labelName.trim() || 'ラベル').slice(0, 32).join('');
        const connectorName = 'webhookUrl' in webhook ? undefined : target.vp ? 'Terminal · VP' : `Terminal · ${labelName} · ${labelId.slice(-8)}`;
        if (args.skin !== undefined) validateSkin(args.skin);
        const assignmentId = await ctx.db.insert('grokBotAssignments', {
            userId, labelId, ...(target.vp ? { role: 'vp' as const } : {}), name, connectorName, ...webhook, tokenHash: await newTokenHash(ctx, args.token),
        });
        if (args.skin !== undefined) await ctx.db.insert('grokBotSkins', { userId, assignmentId, image: args.skin });
        return assignmentId;
    },
});

export const webhookSetupTarget = internalQuery({
    args: labelArgs,
    handler: async (ctx, args) => {
        const assignment = await targetAssignment(ctx, await requireTarget(ctx, args));
        if (!assignment || webhookFor(assignment)) throw new ConvexError('接続画面を開き直してください。');
        return { assignmentId: assignment._id, tokenHash: assignment.tokenHash };
    },
});

export const saveAssignmentWebhook = internalMutation({
    args: { ...labelArgs, ...webhookArgs, assignmentId: v.id('grokBotAssignments'), tokenHash: v.string() },
    handler: async (ctx, { assignmentId, tokenHash, webhookUrl, webhookKey, ...args }) => {
        const target = await requireTarget(ctx, args);
        const assignment = await ctx.db.get(assignmentId);
        if (assignment?.userId !== target.userId || assignment.labelId !== target.labelId || isVp(assignment) !== target.vp ||
            assignment.tokenHash !== tokenHash || webhookFor(assignment)) {
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
    handler: async (ctx, { token, ...args }) => {
        const assignment = await targetAssignment(ctx, await requireTarget(ctx, args));
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
        if (!assignment || assignment.userId !== userId || (!isVp(assignment) && (await loadItem(ctx, userId, assignment.labelId))?.type !== 'section')) {
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
        if (isVp(row)) return { id: row._id, name: 'VP', vp: true };
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
            (!isVp(assignment) && (await loadItem(ctx, assignment.userId, assignment.labelId))?.type !== 'section')) return false;
        await ctx.db.patch(id, { oauthGrant: undefined, oauthTokenHash: tokenHash });
        return true;
    },
});

export const removeAssignment = mutation({
    args: labelArgs,
    handler: async (ctx, { expectedUserId, labelId, vp }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) throw new ConvexError('サインインしてください。');
        const assignment = vp ? await vpFor(ctx, userId) : labelId !== undefined ? await assignmentFor(ctx, userId, labelId) : null;
        if (!assignment) return;
        const [saved, skin, proposals] = await Promise.all([scheduleFor(ctx, userId, assignment._id), skinFor(ctx, assignment._id),
            ctx.db.query('grokBotProposals').withIndex('by_user_assignment_status', q => q.eq('userId', userId).eq('assignmentId', assignment._id)).collect()]);
        if (saved) await ctx.db.delete(saved._id);
        if (skin) await ctx.db.delete(skin._id);
        for (const proposal of proposals) await ctx.db.delete(proposal._id);
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
            if (!mismatch) return await accountActive(ctx, pilot.userId) ? { userId: pilot.userId, vp: false } : null;
        }
        const tokenHash = await hashToken(token);
        const row = assignment === undefined
            ? await ctx.db.query('grokBotAssignments').withIndex('by_token', q => q.eq('tokenHash', tokenHash)).unique()
            : await ctx.db.query('grokBotAssignments').withIndex('by_oauth_token', q => q.eq('oauthTokenHash', tokenHash)).unique();
        if (assignment !== undefined && row?._id !== assignment) return null;
        if (!row || !(await accountActive(ctx, row.userId)) || (!isVp(row) && (await loadItem(ctx, row.userId, row.labelId))?.type !== 'section')) return null;
        return { userId: row.userId, assignmentId: row._id, tokenHash, connectedAt: row.connectedAt, webhookConfigured: !!webhookFor(row), vp: isVp(row) };
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
        if (!userId) return null;
        const [officer, vpRow] = await Promise.all([officerInbox(ctx, userId), vpFor(ctx, userId)]);
        if (!officer && !vpRow) return null;
        return { ...(officer ?? { pending: [], answered: [] }), proposals: await proposalInbox(ctx, userId) };
    },
});

export const taskHistory = query({
    args: { taskId: v.string(), expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId, taskId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) return null;
        const [rows, hasAssignment, deferredUntil] = await Promise.all([history(ctx, userId, taskId), labelAssignments(ctx, userId), deferral(ctx, userId, taskId)]);
        const assigned = hasAssignment.length || pilotFor(userId) ? await taskAssignment(ctx, userId, taskId) : null;
        if (!rows.length && !assigned && !deferredUntil) return null;
        const role = assigned ? await botRole(ctx, userId, taskId, assigned.label.id, assigned.assignmentId) : null;
        return { rows: rows.map(row => ({ ...view(row), canReply: !!assigned && row.assignmentId === assigned.assignmentId })),
            canReply: !!assigned, mayExecute: !!role?.execute, reviewRequired: !!role?.reviewRequired, deferredUntil };
    },
});

export const setDelegation = mutation({
    args: { expectedUserId: v.string(), taskId: v.string(), execute: v.boolean(), reviewCompletion: v.optional(v.boolean()) },
    handler: async (ctx, { expectedUserId, taskId, execute, reviewCompletion }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const assigned = userId ? await taskAssignment(ctx, userId, taskId) : null;
        if (!userId || !assigned) throw new ConvexError('現在の担当範囲にあるタスクを選んでください。');
        const existing = await delegationFor(ctx, userId, taskId);
        const role = { labelId: assigned.label.id, assignmentId: assigned.assignmentId, reviewCompletion: reviewCompletion || undefined };
        if (execute && existing) await ctx.db.patch(existing._id, role);
        else if (execute) await ctx.db.insert('grokBotDelegations', { userId, taskId, ...role });
        else if (existing) await ctx.db.delete(existing._id);
    },
});

export const assignedTasks = internalQuery({
    args: { ...botScope, taskId: v.optional(v.string()), offset: v.optional(v.number()) },
    handler: async (ctx, { userId, assignmentId, taskId, offset = 0 }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        const roleOf = async (id: string) => {
            const role = await botRole(ctx, userId, id, assigned.label.id, assignmentId);
            return { bot_role: role.execute ? 'execute' : 'review', review_required: role.reviewRequired };
        };
        if (taskId) {
            const task = taskInScope(assigned, taskId);
            const subtasks = subtreeOf([...assigned.tasks.values()], taskId).slice(1);
            return { task: await toView(ctx, userId, task, assigned.label.text, subtasks), task_version: task.updatedAt,
                ...await roleOf(task.id), deferred_until: await deferral(ctx, userId, taskId),
                work: (await history(ctx, userId, taskId, { assignmentId })).map(view), proposals: await taskProposals(ctx, userId, assignmentId, taskId) };
        }
        const deferred = await deferrals(ctx, userId);
        const tasks = [...assigned.tasks.values()].filter(task => open(task) && !deferred.has(task.id));
        const page = tasks.slice(offset, offset + 50);
        const count = async (id: string, status: Work['status']) => (await taskDecisions(ctx, userId, id, status, { assignmentId })).length;
        return { label: assigned.label.text, tasks: await Promise.all(page.map(async task => ({
            id: task.id, title: task.text, parent_id: task.parentId, locked: !!task.locked,
            ...await roleOf(task.id),
            due_date: task.dueDate, due_time: task.dueTime,
            awaiting_reply: await count(task.id, 'waiting'),
            answered: await count(task.id, 'answered'),
            awaiting_review: await count(task.id, 'review'),
            returned: await count(task.id, 'returned'),
        }))), next_offset: offset + page.length < tasks.length ? offset + page.length : null,
        proposals: await ownProposals(ctx, userId, assignmentId) };
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

/** An answered decision or a returned review: the human acted and the Bot has yet to apply it. */
const awaitsBot = (row: Work) => row.status === 'answered' || row.status === 'returned';

function priorWork(ctx: QueryCtx, userId: string, taskId: string, key: string, assignmentId?: AssignmentId) {
    return ctx.db.query('taskWork').withIndex('by_user_task_key_assignment', q =>
        q.eq('userId', userId).eq('taskId', taskId).eq('key', key).eq('assignmentId', assignmentId)).unique();
}

const decisionKind = v.union(v.literal('approval'), v.literal('choice'), v.literal('info'));

function decisionShape({ kind = 'info', options, recommendation, irreversible }:
    { kind?: 'approval' | 'choice' | 'info'; options?: string[]; recommendation?: string; irreversible?: boolean }) {
    const choices = options?.map(option => option.trim());
    if (kind === 'choice' ? !choices?.length || choices.length > 4 : choices !== undefined) {
        throw new ConvexError(kind === 'choice' ? 'A choice needs 1 to 4 options' : 'Options are only for kind choice');
    }
    if (choices && (choices.some(option => !option || option.length > 100) || new Set(choices).size !== choices.length)) {
        throw new ConvexError('Options must be distinct and 1 to 100 characters');
    }
    const recommended = recommendation?.trim();
    if (recommendation !== undefined && (!recommended || recommended.length > 500)) throw new ConvexError('The recommendation must be 1 to 500 characters');
    if (choices && recommended !== undefined && !choices.includes(recommended)) throw new ConvexError('The recommendation must be one of the options');
    return { kind, options: choices, recommendation: recommended, irreversible: irreversible || undefined };
}

export const requestDecision = internalMutation({
    args: { ...userTask, question: v.string(), key: v.string(), kind: v.optional(decisionKind), options: v.optional(v.array(v.string())),
        recommendation: v.optional(v.string()), irreversible: v.optional(v.boolean()) },
    handler: async (ctx, { userId, assignmentId, taskId, question, key, ...decision }) => {
        const task = taskInScope(await requireScope(ctx, userId, assignmentId), taskId);
        const shape = decisionShape(decision);
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            const same = (row: { kind?: string; options?: string[]; recommendation?: string; irreversible?: boolean }) => JSON.stringify([row.kind ?? 'info', row.options, row.recommendation, !!row.irreversible]);
            if (previous.text !== question || previous.links !== undefined || same(previous) !== same(shape)) throw new ConvexError('Idempotency key already used');
            return view(previous);
        }
        if (!open(task)) throw new ConvexError('Task is already closed');
        await requireNotDeferred(ctx, userId, taskId);
        const waiting = await taskDecisions(ctx, userId, taskId, 'waiting', { assignmentId });
        if (waiting.some(row => row.text === question)) throw new ConvexError('This question is already waiting for a reply');
        if (waiting.length >= 10) throw new ConvexError('This task already has 10 open questions');
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, text: question, key, status: 'waiting', ...shape });
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
        if (!row || row.userId !== userId || row.taskId !== taskId || row.assignmentId !== assignmentId || !awaitsBot(row)) return { claimed: false };
        const now = Date.now();
        if ((row.claimUntil ?? 0) > now && row.claimKey !== claimKey) return { claimed: false };
        await ctx.db.patch(row._id, { claimKey, claimUntil: now + 30 * 60_000 });
        return { claimed: true, answer: row.answer };
    },
});

export const recordWorkResult = internalMutation({
    args: { ...userTask, summary: v.string(), links: v.array(v.string()), complete: v.boolean(),
        needsReview: v.optional(v.boolean()), assumptions: v.optional(v.string()),
        appliedQuestionId: v.optional(v.string()), claimKey: v.optional(v.string()), expectedTaskVersion: v.optional(v.number()), key: v.string() },
    handler: async (ctx, { userId, assignmentId, taskId, summary, links, complete, needsReview, appliedQuestionId, claimKey, expectedTaskVersion, key, ...args }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        const task = taskInScope(assigned, taskId);
        const assumptions = args.assumptions?.trim() || undefined;
        if (assumptions && assumptions.length > 8000) throw new ConvexError('Assumptions must be at most 8000 characters');
        if (complete && needsReview && !assumptions) throw new ConvexError('Describe the assumptions or judgment calls the user should check');
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            if ((previous.status === 'progress') === complete || previous.text !== summary || previous.appliedQuestionId !== appliedQuestionId ||
                previous.assumptions !== assumptions || JSON.stringify(previous.links) !== JSON.stringify(links)) {
                throw new ConvexError('Idempotency key already used');
            }
            return view(previous);
        }
        const questionId = appliedQuestionId ? ctx.db.normalizeId('taskWork', appliedQuestionId) : null;
        const question = questionId ? await ctx.db.get(questionId) : null;
        if (appliedQuestionId && (!question || question.userId !== userId || question.taskId !== taskId || question.assignmentId !== assignmentId ||
            !awaitsBot(question) || !claimKey || question.claimKey !== claimKey)) {
            throw new ConvexError('An active claim is required to apply this answer');
        }
        const role = await botRole(ctx, userId, taskId, assigned.label.id, assignmentId);
        if (complete && !role.execute) throw new ConvexError('This task is review-only for Grok Bot');
        if (complete) await requireNotDeferred(ctx, userId, taskId);
        if (complete && expectedTaskVersion !== task.updatedAt) throw new ConvexError('Task changed; read it again before reporting completion');
        const review = complete && !task.done && (!!needsReview || role.reviewRequired);
        if (complete && !task.done) {
            if (subtreeOf(assigned.items, taskId).slice(1).some(child => child.type !== 'task' || !assigned.tasks.has(child.id) || !child.done)) {
                throw new ConvexError('Finish the subtasks before completing this task');
            }
            const [waiting, answered, returned, reviews] = await Promise.all((['waiting', 'answered', 'returned', 'review'] as const).map(status =>
                taskDecisions(ctx, userId, taskId, status, { assignmentId })));
            if (reviews.length) throw new ConvexError('A completion for this task is already awaiting the user’s review; work on other tasks');
            if (waiting.length || [...answered, ...returned].some(row => row._id !== questionId)) throw new ConvexError('Resolve pending decisions before completing this task');
            if (!review) await ctx.runMutation(internal.mcpTasks.complete, { userId, taskId, clientName: 'Grok Bot' });
        }
        const status = review ? 'review' : complete ? 'complete' : 'progress';
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, key, text: summary, status, links, appliedQuestionId, assumptions });
        if (question) await ctx.db.patch(question._id, { status: question.status === 'returned' ? 'revised' : 'applied', claimKey: undefined, claimUntil: undefined });
        return { id, status };
    },
});

async function pendingReview(ctx: QueryCtx, id: Id<'taskWork'>, expectedUserId: string) {
    const userId = await currentUser(ctx, expectedUserId);
    const row = await ctx.db.get(id);
    if (!userId || row?.userId !== userId) throw new ConvexError('確認依頼が見つかりません。');
    const assigned = row.status === 'review' ? await taskAssignment(ctx, userId, row.taskId) : null;
    if (row.status === 'review' && (!assigned || assigned.assignmentId !== row.assignmentId)) throw new ConvexError('このタスクは現在の担当範囲にありません。');
    return { userId, row };
}

export const approveReview = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string() },
    handler: async (ctx, { id, expectedUserId }) => {
        const { userId, row } = await pendingReview(ctx, id, expectedUserId);
        if (row.status === 'approved') return;
        if (row.status !== 'review') throw new ConvexError('この確認依頼はすでに対応済みです。');
        const assigned = await requireScope(ctx, userId, row.assignmentId);
        const task = taskInScope(assigned, row.taskId);
        if (task.locked) throw new ConvexError('タスクがロックされています。ロックを外してから承認してください。');
        if (subtreeOf(assigned.items, task.id).slice(1).some(child => child.type !== 'task' || !assigned.tasks.has(child.id) || !child.done)) {
            throw new ConvexError('未完了のサブタスクがあるため完了できません。サブタスクを片付けるか、差し戻してください。');
        }
        await ctx.runMutation(internal.mcpTasks.complete, { userId, taskId: task.id, clientName: 'Grok Bot' });
        await ctx.db.patch(id, { status: 'approved', answeredAt: Date.now() });
    },
});

export const returnReview = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string(), comment: v.string() },
    handler: async (ctx, { id, expectedUserId, comment }) => {
        const { row } = await pendingReview(ctx, id, expectedUserId);
        const text = comment.trim();
        if (!text || text.length > 8000) throw new ConvexError('差し戻しの理由を1〜8000文字で入力してください。');
        if (row.status !== 'review') {
            if (row.status === 'returned' && row.answer === text) return;
            throw new ConvexError('この確認依頼はすでに対応済みです。');
        }
        const now = Date.now();
        await ctx.db.patch(id, { status: 'returned', answer: text, answeredAt: now });
        await queueWake(ctx, id, now);
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
        if (!userId || row?.userId !== userId || !awaitsBot(row)) throw new ConvexError('再通知できる依頼が見つかりません。');
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
        if (!row || !awaitsBot(row) || row.wakeAt !== wakeAt || !(await accountActive(ctx, row.userId))) return null;
        const assigned = await taskAssignment(ctx, row.userId, row.taskId);
        if (!assigned || assigned.assignmentId !== row.assignmentId) return null;
        const config = await connectionFor(ctx, row.userId, row.assignmentId);
        if (!config || ('_id' in config && !config.connectedAt)) return null;
        const webhook = webhookFor(config);
        return webhook ? { ...webhook, taskId: row.taskId, trigger: row.status === 'returned' ? 'review_returned' : 'reply' } : null;
    },
});

export const wakeResult = internalMutation({
    args: { ...wakeArgs, accepted: v.boolean() },
    handler: async (ctx, { id, wakeAt, accepted }) => {
        const row = await ctx.db.get(id);
        if (row?.wakeAt !== wakeAt || !awaitsBot(row)) return;
        await requireActiveAccount(ctx, row.userId);
        await ctx.db.patch(id, { wakeStatus: accepted ? 'accepted' : 'failed' });
    },
});

export const wake = internalAction({
    args: wakeArgs,
    handler: async (ctx, args) => {
        const target = await ctx.runQuery(internal.grokBot.wakeTarget, args);
        const accepted = !!target && await notifyBot(target, { trigger: target.trigger, task_id: target.taskId, question_id: args.id });
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

const scheduleArgs = { expectedUserId: v.string(), labelId: v.optional(v.string()), vp: v.optional(v.literal(true)) };

async function scheduleAssignment(ctx: QueryCtx, userId: string, labelId?: string, vp?: true) {
    if (vp) {
        const row = labelId === undefined ? await vpFor(ctx, userId) : null;
        return row ? { assignmentId: row._id, labelId: vpLabelId, vp: true } : null;
    }
    const pilot = pilotFor(userId);
    if (!labelId) return pilot ? { assignmentId: undefined, labelId: pilot.labelId } : null;
    const assignment = await assignmentFor(ctx, userId, labelId);
    if (assignment) return { assignmentId: assignment._id, labelId };
    return pilot?.labelId === labelId ? { assignmentId: undefined, labelId } : null;
}

export const schedule = query({
    args: scheduleArgs,
    handler: async (ctx, { expectedUserId, labelId, vp }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId, vp) : null;
        if (!userId || !target) return null;
        const [saved, timeZone] = await Promise.all([scheduleFor(ctx, userId, target.assignmentId), timezoneFor(ctx, userId)]);
        return { timeZone, enabled: saved?.enabled ?? false, time: saved?.time ?? '06:00',
            lastRunAt: saved?.lastRunAt, lastStatus: saved?.lastStatus };
    },
});

export const saveSchedule = mutation({
    args: { ...scheduleArgs, enabled: v.boolean(), time: v.string() },
    handler: async (ctx, { expectedUserId, labelId, vp, enabled, time }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId, vp) : null;
        if (!userId || !target || (!('vp' in target) && (await loadItem(ctx, userId, target.labelId))?.type !== 'section')) throw new ConvexError('Grok Botの担当ラベルが見つかりません。');
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
        const label = assignment && timeZone && !isVp(assignment) ? await loadItem(ctx, saved.userId, assignment.labelId) : null;
        if (!assignment || !timeZone || (!isVp(assignment) && label?.type !== 'section')) {
            await ctx.db.patch(saved._id, { nextCheckAt: undefined });
            continue;
        }
        const day = dateInTimeZone(timeZone, now);
        const shouldRun = assignment?.connectedAt && webhookFor(assignment) && dateInTimeZone(timeZone, saved.nextCheckAt) === day;
        const nextCheckAt = nextPatrol(saved.time, timeZone, now, shouldRun ? now : saved.nextCheckAt);
        await ctx.db.patch(saved._id, shouldRun
            ? { nextCheckAt, lastDay: day, lastRunAt: now, lastStatus: 'queued' }
            : { nextCheckAt });
        if (shouldRun) await ctx.scheduler.runAfter(0, internal.grokBot.runPatrol, { id: saved._id, at: now, labelId: assignment.labelId });
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
        const target = saved.assignmentId ? await ctx.db.get(saved.assignmentId) : pilotFor(saved.userId);
        if (target?.userId !== saved.userId || target.labelId !== labelId || ('_id' in target && !target.connectedAt) ||
            (!('role' in target && isVp(target)) && (await loadItem(ctx, saved.userId, labelId))?.type !== 'section')) return null;
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

/* ---------- Deferrals: adopted "not now" proposals, kept beside the Bot tables rather than in the synced Item ---------- */

const todayFor = async (ctx: QueryCtx, userId: string) => dateInTimeZone(await timezoneFor(ctx, userId) ?? 'UTC', Date.now());
const deferralRow = (ctx: QueryCtx, userId: string, taskId: string) =>
    ctx.db.query('grokBotDeferrals').withIndex('by_user_task', q => q.eq('userId', userId).eq('taskId', taskId)).unique();

/** The date a task stays hidden from Bots until, or null once that day has come in the user's time zone. */
async function deferral(ctx: QueryCtx, userId: string, taskId: string) {
    const row = await deferralRow(ctx, userId, taskId);
    return row && row.until > await todayFor(ctx, userId) ? row.until : null;
}

async function deferrals(ctx: QueryCtx, userId: string) {
    const rows = await ctx.db.query('grokBotDeferrals').withIndex('by_user', q => q.eq('userId', userId)).collect();
    const today = rows.length ? await todayFor(ctx, userId) : '';
    return new Map(rows.filter(row => row.until > today).map(row => [row.taskId, row.until]));
}

async function requireNotDeferred(ctx: QueryCtx, userId: string, taskId: string) {
    const until = await deferral(ctx, userId, taskId);
    if (until) throw new ConvexError(`The user deferred this task until ${until}; leave it until then`);
}

export const cancelDeferral = mutation({
    args: { expectedUserId: v.string(), taskId: v.string() },
    handler: async (ctx, { expectedUserId, taskId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) throw new ConvexError('サインインしてください。');
        const row = await deferralRow(ctx, userId, taskId);
        if (row) await ctx.db.delete(row._id);
    },
});

/* ---------- Proposals: Bot ideas that change nothing until the human adopts them ---------- */

type Proposal = Doc<'grokBotProposals'>;
const proposalKind = v.union(v.literal('delete'), v.literal('defer'), v.literal('move'), v.literal('new_task'));
const maxPendingProposals = 10;
const sameTitle = (a?: string, b?: string) => !!a && !!b && a.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') ===
    b.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
/** Two proposals carry the same idea: same kind and task, and for move the same label, for new_task the same title. */
const sameIdea = (a: Pick<Proposal, 'kind' | 'taskId' | 'labelId' | 'title'>, b: Pick<Proposal, 'kind' | 'taskId' | 'labelId' | 'title'>) =>
    a.kind === b.kind && a.taskId === b.taskId && (a.kind === 'move' ? a.labelId === b.labelId : a.kind === 'new_task' ? sameTitle(a.title, b.title) : true);

function proposalView(row: Proposal) {
    return { id: row._id, kind: row.kind, status: row.status, task_id: row.taskId, label_id: row.labelId, title: row.title, until: row.until,
        reason: row.reason, created_at: row._creationTime, resolved_at: row.resolvedAt };
}

const proposalsWith = (ctx: QueryCtx, userId: string, assignmentId: AssignmentId | undefined, status: Proposal['status']) =>
    ctx.db.query('grokBotProposals').withIndex('by_user_assignment_status', q => q.eq('userId', userId).eq('assignmentId', assignmentId).eq('status', status));

/** A Bot's pending proposals and its most recent outcomes, so it can learn what the user adopts. */
async function ownProposals(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const [pending, ...resolved] = await Promise.all([
        proposalsWith(ctx, userId, assignmentId, 'pending').collect(),
        ...(['adopted', 'dismissed', 'changed'] as const).map(status => proposalsWith(ctx, userId, assignmentId, status).order('desc').take(15)),
    ]);
    return [...pending, ...resolved.flat().sort((a, b) => b._creationTime - a._creationTime)].slice(0, 25).map(proposalView);
}

async function taskProposals(ctx: QueryCtx, userId: string, assignmentId: AssignmentId | undefined, taskId: string) {
    const rows = await Promise.all((['delete', 'defer', 'move'] as const).map(kind => ctx.db.query('grokBotProposals')
        .withIndex('by_user_kind_task', q => q.eq('userId', userId).eq('kind', kind).eq('taskId', taskId)).collect()));
    return rows.flat().filter(row => row.assignmentId === assignmentId).sort((a, b) => b._creationTime - a._creationTime).map(proposalView);
}

async function requireVp(ctx: QueryCtx, userId: string, assignmentId?: AssignmentId) {
    const row = assignmentId ? await ctx.db.get(assignmentId) : null;
    if (!row || row.userId !== userId || !isVp(row)) throw new ConvexError('The VP connection is unavailable');
    return row;
}

export const propose = internalMutation({
    args: { ...botScope, kind: proposalKind, taskId: v.optional(v.string()), labelId: v.optional(v.string()), title: v.optional(v.string()),
        note: v.optional(v.string()), until: v.optional(v.string()), reason: v.string(), key: v.string() },
    handler: async (ctx, { userId, assignmentId, kind, taskId, labelId, until, key, ...text }) => {
        const bot = assignmentId ? await ctx.db.get(assignmentId) : null;
        const vp = !!bot && bot.userId === userId && isVp(bot);
        const reason = text.reason.trim();
        const title = text.title?.trim() || undefined;
        const note = text.note?.trim() || undefined;
        const fields = { kind, taskId, labelId, title, note, until, reason };
        const previous = await ctx.db.query('grokBotProposals').withIndex('by_user_assignment_key', q =>
            q.eq('userId', userId).eq('assignmentId', assignmentId).eq('key', key)).unique();
        if (previous) {
            const signature = (row: Pick<Proposal, keyof typeof fields>) => JSON.stringify([row.kind, row.taskId, row.labelId, row.title, row.note, row.until, row.reason]);
            if (signature(previous) !== signature(fields)) throw new ConvexError('Idempotency key already used');
            return proposalView(previous);
        }
        if (!vp && kind !== 'delete' && kind !== 'defer') throw new ConvexError('Only the VP can propose move or new_task; a label Bot may propose delete or defer');
        if (!reason || reason.length > 2000) throw new ConvexError('The reason must be 1 to 2000 characters');
        if ((kind === 'new_task') === (taskId !== undefined)) throw new ConvexError(kind === 'new_task' ? 'new_task takes a title, not a task_id' : `${kind} needs a task_id`);
        if ((kind === 'move') !== (labelId !== undefined) && kind !== 'new_task') throw new ConvexError(kind === 'move' ? 'move needs a label_id' : 'label_id is only for move and new_task');
        if (kind === 'new_task' ? !title || title.length > 500 || (note?.length ?? 0) > 8000 : title !== undefined || note !== undefined) {
            throw new ConvexError(kind === 'new_task' ? 'new_task needs a title of 1 to 500 characters and a note of at most 8000' : 'title and note are only for new_task');
        }
        if ((kind === 'defer') !== (until !== undefined)) throw new ConvexError(kind === 'defer' ? 'defer needs until (YYYY-MM-DD)' : 'until is only for defer');

        // A label Bot is held to its own label; the VP may name any open task, label or unsorted.
        const scoped = vp ? null : await requireScope(ctx, userId, assignmentId);
        const items = scoped?.items ?? await loadItems(ctx, userId);
        const byId = new Map(items.map(item => [item.id, item]));
        let revision = {};
        if (taskId !== undefined) {
            const task = scoped ? taskInScope(scoped, taskId) : byId.get(taskId);
            if (task?.type !== 'task' || !task.text.trim()) throw new ConvexError('Task not found');
            if (!open(task)) throw new ConvexError('Task is already closed');
            if (kind === 'move' && (!unsorted(byId, task) || labelIn(byId, task))) throw new ConvexError('Only an unsorted root-level task can be moved into a label');
            if (kind === 'delete') {
                const current = snapshot(items, task.id)!;
                revision = { count: current.count, revision: current.revision };
            }
        }
        if (labelId !== undefined && byId.get(labelId)?.type !== 'section') throw new ConvexError('Label not found');
        if (until !== undefined) {
            if (!isDateString(until)) throw new ConvexError('until must be YYYY-MM-DD');
            const today = await todayFor(ctx, userId);
            if (until <= today) throw new ConvexError(`until must be after today (${today}) in the user’s time zone`);
            const current = await deferral(ctx, userId, taskId!);
            if (current) throw new ConvexError(`The task is already deferred until ${current}`);
        }

        const related = await ctx.db.query('grokBotProposals').withIndex('by_user_kind_task', q => q.eq('userId', userId).eq('kind', kind).eq('taskId', taskId)).collect();
        if (related.some(row => row.status === 'pending' && row.assignmentId === assignmentId && (kind !== 'new_task' || sameIdea(row, fields)))) {
            throw new ConvexError(kind === 'new_task' ? 'The same new task is already proposed' : `A ${kind} proposal for this task is already pending`);
        }
        if (related.some(row => row.status === 'dismissed' && sameIdea(row, fields))) {
            throw new ConvexError('The user already dismissed this proposal; do not propose it again');
        }
        if ((await proposalsWith(ctx, userId, assignmentId, 'pending').take(maxPendingProposals)).length >= maxPendingProposals) {
            throw new ConvexError(`You already have ${maxPendingProposals} pending proposals; wait for the user to decide`);
        }
        const id = await ctx.db.insert('grokBotProposals', { userId, assignmentId, key, ...fields, ...revision, status: 'pending' });
        return proposalView((await ctx.db.get(id))!);
    },
});

/** Pending proposals for the inbox. They never count toward the inbox number. */
async function proposalInbox(ctx: QueryCtx, userId: string) {
    const rows = await ctx.db.query('grokBotProposals').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', 'pending')).collect();
    if (!rows.length) return [];
    const [items, bots] = await Promise.all([loadItems(ctx, userId), ctx.db.query('grokBotAssignments').withIndex('by_user', q => q.eq('userId', userId)).collect()]);
    const byId = new Map(items.map(item => [item.id, item]));
    const botById = new Map(bots.map(bot => [bot._id, bot]));
    const pilot = pilotFor(userId);
    return rows.flatMap(row => {
        const bot = row.assignmentId ? botById.get(row.assignmentId) : pilot;
        if (!bot) return [];
        const vp = '_id' in bot && isVp(bot);
        const task = row.taskId ? byId.get(row.taskId) : undefined;
        const target = row.labelId ? byId.get(row.labelId) : undefined;
        return [{ id: row._id, kind: row.kind, vp, proposer: vp ? 'VP' : byId.get(bot.labelId)?.text.trim() || 'ラベル',
            taskId: row.taskId, taskTitle: task?.type === 'task' ? task.text : undefined, taskOpen: task?.type === 'task' && open(task),
            labelId: row.labelId, labelName: target?.type === 'section' ? target.text.trim() || 'ラベル' : undefined,
            title: row.title, note: row.note, until: row.until, reason: row.reason, count: row.count, createdAt: row._creationTime }];
    }).sort((a, b) => a.createdAt - b.createdAt);
}

async function ownProposal(ctx: QueryCtx, id: Id<'grokBotProposals'>, expectedUserId: string) {
    const userId = await currentUser(ctx, expectedUserId);
    const row = await ctx.db.get(id);
    if (!userId || row?.userId !== userId) throw new ConvexError('提案が見つかりません。');
    return { userId, row };
}

/** Apply an adopted proposal in this transaction. false when its target changed since it was proposed. */
async function applyProposal(ctx: MutationCtx, userId: string, row: Proposal): Promise<false | { createdTaskId?: string }> {
    const items = await loadItems(ctx, userId);
    const byId = new Map(items.map(item => [item.id, item]));
    const task = row.taskId ? byId.get(row.taskId) : undefined;
    const label = row.labelId ? byId.get(row.labelId) : undefined;
    switch (row.kind) {
        case 'delete': {
            const current = row.taskId ? snapshot(items, row.taskId) : null;
            if (!current || !open(task) || current.revision !== row.revision || current.count !== row.count) return false;
            await ctx.runMutation(internal.mcpTasks.remove, { userId, taskId: row.taskId!, expectedText: current.text, expectedCount: current.count });
            return {};
        }
        case 'defer': {
            if (task?.type !== 'task' || !open(task) || !row.until || row.until <= await todayFor(ctx, userId)) return false;
            const existing = await deferralRow(ctx, userId, task.id);
            if (existing) await ctx.db.patch(existing._id, { until: row.until, proposalId: row._id });
            else await ctx.db.insert('grokBotDeferrals', { userId, taskId: task.id, until: row.until, proposalId: row._id });
            return {};
        }
        case 'move': {
            if (task?.type !== 'task' || !open(task) || !unsorted(byId, task) || label?.type !== 'section') return false;
            await ctx.runMutation(internal.mcpTasks.move, { userId, taskId: task.id, labelId: label.id });
            return {};
        }
        case 'new_task': {
            if ((row.labelId && label?.type !== 'section') || !row.title) return false;
            const created: unknown = await ctx.runMutation(internal.mcpTasks.add, { userId, text: row.title, note: row.note, parentId: row.labelId,
                idempotencyKey: `grok-bot-proposal:${row._id}`, clientName: 'Grok Bot VP' });
            return { createdTaskId: created && typeof created === 'object' && 'id' in created && typeof created.id === 'string' ? created.id : undefined };
        }
    }
}

export const adoptProposal = mutation({
    args: { id: v.id('grokBotProposals'), expectedUserId: v.string() },
    handler: async (ctx, { id, expectedUserId }): Promise<{ status: 'adopted' | 'changed' }> => {
        const { userId, row } = await ownProposal(ctx, id, expectedUserId);
        if (row.status === 'adopted' || row.status === 'changed') return { status: row.status };
        if (row.status !== 'pending') throw new ConvexError('この提案はすでに見送りました。');
        const applied = await applyProposal(ctx, userId, row);
        const status = applied ? 'adopted' : 'changed';
        await ctx.db.patch(id, { status, resolvedAt: Date.now(), ...(applied ? applied : {}) });
        return { status };
    },
});

export const dismissProposal = mutation({
    args: { id: v.id('grokBotProposals'), expectedUserId: v.string() },
    handler: async (ctx, { id, expectedUserId }) => {
        const { row } = await ownProposal(ctx, id, expectedUserId);
        if (row.status === 'dismissed') return;
        if (row.status !== 'pending') throw new ConvexError('この提案はすでに対応済みです。');
        await ctx.db.patch(id, { status: 'dismissed', resolvedAt: Date.now() });
    },
});

/* ---------- VP read: every open task across labels and 未仕分け, read-only ---------- */

export const allTasks = internalQuery({
    args: { userId: v.string(), assignmentId: v.id('grokBotAssignments'), taskId: v.optional(v.string()), offset: v.optional(v.number()) },
    handler: async (ctx, { userId, assignmentId, taskId, offset = 0 }) => {
        await requireVp(ctx, userId, assignmentId);
        const [items, assignments, delegations, deferred] = await Promise.all([loadItems(ctx, userId), labelAssignments(ctx, userId),
            ctx.db.query('grokBotDelegations').withIndex('by_user', q => q.eq('userId', userId)).collect(), deferrals(ctx, userId)]);
        const byId = new Map(items.map(item => [item.id, item]));
        const pilot = pilotFor(userId);
        const botOf = (labelId: string) => {
            const assignment = assignments.find(row => row.labelId === labelId);
            return assignment ? webhookFor(assignment) ? { assignmentId: assignment._id } : null : pilot?.labelId === labelId ? { assignmentId: undefined } : null;
        };
        const placeOf = (task: Item) => {
            const label = labelIn(byId, task);
            const bot = label ? botOf(label.id) : null;
            const delegation = delegations.find(row => row.taskId === task.id);
            const execute = !!label && !!bot && delegation?.labelId === label.id && delegation.assignmentId === bot.assignmentId;
            return { label_id: label?.id ?? null, label: label?.text ?? null, unsorted: !label && unsorted(byId, task),
                bot_role: bot ? execute ? 'execute' : 'review' : null, review_required: execute && !!delegation?.reviewCompletion };
        };
        if (taskId) {
            const task = byId.get(taskId);
            if (task?.type !== 'task' || !task.text.trim()) throw new ConvexError('Task not found');
            const place = placeOf(task);
            const subtasks = subtreeOf(items, taskId).slice(1).filter(item => item.type === 'task');
            return { task: await toView(ctx, userId, task, place.label ?? undefined, subtasks), task_version: task.updatedAt, ...place,
                deferred_until: deferred.get(taskId) ?? null, work: (await history(ctx, userId, taskId)).map(view),
                proposals: await taskProposals(ctx, userId, assignmentId, taskId) };
        }
        const statusRows = (status: Work['status']) => ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', status)).collect();
        const [waiting, reviews] = await Promise.all([statusRows('waiting'), statusRows('review')]);
        const counts = (rows: Work[]) => rows.reduce((map, row) => map.set(row.taskId, (map.get(row.taskId) ?? 0) + 1), new Map<string, number>());
        const [awaitingReply, awaitingReview] = [counts(waiting), counts(reviews)];
        const openTasks = items.filter(item => item.type === 'task' && open(item));
        const tasks = openTasks.filter(task => !deferred.has(task.id));
        const page = tasks.slice(offset, offset + 50);
        return {
            labels: items.filter(item => item.type === 'section').map(label => ({ id: label.id, name: label.text, has_bot: !!botOf(label.id) })),
            tasks: page.map(task => ({ id: task.id, title: task.text, parent_id: task.parentId && byId.has(task.parentId) ? task.parentId : null,
                ...placeOf(task), locked: !!task.locked, due_date: task.dueDate, due_time: task.dueTime,
                awaiting_reply: awaitingReply.get(task.id) ?? 0, awaiting_review: awaitingReview.get(task.id) ?? 0 })),
            deferred_tasks: openTasks.length - tasks.length,
            next_offset: offset + page.length < tasks.length ? offset + page.length : null,
            proposals: await ownProposals(ctx, userId, assignmentId),
        };
    },
});
