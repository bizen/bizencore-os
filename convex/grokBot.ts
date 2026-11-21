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
import { commitShaPattern, median, pullRequest } from '../src/lib/grokBotWork';
import { maxClockIns, nextClockIn, normalizeClockInTimes } from '../src/lib/grokBotSchedule';

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

type BotMode = 'review' | 'challenge' | 'checked' | 'execute';
/** Rows saved before modes existed: a delegation executes, with reviewCompletion it is checked. */
const modeOf = (delegation: Pick<Doc<'grokBotDelegations'>, 'mode' | 'reviewCompletion'>): BotMode =>
    delegation.mode ?? (delegation.reviewCompletion ? 'checked' : 'execute');
const roleFor = (mode: BotMode) => ({ mode, execute: mode === 'execute' || mode === 'checked', reviewRequired: mode === 'checked' });

/** A label's default mode; the pilot and a missing assignment review. */
async function defaultModeFor(ctx: QueryCtx, assignmentId?: AssignmentId): Promise<BotMode> {
    return (assignmentId ? (await ctx.db.get(assignmentId))?.defaultMode : undefined) ?? 'review';
}

/** A task's own override wins; otherwise it inherits its label Bot's default mode. */
async function botRole(ctx: QueryCtx, userId: string, taskId: string, labelId: string, assignmentId?: AssignmentId) {
    const delegation = await delegationFor(ctx, userId, taskId);
    const override = delegation?.labelId === labelId && delegation.assignmentId === assignmentId;
    return { ...roleFor(override ? modeOf(delegation) : await defaultModeFor(ctx, assignmentId)), inherited: !override };
}

async function taskDecisions(ctx: QueryCtx, userId: string, taskId: string, status: Work['status'], forBot?: { assignmentId?: AssignmentId }) {
    const rows = await ctx.db.query('taskWork').withIndex('by_user_task_status', q => q.eq('userId', userId).eq('taskId', taskId).eq('status', status)).collect();
    return forBot ? rows.filter(row => row.assignmentId === forBot.assignmentId) : rows;
}

/** Rows with a headline are cards; older rows keep plain string options, normalized here to labels. */
function view(row: Work) {
    const options = row.options?.map(option => typeof option === 'string' ? { label: option } : option);
    return { id: row._id, status: row.status, headline: row.headline, text: row.text, links: row.links, answer: row.answer,
        createdAt: row._creationTime, answeredAt: row.answeredAt, wakeAt: row.wakeAt, wakeStatus: row.wakeStatus,
        kind: row.kind, options, recommendation: row.recommendation, recommendationReason: row.recommendationReason, confidence: row.confidence,
        irreversible: row.irreversible || options?.some(option => 'irreversible' in option && option.irreversible) || undefined,
        checks: row.checks, evidence: row.evidence, assumptions: row.assumptions,
        prUrl: row.prUrl, prHeadSha: row.prHeadSha, mergedAt: row.mergedAt,
        artifactKind: row.artifactKind, rejectionReason: row.rejectionReason, spawnedTaskId: row.spawnedTaskId };
}

/** Rows that stay in a history beyond the recent page: anything the human or the Bot still has to act on. */
const openStatuses = ['waiting', 'answered', 'review', 'returned', 'merging'] as const;

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
    const [waiting, reviews, answered, returned, merging] = await Promise.all([rowsFor('waiting'), rowsFor('review'),
        includeAnswered ? rowsFor('answered') : none, includeAnswered ? rowsFor('returned') : none, includeAnswered ? rowsFor('merging') : none]);
    if (!waiting.length && !reviews.length && !answered.length && !returned.length && !merging.length) return { pending: [], answered: [] };
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
    const delegationByTask = new Map(delegations.map(row => [row.taskId, row]));
    const modeForTask = (taskId: string, labelId: string, assignmentId?: AssignmentId): BotMode => {
        const delegation = delegationByTask.get(taskId);
        return delegation?.labelId === labelId && delegation.assignmentId === assignmentId ? modeOf(delegation)
            : assignments.find(candidate => candidate._id === assignmentId)?.defaultMode ?? 'review';
    };
    const stalledLabels = new Map<string, boolean>();
    const stalled = (labelId: string, assignmentId?: AssignmentId) => {
        const known = stalledLabels.get(labelId);
        if (known !== undefined) return known;
        const executable = items.filter(task =>
            task.type === 'task' && open(task) && labelOf(task)?.id === labelId &&
            roleFor(modeForTask(task.id, labelId, assignmentId)).execute);
        const result = executable.length > 0 && executable.every(task => blocked.has(`${labelId}:${task.id}`));
        stalledLabels.set(labelId, result);
        return result;
    };
    const ordered = pending.map(row => ({ ...row, botMode: modeForTask(row.taskId, row.labelId, row.assignmentId), stalled: stalled(row.labelId, row.assignmentId), openTasks: openTasksIn(row.taskId) }))
        .sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.openTasks - a.openTasks || a.createdAt - b.createdAt);
    return { pending: ordered, answered: placed([...answered, ...returned, ...merging]).sort((a, b) => a.createdAt - b.createdAt) };
}

const dayMs = 86_400_000;
/** Decisions and reviews resolved approved (a merged PR completes through its own complete row) or returned. */
const approvedStatuses = new Set<Work['status']>(['approved', 'merging', 'merged', 'superseded']);
const returnedStatuses = new Set<Work['status']>(['returned', 'revised']);

/**
 * Outcomes over the last 7 days (today and the 6 days before, in the user's time zone), from existing rows only.
 * Rows without the timestamps a figure needs (older rows) are left out of that figure.
 */
export async function workMetrics(ctx: QueryCtx, userId: string, now = Date.now()) {
    const timeZone = await timezoneFor(ctx, userId) ?? 'UTC';
    const today = dateInTimeZone(timeZone, now);
    const startOf = (day: string) => deadlineInstant(day, '00:00', timeZone) ?? Date.parse(`${day}T00:00:00Z`);
    const todayStart = startOf(today);
    const weekStart = startOf(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * dayMs).toISOString().slice(0, 10));
    const [answered, completed, rejections] = await Promise.all([
        ctx.db.query('taskWork').withIndex('by_user_answered', q => q.eq('userId', userId).gte('answeredAt', weekStart)).collect(),
        ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', 'complete').gte('_creationTime', weekStart)).collect(),
        ctx.db.query('taskRejections').withIndex('by_user_rejected', q => q.eq('userId', userId).gte('rejectedAt', weekStart)).collect(),
    ]);
    const rejected = rejections.filter(row => row.rejectedAt <= now);
    const resolved = answered.filter(row => row.answeredAt !== undefined && row.answeredAt <= now && row.answeredAt >= row._creationTime);
    const reviewed = resolved.filter(row => approvedStatuses.has(row.status) || returnedStatuses.has(row.status));
    const returned = reviewed.filter(row => returnedStatuses.has(row.status)).length;
    // Moved forward: direct and merged completions (their complete row) plus non-PR reviews, which complete on approval.
    const forward = [...completed.filter(row => row._creationTime <= now).map(row => row._creationTime),
        ...resolved.filter(row => row.status === 'approved').map(row => row.answeredAt!)];
    return {
        medianAnswerMs: median(resolved.map(row => row.answeredAt! - row._creationTime)), answered: resolved.length,
        returnRate: reviewed.length ? returned / reviewed.length : null, returned, reviewed: reviewed.length,
        forwardWeek: forward.length, forwardToday: forward.filter(at => at >= todayStart).length,
        rejectedWeek: rejected.length, rejectedToday: rejected.filter(row => row.rejectedAt >= todayStart).length,
        spawnedWeek: rejected.filter(row => row.spawnedTaskId !== undefined).length,
    };
}

/** What the Bots finished over the last 72 hours, newest first, one row per task (a merged PR also leaves a complete row). */
async function recentCompletions(ctx: QueryCtx, userId: string, now: number, limit = 15) {
    const since = now - 3 * dayMs;
    const [completed, resolved] = await Promise.all([
        ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', 'complete').gte('_creationTime', since)).collect(),
        ctx.db.query('taskWork').withIndex('by_user_answered', q => q.eq('userId', userId).gte('answeredAt', since)).collect(),
    ]);
    const finished = [
        ...completed.map(row => ({ row, completedAt: row._creationTime })),
        ...resolved.filter(row => row.status === 'approved' || row.status === 'merged').map(row => ({ row, completedAt: row.mergedAt ?? row.answeredAt! })),
    ].filter(({ completedAt }) => completedAt >= since && completedAt <= now).sort((a, b) => b.completedAt - a.completedAt);
    if (!finished.length) return [];
    const byId = new Map((await loadItems(ctx, userId)).map(item => [item.id, item]));
    const seen = new Set<string>();
    const rows = [];
    for (const { row, completedAt } of finished) {
        const task = byId.get(row.taskId);
        if (!task || seen.has(row.taskId)) continue;
        seen.add(row.taskId);
        const label = labelIn(byId, task);
        rows.push({ id: row._id, taskId: row.taskId, title: task.text, label: label?.text ?? null, labelId: label?.id ?? null, headline: row.headline ?? null,
            summary: row.text, links: row.links ?? [], prUrl: row.prUrl ?? null, prHeadSha: row.prHeadSha ?? null, completedAt, status: row.status });
        if (rows.length === limit) break;
    }
    return rows;
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
            webhookConfigured: true, connected: true, managed: false, skin: undefined, defaultMode: 'review' as BotMode,
        }] : [])];
    },
});

function assignmentView(row: Doc<'grokBotAssignments'>, skin?: string) {
    return { id: row._id, labelId: row.labelId, name: row.name ?? 'Grok Bot', connectorName: row.connectorName, connectorConnected: !!row.connectedAt,
        webhookConfigured: !!webhookFor(row), connected: !!row.connectedAt && !!webhookFor(row), managed: true, skin, defaultMode: row.defaultMode ?? 'review' };
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
        const [proposals, metrics, nextPatrol, rejections, norms] = await Promise.all([proposalInbox(ctx, userId), workMetrics(ctx, userId),
            nextLabelPatrol(ctx, userId), recentRejections(ctx, userId), normViews(ctx, userId)]);
        const completions = await recentCompletions(ctx, userId, Date.now());
        return { ...(officer ?? { pending: [], answered: [] }), proposals, metrics, nextPatrolAt: nextPatrol?.at ?? null, nextPatrol, rejections, norms,
            recentCompletions: completions };
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
            canReply: !!assigned, mayExecute: !!role?.execute, reviewRequired: !!role?.reviewRequired, botMode: role?.mode ?? 'review', deferredUntil };
    },
});

const botModeArg = v.union(v.literal('review'), v.literal('challenge'), v.literal('checked'), v.literal('execute'));

export const setDelegation = mutation({
    // mode wins when given; older callers still send execute and reviewCompletion.
    args: { expectedUserId: v.string(), taskId: v.string(), execute: v.boolean(), reviewCompletion: v.optional(v.boolean()), mode: v.optional(botModeArg) },
    handler: async (ctx, { expectedUserId, taskId, execute, reviewCompletion, mode: requested }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const assigned = userId ? await taskAssignment(ctx, userId, taskId) : null;
        if (!userId || !assigned) throw new ConvexError('現在の担当範囲にあるタスクを選んでください。');
        const mode = requested ?? (execute ? reviewCompletion ? 'checked' : 'execute' : 'review');
        const existing = await delegationFor(ctx, userId, taskId);
        const role = { labelId: assigned.label.id, assignmentId: assigned.assignmentId, reviewCompletion: mode === 'checked' || undefined, mode };
        // The label default needs no row; any other mode, review included, is the task's own override.
        const inherits = mode === await defaultModeFor(ctx, assigned.assignmentId);
        if (!inherits && existing) await ctx.db.patch(existing._id, role);
        else if (!inherits) await ctx.db.insert('grokBotDelegations', { userId, taskId, ...role });
        else if (existing) await ctx.db.delete(existing._id);
    },
});

async function requireLabelBot(ctx: QueryCtx, expectedUserId: string, labelId: string) {
    const { userId, label } = await requireLabel(ctx, expectedUserId, labelId);
    const assignment = await assignmentFor(ctx, userId, label.id);
    if (!assignment) throw new ConvexError('このラベルにはBotが割り当てられていません。');
    return { userId, label, assignment };
}

export const setAssignmentDefaultMode = mutation({
    args: { expectedUserId: v.string(), labelId: v.string(), defaultMode: botModeArg },
    handler: async (ctx, { expectedUserId, labelId, defaultMode }) => {
        const { assignment } = await requireLabelBot(ctx, expectedUserId, labelId);
        await ctx.db.patch(assignment._id, { defaultMode });
    },
});

/* ---------- Bot社員: every Bot employee with its posture, clock-ins and open work ---------- */

export const team = query({
    args: { expectedUserId: v.string() },
    handler: async (ctx, { expectedUserId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) return null;
        const [labels, vpRow] = await Promise.all([labelAssignments(ctx, userId), vpFor(ctx, userId)]);
        if (!labels.length && !vpRow && !pilotFor(userId)) return null;
        const bots = vpRow ? [...labels, vpRow] : labels;
        const rowsFor = (status: Work['status']) => ctx.db.query('taskWork').withIndex('by_user_status', q => q.eq('userId', userId).eq('status', status)).collect();
        const [items, skins, schedules, delegations, deferred, completions, waiting, review, answered, merging] = await Promise.all([
            loadItems(ctx, userId), ctx.db.query('grokBotSkins').withIndex('by_user', q => q.eq('userId', userId)).collect(),
            ctx.db.query('grokBotSchedules').withIndex('by_user', q => q.eq('userId', userId)).collect(),
            ctx.db.query('grokBotDelegations').withIndex('by_user', q => q.eq('userId', userId)).collect(),
            deferrals(ctx, userId), recentCompletions(ctx, userId, Date.now(), Infinity),
            rowsFor('waiting'), rowsFor('review'), rowsFor('answered'), rowsFor('merging'),
        ]);
        const byId = new Map(items.map(item => [item.id, item]));
        const children = new Map<string, Item[]>();
        for (const item of items) {
            if (item.type !== 'task' || !item.parentId) continue;
            children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
        }
        const tally = (rows: Work[]) => {
            const counts = new Map<string, number>();
            for (const row of rows) counts.set(`${row.assignmentId}:${row.taskId}`, (counts.get(`${row.assignmentId}:${row.taskId}`) ?? 0) + 1);
            return (assignmentId: AssignmentId, taskId: string) => counts.get(`${assignmentId}:${taskId}`) ?? 0;
        };
        const [waitingOf, reviewOf, answeredOf, mergingOf] = [tally(waiting), tally(review), tally(answered), tally(merging)];
        const employees = bots.map(row => {
            const vp = isVp(row);
            const defaultMode: BotMode = row.defaultMode ?? 'review';
            const saved = schedules.find(schedule => schedule.assignmentId === row._id);
            const label = vp ? null : byId.get(row.labelId);
            const open_: Item[] = [];
            const pending = label?.type === 'section' ? [...(children.get(label.id) ?? [])] : [];
            for (const seen = new Set<string>(); pending.length;) {
                const task = pending.pop()!;
                if (seen.has(task.id)) continue;
                seen.add(task.id);
                if (open(task) && !deferred.has(task.id)) open_.push(task);
                pending.push(...(children.get(task.id) ?? []));
            }
            // Tasks waiting on the human first, then in the order they were written.
            const blocked = (task: Item) => waitingOf(row._id, task.id) + reviewOf(row._id, task.id) > 0;
            open_.sort((a, b) => Number(blocked(b)) - Number(blocked(a)) || a.createdAt - b.createdAt || a.order - b.order);
            const tasks = open_.map(task => {
                const delegation = delegations.find(candidate => candidate.taskId === task.id && candidate.labelId === row.labelId && candidate.assignmentId === row._id);
                return { id: task.id, title: task.text, dueDate: task.dueDate, dueTime: task.dueTime, botMode: delegation ? modeOf(delegation) : defaultMode,
                    inherited: !delegation, waiting: waitingOf(row._id, task.id), review: reviewOf(row._id, task.id),
                    answered: answeredOf(row._id, task.id), merging: mergingOf(row._id, task.id) };
            });
            return {
                id: row._id, labelId: row.labelId, labelName: vp ? 'VP' : label?.text.trim() || 'ラベル', name: row.name ?? 'Grok Bot',
                skin: skins.find(skin => skin.assignmentId === row._id)?.image, connected: !!row.connectedAt && !!webhookFor(row), vp, defaultMode,
                schedule: { enabled: saved?.enabled ?? false, times: saved ? clockInsOf(saved) : ['06:00'], nextCheckAt: saved?.nextCheckAt ?? null,
                    lastRunAt: saved?.lastRunAt ?? null, lastStatus: saved?.lastStatus ?? null },
                counts: { openTasks: tasks.length, waiting: tasks.reduce((sum, task) => sum + task.waiting, 0), review: tasks.reduce((sum, task) => sum + task.review, 0),
                    completedRecent: vp ? 0 : completions.filter(done => done.labelId === row.labelId).length },
                tasks: vp ? [] : tasks.slice(0, 40),
            };
        });
        return { employees };
    },
});

/** 成し遂げたいこと: the user hands a Bot a goal as a task in its label, optionally with its own mode and an immediate clock-in. */
export const assignGoalToBot = mutation({
    args: { expectedUserId: v.string(), labelId: v.string(), title: v.string(), note: v.optional(v.string()), mode: v.optional(botModeArg), runNow: v.optional(v.boolean()) },
    handler: async (ctx, { expectedUserId, labelId, mode, runNow, ...args }) => {
        const title = args.title.trim();
        const note = args.note?.trim() || undefined;
        if (!title || title.length > 500) throw new ConvexError('成し遂げたいことを1〜500文字で入力してください。');
        if (note && note.length > 8000) throw new ConvexError('メモは8000文字以内で入力してください。');
        const { userId, label, assignment } = await requireLabelBot(ctx, expectedUserId, labelId);
        const created: unknown = await ctx.runMutation(internal.mcpTasks.add, {
            userId, text: title, note, parentId: label.id, createdBy: 'user',
            idempotencyKey: `goal:${await hashToken(`${userId}:${label.id}:${Date.now()}:${title.slice(0, 32)}`)}`,
        });
        if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') throw new ConvexError('タスクを作成できませんでした。');
        const taskId = created.id;
        if (mode && mode !== (assignment.defaultMode ?? 'review')) {
            await ctx.db.insert('grokBotDelegations', { userId, taskId, labelId: label.id, assignmentId: assignment._id, mode, reviewCompletion: mode === 'checked' || undefined });
        }
        if (runNow && assignment.connectedAt && webhookFor(assignment)) {
            const at = Date.now();
            const saved = await scheduleFor(ctx, userId, assignment._id);
            const id = saved ? saved._id : await ctx.db.insert('grokBotSchedules', { userId, assignmentId: assignment._id, enabled: false, time: '06:00', savedAt: at });
            await ctx.db.patch(id, { lastRunAt: at, lastStatus: 'queued' });
            await ctx.scheduler.runAfter(0, internal.grokBot.runPatrol, { id, at, labelId: label.id, manual: true });
        }
        return { taskId };
    },
});

export const assignedTasks = internalQuery({
    args: { ...botScope, taskId: v.optional(v.string()), offset: v.optional(v.number()) },
    handler: async (ctx, { userId, assignmentId, taskId, offset = 0 }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        const roleOf = async (id: string) => {
            const role = await botRole(ctx, userId, id, assigned.label.id, assignmentId);
            return { bot_role: role.execute ? 'execute' : 'review', bot_mode: role.mode, review_required: role.reviewRequired };
        };
        const context = await botContext(ctx, userId, assigned.label.id);
        if (taskId) {
            const task = taskInScope(assigned, taskId);
            const subtasks = subtreeOf([...assigned.tasks.values()], taskId).slice(1);
            return { task: await toView(ctx, userId, task, assigned.label.text, subtasks), task_version: task.updatedAt,
                ...await roleOf(task.id), deferred_until: await deferral(ctx, userId, taskId),
                work: (await history(ctx, userId, taskId, { assignmentId })).map(view), proposals: await taskProposals(ctx, userId, assignmentId, taskId), ...context };
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
            approved_to_merge: await count(task.id, 'merging'),
        }))), next_offset: offset + page.length < tasks.length ? offset + page.length : null,
        proposals: await ownProposals(ctx, userId, assignmentId), ...context };
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

/** An answered decision, a returned review or an approved pull request: the human acted and the Bot has yet to apply it. */
const awaitsBot = (row: Work) => row.status === 'answered' || row.status === 'returned' || row.status === 'merging';

function priorWork(ctx: QueryCtx, userId: string, taskId: string, key: string, assignmentId?: AssignmentId) {
    return ctx.db.query('taskWork').withIndex('by_user_task_key_assignment', q =>
        q.eq('userId', userId).eq('taskId', taskId).eq('key', key).eq('assignmentId', assignmentId)).unique();
}

const decisionKind = v.union(v.literal('approval'), v.literal('choice'), v.literal('info'), v.literal('challenge'));
const artifactKind = v.union(v.literal('mock'), v.literal('analysis'), v.literal('counterargument'), v.literal('pr'));
const confidence = v.union(v.literal('high'), v.literal('medium'), v.literal('low'));
// Lenient validators so a missing field reaches decisionCard, which names every problem at once.
const decisionArgs = {
    kind: v.optional(decisionKind), headline: v.optional(v.string()), context: v.optional(v.string()),
    options: v.optional(v.array(v.object({ label: v.string(), consequence: v.optional(v.string()), irreversible: v.optional(v.boolean()) }))),
    recommendation: v.optional(v.object({ option: v.optional(v.string()), reason: v.optional(v.string()), confidence: v.optional(confidence) })),
    checks: v.optional(v.array(v.string())), evidence: v.optional(v.array(v.object({ url: v.string(), title: v.optional(v.string()) }))),
    artifactKind: v.optional(artifactKind),
};
type DecisionInput = { [K in keyof typeof decisionArgs]?: (typeof decisionArgs)[K]['type'] };

/** A trimmed required text; a missing or too long value adds a problem that says what to write. */
function cardText(problems: string[], name: string, value: string | undefined, max: number, what: string) {
    const text = value?.trim() ?? '';
    if (!text) problems.push(`${name} is missing: ${what}`);
    else if (text.length > max) problems.push(`${name} is ${text.length} characters, at most ${max}: ${what}`);
    return text;
}

function cardChecks(problems: string[], checks: string[] | undefined) {
    const trimmed = (checks ?? []).map((check, i) => cardText(problems, `checks[${i}]`, check, 120, 'one thing the user must actually look at'));
    if (trimmed.length < 1 || trimmed.length > 3) problems.push('checks must list 1 to 3 things the user must actually look at before deciding (not generic advice)');
    return trimmed;
}

/** Quality at the source: an incomplete card is rejected with every problem named, so the Bot rewrites it in one pass. */
function decisionCard({ kind = 'info', ...input }: DecisionInput) {
    const problems: string[] = [];
    const headline = cardText(problems, 'headline', input.headline, 80, 'one line saying what is being decided');
    const context = cardText(problems, 'context', input.context, 400, 'why this needs deciding now, with the background the user needs');
    const options = (input.options ?? []).map((option, i) => ({
        label: cardText(problems, `options[${i}].label`, option.label, 60, 'a short answer the user can pick'),
        consequence: cardText(problems, `options[${i}].consequence`, option.consequence, 200, 'what concretely happens if the user picks it'),
        ...(option.irreversible ? { irreversible: true } : {}),
    }));
    if (kind === 'info' ? options.length > 0 : kind === 'approval' ? options.length !== 2 : options.length < 2 || options.length > 4) {
        problems.push(kind === 'info' ? 'options must be omitted for kind info (the user writes the answer); use kind choice to offer answers'
            : kind === 'approval' ? 'options must be exactly 2 for kind approval: approve and reject, each with its consequence'
            : `options must be 2 to 4 for kind ${kind}${kind === 'challenge' ? ' (for example kill, pivot, greenlight)' : ''}`);
    }
    if (new Set(options.map(option => option.label)).size !== options.length) problems.push('options labels must be distinct');
    const { recommendation } = input;
    const recommended = recommendation?.option?.trim();
    let reason: string | undefined;
    if (kind === 'info') {
        if (recommendation) problems.push('recommendation must be omitted for kind info');
    } else if (!recommendation) {
        problems.push('recommendation is missing: { option: one of the option labels, reason, confidence: high, medium or low }');
    } else {
        if (!options.some(option => option.label === recommended)) problems.push('recommendation.option must equal one of the option labels');
        reason = cardText(problems, 'recommendation.reason', recommendation.reason, 200, 'why you recommend that option');
        if (!recommendation.confidence) problems.push('recommendation.confidence is missing: high, medium or low');
    }
    const checks = cardChecks(problems, input.checks);
    const evidence = input.evidence?.map(({ url, title }) => ({ url: url.trim(), ...(title?.trim() ? { title: title.trim() } : {}) }));
    if (evidence && (evidence.length > 8 || evidence.some(link => !/^https:\/\/\S+$/.test(link.url) || link.url.length > 4096 || (link.title?.length ?? 0) > 80))) {
        problems.push('evidence takes at most 8 HTTPS links, each with an optional title of at most 80 characters');
    }
    if (problems.length) throw new ConvexError(`Rewrite the decision card and resubmit: ${problems.join('; ')}.`);
    return { kind, headline, text: context, options: options.length ? options : undefined,
        recommendation: recommended, recommendationReason: reason, confidence: recommendation?.confidence,
        irreversible: options.some(option => option.irreversible) || undefined, checks, evidence: evidence?.length ? evidence : undefined,
        artifactKind: input.artifactKind };
}

const cardSignature = (row: Pick<Work, 'kind' | 'headline' | 'text' | 'options' | 'recommendation' | 'recommendationReason' | 'confidence' | 'checks' | 'evidence' | 'artifactKind'>) =>
    JSON.stringify([row.kind ?? 'info', row.headline, row.text, row.options, row.recommendation, row.recommendationReason, row.confidence, row.checks, row.evidence, row.artifactKind]);

export const requestDecision = internalMutation({
    args: { ...userTask, key: v.string(), ...decisionArgs },
    handler: async (ctx, { userId, assignmentId, taskId, key, ...decision }) => {
        const task = taskInScope(await requireScope(ctx, userId, assignmentId), taskId);
        const card = decisionCard(decision);
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            if (previous.links !== undefined || cardSignature(previous) !== cardSignature(card)) throw new ConvexError('Idempotency key already used');
            return view(previous);
        }
        if (!open(task)) throw new ConvexError('Task is already closed');
        await requireNotDeferred(ctx, userId, taskId);
        const waiting = await taskDecisions(ctx, userId, taskId, 'waiting', { assignmentId });
        if (waiting.some(row => (row.headline ?? row.text) === card.headline)) throw new ConvexError('This question is already waiting for a reply');
        if (waiting.length >= 10) throw new ConvexError('This task already has 10 open questions');
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, key, status: 'waiting', ...card });
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
        return row.status === 'merging' ? { claimed: true, approved: true, pr_url: row.prUrl, pr_head_sha: row.prHeadSha } : { claimed: true, answer: row.answer };
    },
});

export const recordWorkResult = internalMutation({
    args: { ...userTask, summary: v.string(), links: v.array(v.string()), complete: v.boolean(),
        needsReview: v.optional(v.boolean()), assumptions: v.optional(v.string()), prHeadSha: v.optional(v.string()),
        headline: v.optional(v.string()), checks: v.optional(v.array(v.string())),
        appliedQuestionId: v.optional(v.string()), claimKey: v.optional(v.string()), expectedTaskVersion: v.optional(v.number()), key: v.string() },
    handler: async (ctx, { userId, assignmentId, taskId, summary, links, complete, needsReview, prHeadSha, appliedQuestionId, claimKey, expectedTaskVersion, key, ...args }) => {
        const assigned = await requireScope(ctx, userId, assignmentId);
        const task = taskInScope(assigned, taskId);
        const assumptions = args.assumptions?.trim() || undefined;
        if (assumptions && assumptions.length > 8000) throw new ConvexError('Assumptions must be at most 8000 characters');
        // Optional on progress and direct completions; required below once the result becomes a review.
        const cardProblems: string[] = [];
        const headline = args.headline === undefined ? undefined : cardText(cardProblems, 'headline', args.headline, 80, 'one line saying what was done');
        const checks = args.checks === undefined ? undefined : cardChecks(cardProblems, args.checks);
        if (cardProblems.length) throw new ConvexError(`Rewrite the result and resubmit: ${cardProblems.join('; ')}.`);
        if (prHeadSha !== undefined && !commitShaPattern.test(prHeadSha)) throw new ConvexError('pr_head_sha must be the full 40-character lowercase commit SHA');
        if (prHeadSha !== undefined && !complete) throw new ConvexError('pr_head_sha is only for a completion (complete true)');
        // A pull request is always reviewed, so its assumptions are optional.
        if (complete && needsReview && !assumptions && prHeadSha === undefined) throw new ConvexError('Describe the assumptions or judgment calls the user should check');
        const previous = await priorWork(ctx, userId, taskId, key, assignmentId);
        if (previous) {
            if ((previous.status === 'progress') === complete || previous.text !== summary || previous.appliedQuestionId !== appliedQuestionId ||
                previous.assumptions !== assumptions || previous.prHeadSha !== prHeadSha || JSON.stringify(previous.links) !== JSON.stringify(links) ||
                previous.headline !== headline || JSON.stringify(previous.checks) !== JSON.stringify(checks)) {
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
        // An approved pull request is completed directly once its approved commit is merged; a new head goes back to review.
        const approvedPr = question?.status === 'merging' ? question : null;
        const merge = !!approvedPr && complete && (prHeadSha === approvedPr.prHeadSha || (prHeadSha === undefined && !needsReview));
        if (approvedPr && complete && !merge && prHeadSha !== undefined && !needsReview) {
            throw new ConvexError(`The user approved commit ${approvedPr.prHeadSha}. Merge only that commit, or resubmit the new head for review with needs_review`);
        }
        const pullRequests = links.filter(link => pullRequest(link));
        if (merge && pullRequests.some(link => link !== approvedPr.prUrl)) throw new ConvexError(`Report the merge of the approved pull request ${approvedPr.prUrl} only`);
        const submitsPr = prHeadSha !== undefined && !merge;
        if (submitsPr && !pullRequests.length) throw new ConvexError('pr_head_sha needs the GitHub pull request link (https://github.com/<owner>/<repo>/pull/<n>) in links');
        const role = await botRole(ctx, userId, taskId, assigned.label.id, assignmentId);
        if (complete && role.mode === 'challenge') {
            throw new ConvexError('This task is in challenge mode: present a counterargument, mock or analysis with request_decision(kind="challenge") instead of completing it');
        }
        if (complete && !role.execute) throw new ConvexError('This task is review-only for Grok Bot');
        if (complete) await requireNotDeferred(ctx, userId, taskId);
        if (complete && expectedTaskVersion !== task.updatedAt) throw new ConvexError('Task changed; read it again before reporting completion');
        const review = complete && !task.done && !merge && (!!needsReview || role.reviewRequired || submitsPr);
        if (review && (!headline || !checks)) {
            throw new ConvexError('This completion waits for the user’s review, so it needs headline (one line, at most 80 characters, saying what was done) ' +
                'and checks (1 to 3 things the user must actually look at before approving). Resubmit with both');
        }
        if (complete && !task.done) {
            if (subtreeOf(assigned.items, taskId).slice(1).some(child => child.type !== 'task' || !assigned.tasks.has(child.id) || !child.done)) {
                throw new ConvexError('Finish the subtasks before completing this task');
            }
            const [waiting, answered, returned, reviews, merging] = await Promise.all((['waiting', 'answered', 'returned', 'review', 'merging'] as const).map(status =>
                taskDecisions(ctx, userId, taskId, status, { assignmentId })));
            if (reviews.length) throw new ConvexError('A completion for this task is already awaiting the user’s review; work on other tasks');
            if (merging.some(row => row._id !== questionId)) {
                throw new ConvexError('The user approved a pull request for this task: claim it, merge the approved commit and report with applied_question_id, or resubmit it for review');
            }
            if (waiting.length || [...answered, ...returned].some(row => row._id !== questionId)) throw new ConvexError('Resolve pending decisions before completing this task');
            if (!review) await ctx.runMutation(internal.mcpTasks.complete, { userId, taskId, clientName: 'Grok Bot' });
        }
        const status = review ? 'review' : complete ? 'complete' : 'progress';
        const prUrl = submitsPr ? pullRequests[0] : merge ? approvedPr.prUrl : undefined;
        const id = await ctx.db.insert('taskWork', { userId, assignmentId, taskId, key, text: summary, status, links, appliedQuestionId, assumptions, prUrl, prHeadSha, headline, checks });
        const released = { claimKey: undefined, claimUntil: undefined };
        // Progress on an approved pull request (say, a failed merge) leaves it approved and claimed.
        if (approvedPr && merge) await ctx.db.patch(approvedPr._id, { status: 'merged', mergedAt: Date.now(), ...released });
        else if (approvedPr && complete) await ctx.db.patch(approvedPr._id, { status: 'superseded', ...released });
        else if (question && !approvedPr) await ctx.db.patch(question._id, { status: question.status === 'returned' ? 'revised' : 'applied', ...released });
        return { id, status };
    },
});

async function pendingReview(ctx: QueryCtx, id: Id<'taskWork'>, expectedUserId: string) {
    const userId = await currentUser(ctx, expectedUserId);
    const row = await ctx.db.get(id);
    if (!userId || row?.userId !== userId) throw new ConvexError('確認依頼が見つかりません。');
    const assigned = row.status === 'review' ? await taskAssignment(ctx, userId, row.taskId) : null;
    if (row.status === 'review' && (!assigned || assigned.assignmentId !== row.assignmentId)) throw new ConvexError('このタスクは現在の担当範囲にありません。');
    return { userId, row, assigned };
}

export const approveReview = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string(), autonomyRule: v.optional(v.string()) },
    handler: async (ctx, { id, expectedUserId, autonomyRule }) => {
        const { userId, row } = await pendingReview(ctx, id, expectedUserId);
        if (row.status === 'approved' || row.status === 'merging' || row.status === 'merged') return;
        if (row.status !== 'review') throw new ConvexError('この確認依頼はすでに対応済みです。');
        const assigned = await requireScope(ctx, userId, row.assignmentId);
        const task = taskInScope(assigned, row.taskId);
        if (task.locked) throw new ConvexError('タスクがロックされています。ロックを外してから承認してください。');
        if (subtreeOf(assigned.items, task.id).slice(1).some(child => child.type !== 'task' || !assigned.tasks.has(child.id) || !child.done)) {
            throw new ConvexError('未完了のサブタスクがあるため完了できません。サブタスクを片付けるか、差し戻してください。');
        }
        const now = Date.now();
        // An approval can also say "this kind may proceed without asking": a label autonomy norm, saved with the approval.
        const rule = autonomyRule?.trim();
        if (rule) {
            if (rule.length > 300) throw new ConvexError('自律ルールは1〜300文字で入力してください。');
            if ((await ctx.db.query('grokBotNorms').withIndex('by_user', q => q.eq('userId', userId)).take(maxNorms)).length >= maxNorms) {
                throw new ConvexError(`ルールは${maxNorms}件までです。不要なルールを削除してください。`);
            }
            await ctx.db.insert('grokBotNorms', { userId, labelId: assigned.label.id, text: rule, kind: 'autonomy',
                sourceWorkId: row._id, active: true, createdAt: now, updatedAt: now });
        }
        // A pull request stays open until the Bot merges exactly the approved commit and reports it.
        if (row.prHeadSha) {
            await ctx.db.patch(id, { status: 'merging', answeredAt: now });
            await queueWake(ctx, id, now);
            return;
        }
        await ctx.runMutation(internal.mcpTasks.complete, { userId, taskId: task.id, clientName: 'Grok Bot' });
        await ctx.db.patch(id, { status: 'approved', answeredAt: now });
    },
});

export const returnReview = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string(), comment: v.string(), alsoCreateNorm: v.optional(v.boolean()) },
    handler: async (ctx, { id, expectedUserId, comment, alsoCreateNorm }) => {
        const { userId, row, assigned } = await pendingReview(ctx, id, expectedUserId);
        const text = comment.trim();
        if (!text || text.length > 8000) throw new ConvexError('差し戻しの理由を1〜8000文字で入力してください。');
        if (row.status !== 'review') {
            if (row.status === 'returned' && row.answer === text) return;
            throw new ConvexError('この確認依頼はすでに対応済みです。');
        }
        const now = Date.now();
        await ctx.db.patch(id, { status: 'returned', answer: text, answeredAt: now });
        // Review feedback the human wants every future run to respect becomes a standing rule of this label.
        if (alsoCreateNorm && assigned) await ctx.db.insert('grokBotNorms', { userId, labelId: assigned.label.id, text: text.slice(0, 300), kind: 'rule',
            sourceWorkId: row._id, active: true, createdAt: now, updatedAt: now });
        await queueWake(ctx, id, now);
    },
});

async function queueWake(ctx: MutationCtx, id: Id<'taskWork'>, wakeAt: number) {
    await ctx.db.patch(id, { wakeAt, wakeStatus: 'queued' });
    await ctx.scheduler.runAfter(0, internal.grokBot.wake, { id, wakeAt });
}

export const reply = mutation({
    args: { id: v.id('taskWork'), expectedUserId: v.string(), answer: v.string(), promoteToExecution: v.optional(v.boolean()) },
    handler: async (ctx, { id, expectedUserId, answer, promoteToExecution }) => {
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
        // One-step greenlight: the answer also hands execution to the Bot, with completion still checked by the human.
        if (promoteToExecution) {
            const existing = await delegationFor(ctx, userId, row.taskId);
            const current = existing?.labelId === assigned.label.id && existing.assignmentId === assigned.assignmentId ? modeOf(existing) : 'review';
            const role = { labelId: assigned.label.id, assignmentId: assigned.assignmentId, reviewCompletion: true, mode: 'checked' as const };
            if (current === 'review' || current === 'challenge') {
                if (existing) await ctx.db.patch(existing._id, role);
                else await ctx.db.insert('grokBotDelegations', { userId, taskId: row.taskId, ...role });
            }
        }
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
        const trigger = row.status === 'returned' ? 'review_returned' : row.status === 'merging' ? 'review_approved' : 'reply';
        return webhook ? { ...webhook, taskId: row.taskId, trigger } : null;
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

type Schedule = Doc<'grokBotSchedules'>;
const clockInsOf = (saved: Pick<Schedule, 'time' | 'times'>) => normalizeClockInTimes(saved.times, saved.time);
const nextCheckFor = (saved: Pick<Schedule, 'time' | 'times' | 'lastSlotKey'>, timeZone: string, now: number, lastRunAt?: number) =>
    nextClockIn(clockInsOf(saved), timeZone, now, lastRunAt, saved.lastSlotKey);

/** The next scheduled patrol of a label Bot or the pilot (the VP never applies answers), and which Bot clocks in. */
async function nextLabelPatrol(ctx: QueryCtx, userId: string) {
    const [saved, labels, timeZone] = await Promise.all([ctx.db.query('grokBotSchedules').withIndex('by_user', q => q.eq('userId', userId)).collect(),
        labelAssignments(ctx, userId), timezoneFor(ctx, userId)]);
    const pilot = pilotFor(userId);
    const due = saved.filter(row => row.enabled).map(row => {
        const bot = row.assignmentId ? labels.find(label => label._id === row.assignmentId) : undefined;
        const at = row.assignmentId ? bot ? row.nextCheckAt : undefined
            : pilot && timeZone ? nextCheckFor(row, timeZone, Date.now(), row.lastRunAt) : undefined;
        return { at, labelId: bot?.labelId ?? pilot?.labelId };
    }).filter((row): row is { at: number; labelId: string } => row.at !== undefined && !!row.labelId).sort((a, b) => a.at - b.at)[0];
    if (!due) return null;
    return { at: due.at, label: (await loadItem(ctx, userId, due.labelId))?.text.trim() || 'ラベル', vp: false };
}

export async function refreshPatrolTimeZone(ctx: MutationCtx, userId: string, timeZone: string) {
    const now = Date.now();
    for (const saved of await ctx.db.query('grokBotSchedules').withIndex('by_user', q => q.eq('userId', userId)).collect()) {
        if (saved.enabled && saved.assignmentId) await ctx.db.patch(saved._id, {
            savedAt: now, nextCheckAt: nextCheckFor(saved, timeZone, now, saved.lastRunAt),
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
        const time = saved?.time ?? '06:00';
        return { timeZone, enabled: saved?.enabled ?? false, time, times: saved ? clockInsOf(saved) : [time],
            lastRunAt: saved?.lastRunAt, lastStatus: saved?.lastStatus, nextCheckAt: saved?.nextCheckAt };
    },
});

export const saveSchedule = mutation({
    args: { ...scheduleArgs, enabled: v.boolean(), time: v.string(), times: v.optional(v.array(v.string())) },
    handler: async (ctx, { expectedUserId, labelId, vp, enabled, time, times: requested }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId, vp) : null;
        if (!userId || !target || (!('vp' in target) && (await loadItem(ctx, userId, target.labelId))?.type !== 'section')) throw new ConvexError('Grok Botの担当ラベルが見つかりません。');
        let times: string[] | undefined;
        if (requested !== undefined) {
            times = normalizeClockInTimes(requested);
            if (!times.length || times.length !== requested.length || requested.length > maxClockIns) {
                throw new ConvexError(`巡回時刻はHH:MMで重複なく1〜${maxClockIns}件入力してください。`);
            }
            time = times[0];
        } else if (!isTimeString(time)) throw new ConvexError('巡回時刻を入力してください。');
        const [saved, timeZone] = await Promise.all([scheduleFor(ctx, userId, target.assignmentId), timezoneFor(ctx, userId)]);
        if (enabled && !timeZone) throw new ConvexError('先に設定でタイムゾーンを保存してください。');
        const savedAt = Date.now();
        // Without times the schedule is the single daily time again.
        const fields = { enabled, time, times, savedAt };
        const nextCheckAt = target.assignmentId && enabled && timeZone
            ? nextCheckFor({ ...fields, lastSlotKey: saved?.lastSlotKey }, timeZone, savedAt, saved?.lastRunAt) : undefined;
        if (saved) await ctx.db.patch(saved._id, { ...fields, nextCheckAt });
        else await ctx.db.insert('grokBotSchedules', { userId, assignmentId: target.assignmentId, ...fields, nextCheckAt });
    },
});

/** Clock a connected Bot in now, outside its schedule. The scheduled clock-ins are unchanged. */
export const patrolNow = mutation({
    args: scheduleArgs,
    handler: async (ctx, { expectedUserId, labelId, vp }) => {
        const userId = await currentUser(ctx, expectedUserId);
        const target = userId ? await scheduleAssignment(ctx, userId, labelId, vp) : null;
        const bot = target?.assignmentId ? await ctx.db.get(target.assignmentId) : null;
        if (!userId || !bot || bot.userId !== userId) throw new ConvexError('担当Botが見つかりません。');
        if (!bot.connectedAt || !webhookFor(bot)) throw new ConvexError('Botの接続を完了してから呼び出してください。');
        const at = Date.now();
        const saved = await scheduleFor(ctx, userId, bot._id);
        const id = saved ? saved._id : await ctx.db.insert('grokBotSchedules', { userId, assignmentId: bot._id, enabled: false, time: '06:00', savedAt: at });
        await ctx.db.patch(id, { lastRunAt: at, lastStatus: 'queued' });
        await ctx.scheduler.runAfter(0, internal.grokBot.runPatrol, { id, at, labelId: bot.labelId, manual: true });
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
        const lastSlotKey = String(saved.nextCheckAt);
        const nextCheckAt = nextCheckFor({ ...saved, lastSlotKey }, timeZone, now, shouldRun ? now : saved.nextCheckAt);
        await ctx.db.patch(saved._id, shouldRun
            ? { nextCheckAt, lastDay: day, lastRunAt: now, lastStatus: 'queued', lastSlotKey }
            : { nextCheckAt, lastSlotKey });
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

/** manual: the human clocked the Bot in by hand, so a disabled schedule still sends it. */
const patrolArgs = { id: v.id('grokBotSchedules'), at: v.number(), labelId: v.string(), manual: v.optional(v.boolean()) };

export const patrolTarget = internalQuery({
    args: patrolArgs,
    handler: async (ctx, { id, at, labelId, manual }) => {
        const saved = await ctx.db.get(id);
        if (!saved || (!manual && (!saved.enabled || saved.savedAt > at)) || saved.lastRunAt !== at || saved.lastStatus !== 'queued' ||
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

/* ---------- Bot context: the standing norms and recently killed ideas every Bot reads before acting ---------- */

async function botContext(ctx: QueryCtx, userId: string, labelId: string | null) {
    const [norms, rejections] = await Promise.all([
        ctx.db.query('grokBotNorms').withIndex('by_user', q => q.eq('userId', userId)).collect(),
        labelId === null ? ctx.db.query('taskRejections').withIndex('by_user_rejected', q => q.eq('userId', userId)).order('desc').take(10)
            : ctx.db.query('taskRejections').withIndex('by_user_label', q => q.eq('userId', userId).eq('labelId', labelId)).order('desc').take(10),
    ]);
    return {
        norms: norms.filter(row => row.active && (labelId === null || !row.labelId || row.labelId === labelId))
            .map(row => ({ id: row._id, kind: row.kind, text: row.text, label_id: row.labelId ?? null })),
        recent_rejections: rejections.map(row => ({ task_title: row.taskTitle, label_id: row.labelId ?? null, reason: row.reason,
            bot_argument: row.botArgument ?? null, spawned_title: row.spawnedTitle ?? null, rejected_at: row.rejectedAt })),
    };
}

/* ---------- Rejections: killing an idea with a recorded reason is an outcome, not a failure ---------- */

function rejectionView(row: Doc<'taskRejections'>) {
    return { id: row._id, taskId: row.taskId, taskTitle: row.taskTitle, labelId: row.labelId, labelName: row.labelName, reason: row.reason,
        botArgument: row.botArgument, spawnedTaskId: row.spawnedTaskId, spawnedTitle: row.spawnedTitle, rejectedAt: row.rejectedAt };
}

const recentRejections = async (ctx: QueryCtx, userId: string) =>
    (await ctx.db.query('taskRejections').withIndex('by_user_rejected', q => q.eq('userId', userId)).order('desc').take(10)).map(rejectionView);

const normKind = v.union(v.literal('rule'), v.literal('kill_criterion'), v.literal('autonomy'));

export const rejectTaskWithLearning = mutation({
    args: { expectedUserId: v.string(), workId: v.optional(v.id('taskWork')), proposalId: v.optional(v.id('grokBotProposals')), reason: v.string(),
        spawnTitle: v.optional(v.string()), spawnNote: v.optional(v.string()), alsoCreateNorm: v.optional(v.boolean()), normKind: v.optional(normKind) },
    handler: async (ctx, { expectedUserId, workId, proposalId, ...args }) => {
        const userId = await currentUser(ctx, expectedUserId);
        if (!userId) throw new ConvexError('サインインしてください。');
        const reason = args.reason.trim();
        if (!reason || reason.length > 2000) throw new ConvexError('ボツにする理由を1〜2000文字で入力してください。');
        const spawnTitle = args.spawnTitle?.trim() || undefined;
        const spawnNote = spawnTitle ? args.spawnNote?.trim() || undefined : undefined;
        if ((spawnTitle?.length ?? 0) > 500 || (spawnNote?.length ?? 0) > 8000) throw new ConvexError('代わりのタスクは500文字、メモは8000文字までです。');
        if ((workId === undefined) === (proposalId === undefined)) throw new ConvexError('ボツにする依頼か提案を1つ選んでください。');
        const work = workId ? await ctx.db.get(workId) : null;
        const proposal = proposalId ? await ctx.db.get(proposalId) : null;
        const source = work ?? proposal;
        if (!source || source.userId !== userId) throw new ConvexError('依頼が見つかりません。');
        if (work && work.status !== 'waiting' && work.status !== 'review') throw new ConvexError('この依頼はすでに対応済みです。');
        if (proposal && (proposal.status !== 'pending' || !proposal.taskId)) throw new ConvexError('この提案はすでに対応済みか、ボツにするタスクがありません。');
        const taskId = (work?.taskId ?? proposal?.taskId)!;
        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map(item => [item.id, item]));
        const task = byId.get(taskId);
        if (task?.type !== 'task' || !open(task)) throw new ConvexError('タスクが見つからないか、すでに完了しています。');
        if (task.locked) throw new ConvexError('タスクがロックされています。ロックを外してからボツにしてください。');
        const label = labelIn(byId, task);
        let spawnedTaskId: string | undefined;
        if (spawnTitle) {
            const created: unknown = await ctx.runMutation(internal.mcpTasks.add, { userId, text: spawnTitle, note: spawnNote, parentId: label?.id,
                idempotencyKey: `reject-spawn:${source._id}`, createdBy: 'user' });
            spawnedTaskId = created && typeof created === 'object' && 'id' in created && typeof created.id === 'string' ? created.id : undefined;
        }
        const current = snapshot(items, task.id)!;
        await ctx.runMutation(internal.mcpTasks.remove, { userId, taskId, expectedText: current.text, expectedCount: current.count });
        const now = Date.now();
        if (work) await ctx.db.patch(work._id, { status: 'rejected', answer: reason, rejectionReason: reason, answeredAt: now, spawnedTaskId,
            claimKey: undefined, claimUntil: undefined });
        if (proposal) await ctx.db.patch(proposal._id, { status: 'adopted', resolvedAt: now });
        const botArgument = (work ? [work.headline, work.text, work.recommendationReason] : [proposal?.reason])
            .filter(Boolean).join(' — ').slice(0, 2000) || undefined;
        const rejectionId = await ctx.db.insert('taskRejections', { userId, taskId, taskTitle: task.text, labelId: label?.id,
            labelName: label ? label.text.trim() || 'ラベル' : undefined, assignmentId: source.assignmentId, workId: work?._id, proposalId: proposal?._id,
            reason, botArgument, spawnedTaskId, spawnedTitle: spawnedTaskId ? spawnTitle : undefined, rejectedAt: now });
        if (args.alsoCreateNorm) await ctx.db.insert('grokBotNorms', { userId, labelId: label?.id, text: reason.slice(0, 300), kind: args.normKind ?? 'kill_criterion',
            sourceWorkId: work?._id, sourceRejectionId: rejectionId, active: true, createdAt: now, updatedAt: now });
        return { rejectionId, spawnedTaskId };
    },
});

/* ---------- Norms: standing rules the human sets, read by every Bot ---------- */

const maxNorms = 100;

async function normViews(ctx: QueryCtx, userId: string, labelId?: string) {
    const rows = (await ctx.db.query('grokBotNorms').withIndex('by_user', q => q.eq('userId', userId)).collect())
        .filter(row => labelId === undefined || !row.labelId || row.labelId === labelId).sort((a, b) => b.createdAt - a.createdAt);
    const names = new Map<string, string>();
    for (const id of new Set(rows.map(row => row.labelId).filter(id => id !== undefined))) {
        const label = await loadItem(ctx, userId, id);
        if (label?.type === 'section') names.set(id, label.text.trim() || 'ラベル');
    }
    return rows.map(row => ({ id: row._id, labelId: row.labelId, labelName: row.labelId ? names.get(row.labelId) : undefined, text: row.text, kind: row.kind,
        active: row.active, sourceWorkId: row.sourceWorkId, sourceRejectionId: row.sourceRejectionId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

export const norms = query({
    args: { expectedUserId: v.string(), labelId: v.optional(v.string()) },
    handler: async (ctx, { expectedUserId, labelId }) => {
        const userId = await currentUser(ctx, expectedUserId);
        return userId ? normViews(ctx, userId, labelId) : [];
    },
});

export const addNorm = mutation({
    args: { expectedUserId: v.string(), labelId: v.optional(v.string()), text: v.string(), kind: normKind },
    handler: async (ctx, { expectedUserId, labelId, kind, ...args }) => {
        const userId = labelId === undefined ? await currentUser(ctx, expectedUserId) : (await requireLabel(ctx, expectedUserId, labelId)).userId;
        if (!userId) throw new ConvexError('サインインしてください。');
        const text = args.text.trim();
        if (!text || text.length > 300) throw new ConvexError('ルールは1〜300文字で入力してください。');
        if ((await ctx.db.query('grokBotNorms').withIndex('by_user', q => q.eq('userId', userId)).take(maxNorms)).length >= maxNorms) {
            throw new ConvexError(`ルールは${maxNorms}件までです。不要なルールを削除してください。`);
        }
        const now = Date.now();
        return await ctx.db.insert('grokBotNorms', { userId, labelId, text, kind, active: true, createdAt: now, updatedAt: now });
    },
});

async function ownNorm(ctx: QueryCtx, expectedUserId: string, id: Id<'grokBotNorms'>) {
    const userId = await currentUser(ctx, expectedUserId);
    const row = await ctx.db.get(id);
    if (!userId || row?.userId !== userId) throw new ConvexError('ルールが見つかりません。');
    return row;
}

export const toggleNorm = mutation({
    args: { expectedUserId: v.string(), id: v.id('grokBotNorms'), active: v.boolean() },
    handler: async (ctx, { expectedUserId, id, active }) => {
        await ownNorm(ctx, expectedUserId, id);
        await ctx.db.patch(id, { active, updatedAt: Date.now() });
    },
});

export const deleteNorm = mutation({
    args: { expectedUserId: v.string(), id: v.id('grokBotNorms') },
    handler: async (ctx, { expectedUserId, id }) => {
        await ownNorm(ctx, expectedUserId, id);
        await ctx.db.delete(id);
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
            const role = roleFor(!!label && !!bot && delegation?.labelId === label.id && delegation.assignmentId === bot.assignmentId ? modeOf(delegation) : 'review');
            return { label_id: label?.id ?? null, label: label?.text ?? null, unsorted: !label && unsorted(byId, task),
                bot_role: bot ? role.execute ? 'execute' : 'review' : null, bot_mode: bot ? role.mode : null, review_required: role.reviewRequired };
        };
        if (taskId) {
            const task = byId.get(taskId);
            if (task?.type !== 'task' || !task.text.trim()) throw new ConvexError('Task not found');
            const place = placeOf(task);
            const subtasks = subtreeOf(items, taskId).slice(1).filter(item => item.type === 'task');
            return { task: await toView(ctx, userId, task, place.label ?? undefined, subtasks), task_version: task.updatedAt, ...place,
                deferred_until: deferred.get(taskId) ?? null, work: (await history(ctx, userId, taskId)).map(view),
                proposals: await taskProposals(ctx, userId, assignmentId, taskId), ...await botContext(ctx, userId, null) };
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
            ...await botContext(ctx, userId, null),
        };
    },
});
