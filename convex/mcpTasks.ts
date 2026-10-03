import { internalMutation, internalQuery } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { cleanupFiles } from "./fileCleanup";
import { dateInTimeZone, isDateString, isTimeString } from "../src/lib/taskDates";
import { coerceStamps, restamp, type Stamps } from "../src/lib/itemMerge";
import { compareItems, isLabelColor, type Item } from "../src/lib/taskModel";
import {
    MAX_ATTACHMENTS,
    attachmentFrom,
    attachmentLabel,
    coerceAttachments,
    liveAttachments,
    type Attachment,
} from "../src/lib/attachments";

/*
 * MCP から人間のタスクリストを読み書きする。
 *
 * タスクの正はブラウザの localStorage で、syncItems はその写し。
 * ここで書いたものは、開いているブラウザが次の pull で拾って画面に出る。
 *
 * sync.ts は payload を「ただ預かるだけ」にしてあるが、エージェントに
 * タスクを足させる以上、ここだけは中身を知る必要がある。
 * 形は src/lib/taskModel.ts の Item に合わせること。
 *
 * これらは internal。外からは convex/http.ts の /mcp/* 経由でしか呼べない。
 */

type SyncRow = Doc<"syncItems">;

interface StoredItem {
    id: string;
    type: "task" | "section";
    parentId: string | null;
    order: number;
    text: string;
    note?: string;
    completionCriteria?: string;
    done: boolean;
    locked?: boolean;
    createdBy?: "user" | "ai";
    createdByClient?: string;
    completedBy?: "user" | "ai";
    completedByClient?: string;
    filed?: boolean;
    kind?: "main" | "tanomi";
    color?: string;
    estimate?: number;
    assignedDate?: string;
    dueDate?: string;
    dueTime?: string;
    attachments?: Attachment[];
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
    stamps?: Stamps;
}

function parseRow(row: SyncRow): StoredItem | null {
    if (row.deletedAt) return null;
    return parsePayload(row);
}

/** 消えた行も読む。書き込み前の姿と比べて、変わった欄にだけ時刻を打つため */
function parsePayload(row: SyncRow): StoredItem | null {
    try {
        const raw = JSON.parse(row.payload) as Partial<StoredItem>;
        if (typeof raw.text !== "string") return null;
        const locked = raw.type !== "section" && raw.locked === true;
        return {
            ...raw,
            id: row.itemId,
            type: raw.type === "section" ? "section" : "task",
            parentId: typeof raw.parentId === "string" ? raw.parentId : null,
            order: typeof raw.order === "number" ? raw.order : 0,
            text: raw.text,
            completionCriteria: typeof raw.completionCriteria === "string" ? raw.completionCriteria : undefined,
            dueDate: typeof raw.dueDate === "string" && isDateString(raw.dueDate) ? raw.dueDate : undefined,
            dueTime: typeof raw.dueDate === "string" && isDateString(raw.dueDate) && typeof raw.dueTime === "string" && isTimeString(raw.dueTime) ? raw.dueTime : undefined,
            done: !locked && raw.done === true,
            locked: locked ? true : undefined,
            filed: !locked && raw.filed === true ? true : undefined,
            createdBy: raw.createdBy === "user" || raw.createdBy === "ai" ? raw.createdBy : undefined,
            createdByClient: raw.createdBy === "ai" && typeof raw.createdByClient === "string" ? raw.createdByClient : undefined,
            completedBy: !locked && raw.done === true && (raw.completedBy === "user" || raw.completedBy === "ai") ? raw.completedBy : undefined,
            completedByClient: !locked && raw.done === true && raw.completedBy === "ai" && typeof raw.completedByClient === "string" ? raw.completedByClient : undefined,
            createdAt: typeof raw.createdAt === "number" ? raw.createdAt : row.updatedAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
            attachments: coerceAttachments(raw.attachments),
            stamps: coerceStamps(raw.stamps),
        };
    } catch {
        return null;
    }
}

async function loadItems(ctx: QueryCtx | MutationCtx, userId: string): Promise<StoredItem[]> {
    const rows = await ctx.db
        .query("syncItems")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
    return rows.map(parseRow).filter((item): item is StoredItem => item !== null);
}

/** 親が消えている行はルート扱い。クライアント側の effectiveParentId と同じ */
function effectiveParentId(byId: Map<string, StoredItem>, item: StoredItem): string | null {
    return item.parentId && byId.has(item.parentId) ? item.parentId : null;
}

function childrenOf(items: StoredItem[], parentId: string | null): StoredItem[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    return items
        .filter((i) => effectiveParentId(byId, i) === parentId)
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function nextOrder(items: StoredItem[], parentId: string | null): number {
    const siblings = childrenOf(items, parentId);
    return siblings.length === 0 ? 0 : siblings[siblings.length - 1].order + 1;
}

/**
 * 1件書く。いまの行と比べて変わった欄にだけ item.updatedAt を打つ。
 * 同期は欄ごとに突き合わせるので（src/lib/itemMerge.ts）、触っていない欄の
 * 時刻まで進めると、ブラウザで同時に直したものを上書きしてしまう。
 */
async function writeItem(ctx: MutationCtx, userId: string, item: StoredItem): Promise<void> {
    const existing = await ctx.db
        .query("syncItems")
        .withIndex("by_user_item", (q) => q.eq("userId", userId).eq("itemId", item.id))
        .unique();

    const prev = existing ? (parsePayload(existing) ?? undefined) : undefined;
    const next = restamp(prev, item, item.updatedAt);
    const payload = JSON.stringify(next);

    if (existing) {
        await ctx.db.patch(existing._id, {
            updatedAt: next.updatedAt,
            deletedAt: next.deletedAt,
            payload,
        });
        await cleanupFiles(ctx, userId, item.id, next.attachments, !!next.deletedAt);
        return;
    }
    await ctx.db.insert("syncItems", {
        userId,
        itemId: item.id,
        updatedAt: next.updatedAt,
        deletedAt: next.deletedAt,
        payload,
    });
}

/**
 * 同じミリ秒に2つ書くと updatedAt が並び、あとの変更が「古い」と見なされる。
 * 既存の最大値より必ず1つ進めておく。
 */
function stampAfter(items: StoredItem[]): number {
    const newest = items.reduce((max, i) => Math.max(max, i.updatedAt), 0);
    return Math.max(Date.now(), newest + 1);
}

function clientLabel(name: string | undefined): string | undefined {
    return name?.trim().slice(0, 80) || undefined;
}

async function resolveToday(ctx: QueryCtx | MutationCtx, userId: string, today: boolean | string | undefined): Promise<string | undefined> {
    if (today === undefined || today === false || today === "") return undefined;
    if (typeof today === "string") {
        if (!isDateString(today)) throw new ConvexError("today must be YYYY-MM-DD");
        return today;
    }
    const preference = await ctx.db.query("userPreferences")
        .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!preference) throw new ConvexError("Time zone is not set. Open bizencore settings first.");
    return dateInTimeZone(preference.timeZone);
}

function validateDeadline(dueDate?: string, dueTime?: string): void {
    if (dueDate && !isDateString(dueDate)) throw new ConvexError("due_date must be YYYY-MM-DD");
    if (dueTime && (!dueDate || !isTimeString(dueTime))) throw new ConvexError("due_time needs due_date and must be HH:mm");
}

const RETRY_WINDOW_MS = 2 * 60_000;
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60_000;

function requestHash(request: string): string {
    let a = 2166136261;
    let b = 0x811c9dc5;
    for (let i = 0; i < request.length; i++) {
        a = Math.imul(a ^ request.charCodeAt(i), 16777619);
        b = Math.imul(b ^ request.charCodeAt(request.length - i - 1), 16777619);
    }
    return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

async function previousAdd(ctx: MutationCtx, userId: string, key: string, request: string, explicit: boolean): Promise<unknown | undefined> {
    const row = await ctx.db.query("mcpIdempotency")
        .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key)).unique();
    if (!row) return undefined;
    if (Date.now() - row.createdAt > IDEMPOTENCY_RETENTION_MS) {
        await ctx.db.delete(row._id);
        return undefined;
    }
    if (row.request !== request) throw new ConvexError("idempotency_key was already used for a different task");
    if (!explicit && Date.now() - row.createdAt > RETRY_WINDOW_MS) {
        await ctx.db.delete(row._id);
        return undefined;
    }
    return JSON.parse(row.response) as unknown;
}

async function rememberAdd(ctx: MutationCtx, userId: string, key: string, request: string, response: unknown): Promise<void> {
    await ctx.db.insert("mcpIdempotency", { userId, key, request, response: JSON.stringify(response), createdAt: Date.now() });
    const expired = await ctx.db.query("mcpIdempotency")
        .withIndex("by_user_createdAt", (q) => q.eq("userId", userId).lt("createdAt", Date.now() - IDEMPOTENCY_RETENTION_MS))
        .take(10);
    for (const row of expired) await ctx.db.delete(row._id);
}

interface TaskView {
    id: string;
    text: string;
    note?: string;
    done: boolean;
    locked?: boolean;
    created_by?: "user" | "agent";
    created_by_client?: string;
    completed_by?: "user" | "agent";
    completed_by_client?: string;
    label?: string;
    parent_task?: string;
    estimate_minutes?: number;
    today?: string;
    due_date?: string;
    due_time?: string;
    completion_criteria?: string;
    subtasks?: { id: string; text: string; done: boolean; locked?: boolean; created_by?: "user" | "agent"; created_by_client?: string; completed_by?: "user" | "agent"; completed_by_client?: string; due_date?: string; due_time?: string; completion_criteria?: string }[];
    attachments?: AttachmentView[];
}

interface AttachmentView {
    id: string;
    kind: "link" | "text" | "file";
    title: string;
    url?: string;
    text?: string;
    mime_type?: string;
    size?: number;
    added_by: "human" | "ai";
}

async function toView(ctx: QueryCtx, userId: string, item: StoredItem, label: string | undefined, subtasks: StoredItem[]): Promise<TaskView> {
    const view: TaskView = { id: item.id, text: item.text, done: item.done };
    if (item.locked) view.locked = true;
    Object.assign(view, attributionView(item));
    if (item.note?.trim()) view.note = item.note;
    if (label) view.label = label;
    if (typeof item.estimate === "number") view.estimate_minutes = item.estimate;
    if (item.assignedDate) view.today = item.assignedDate;
    if (item.dueDate) view.due_date = item.dueDate;
    if (item.dueTime) view.due_time = item.dueTime;
    if (item.completionCriteria?.trim()) view.completion_criteria = item.completionCriteria;
    if (subtasks.length > 0) {
        view.subtasks = subtasks.map((s) => ({ id: s.id, text: s.text, done: s.done,
            ...(s.locked ? { locked: true } : {}),
            ...attributionView(s),
            ...(s.dueDate ? { due_date: s.dueDate } : {}),
            ...(s.dueTime ? { due_time: s.dueTime } : {}),
            ...(s.completionCriteria ? { completion_criteria: s.completionCriteria } : {}),
        }));
    }
    const attachments = liveAttachments(item.attachments);
    if (attachments.length > 0) {
        const owners = attachments.some((att) => att.kind === "file")
            ? await ctx.db.query("fileOwners")
                .withIndex("by_user_item", (q) => q.eq("userId", userId).eq("itemId", item.id))
                .collect()
            : [];
        view.attachments = await Promise.all(attachments.map(async (att) => {
            let fileUrl: string | null = null;
            if (att.kind === "file" && att.storageId && owners.some((owner) =>
                owner.attachmentId === att.id && owner.storageId === att.storageId
            )) {
                try {
                    fileUrl = await ctx.storage.getUrl(att.storageId as Id<"_storage">);
                } catch {
                    // 壊れた参照があってもタスク一覧は返す
                }
            }
            return {
            id: att.id,
            kind: att.kind,
            title: attachmentLabel(att),
            ...(att.url ? { url: att.url } : {}),
            ...(att.text ? { text: att.text } : {}),
            ...(fileUrl ? { url: fileUrl } : {}),
            ...(att.mimeType ? { mime_type: att.mimeType } : {}),
            ...(att.size ? { size: att.size } : {}),
            added_by: att.by,
            };
        }));
    }
    return view;
}

function attributionView(item: StoredItem) {
    return {
        ...(item.createdBy ? { created_by: item.createdBy === "ai" ? "agent" as const : "user" as const } : {}),
        ...(item.createdByClient ? { created_by_client: item.createdByClient } : {}),
        ...(item.done && item.completedBy ? { completed_by: item.completedBy === "ai" ? "agent" as const : "user" as const } : {}),
        ...(item.done && item.completedByClient ? { completed_by_client: item.completedByClient } : {}),
    };
}

/** 見積もりの合計。画面のフッタと同じく、未完了のタスクを親も子も足す */
function remainingMinutes(items: StoredItem[], roots: StoredItem[]): number {
    const counted = new Set<string>();
    let total = 0;
    for (const root of roots) {
        for (const item of subtreeOf(items, root.id)) {
            if (counted.has(item.id)) continue;
            counted.add(item.id);
            if (item.type === "task" && !item.done && !item.locked) total += item.estimate ?? 0;
        }
    }
    return total;
}

export const list = internalQuery({
    args: {
        userId: v.string(),
        includeDone: v.optional(v.boolean()),
        label: v.optional(v.string()),
        today: v.optional(v.union(v.boolean(), v.string())),
        query: v.optional(v.string()),
        flat: v.optional(v.boolean()),
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
    },
    handler: async (ctx, { userId, includeDone, label, today, query, flat, limit = 50, offset = 0 }) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConvexError("limit must be 1-100");
        if (!Number.isInteger(offset) || offset < 0) throw new ConvexError("offset must be a non-negative integer");
        if (query && query.length > 200) throw new ConvexError("query must be at most 200 characters");
        const term = query?.trim().toLocaleLowerCase();
        const todayDate = await resolveToday(ctx, userId, today);

        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((i) => [i.id, i]));

        const labels = items
            .filter((i) => i.type === "section" && i.text.trim())
            .map((i) => i.text.trim());

        const wantedLabel = label?.trim() ? findLabel(items, label) : undefined;
        if (label?.trim() && !wantedLabel) throw new ConvexError("label not found");

        /** いちばん近いラベル。サブタスクでも所属が分かるように上までたどる */
        const labelOf = (item: StoredItem): StoredItem | undefined => {
            let current = item.parentId ? byId.get(item.parentId) : undefined;
            const seen = new Set<string>();
            while (current && current.type !== "section" && !seen.has(current.id)) {
                seen.add(current.id);
                current = current.parentId ? byId.get(current.parentId) : undefined;
            }
            return current?.type === "section" ? current : undefined;
        };

        const picked: StoredItem[] = [];
        for (const item of items.filter((i) => i.type === "task" && i.text.trim())) {
            const parent = item.parentId ? byId.get(item.parentId) : undefined;
            if (todayDate) {
                // today はサブタスクにも付くので、深さによらず拾う
                if (item.assignedDate !== todayDate) continue;
            } else if (!term && !flat && parent?.type === "task") {
                // サブタスクは親の下にまとめて出すので、単体では並べない
                continue;
            }
            if (!includeDone && item.done) continue;
            if (wantedLabel && labelOf(item)?.id !== wantedLabel.id) continue;
            if (term && !`${item.text}\n${item.note ?? ""}`.toLocaleLowerCase().includes(term)) continue;
            picked.push(item);
        }

        const page = picked.slice(offset, offset + limit);
        const tasks = await Promise.all(page.map(async (item) => {
            const subtasks = term || flat ? [] : childrenOf(items, item.id).filter((s) => s.text.trim());
            const view = await toView(
                ctx,
                userId,
                item,
                labelOf(item)?.text.trim(),
                includeDone ? subtasks : subtasks.filter((s) => !s.done)
            );
            if (flat && item.parentId && byId.get(item.parentId)?.type === "task") {
                view.parent_task = byId.get(item.parentId)?.text;
            }
            return view;
        }));

        const result = {
            labels: [...new Set(labels)],
            tasks,
            total_matching: picked.length,
            ...(offset + page.length < picked.length ? { next_offset: offset + page.length } : {}),
        };
        if (!todayDate) return result;
        return {
            ...result,
            today_date: todayDate,
            today_remaining_minutes: remainingMinutes(items, picked),
        };
    },
});

/** Read-only MCP Apps projection: preserve the web list's tree and visual metadata. */
export const taskView = internalQuery({
    args: { userId: v.string(), offset: v.optional(v.number()) },
    handler: async (ctx, { userId, offset = 0 }) => {
        if (!Number.isInteger(offset) || offset < 0) throw new ConvexError("offset must be a non-negative integer");
        const stored = await loadItems(ctx, userId);
        // Explicitly project display fields; never send sync stamps or storage ownership references.
        const items: Item[] = stored.map((item) => ({
            id: item.id, type: item.type, parentId: item.parentId, order: item.order,
            text: item.text, done: item.done, createdAt: item.createdAt, updatedAt: item.updatedAt,
            ...(item.locked ? { locked: true } : {}),
            ...(typeof item.note === "string" && item.note ? { note: item.note } : {}),
            ...(item.completionCriteria ? { completionCriteria: item.completionCriteria } : {}),
            ...(isLabelColor(item.color) ? { color: item.color } : {}),
            ...(item.kind === "main" || item.kind === "tanomi" ? { kind: item.kind } : {}),
            ...(item.filed === true ? { filed: true } : {}),
            ...(item.assignedDate ? { assignedDate: item.assignedDate } : {}),
            ...(item.dueDate ? { dueDate: item.dueDate } : {}),
            ...(item.dueTime ? { dueTime: item.dueTime } : {}),
            ...(typeof item.estimate === "number" ? { estimate: item.estimate } : {}),
            ...(item.createdBy ? { createdBy: item.createdBy } : {}),
            ...(item.createdByClient ? { createdByClient: item.createdByClient } : {}),
            ...(item.completedBy ? { completedBy: item.completedBy } : {}),
            ...(item.completedByClient ? { completedByClient: item.completedByClient } : {}),
        })).sort(compareItems);
        const prefs = await ctx.db.query("userPreferences").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
        const timeZone = prefs?.timeZone ?? "UTC";
        const page = items.slice(offset, offset + 200);
        return {
            items: page,
            today_date: dateInTimeZone(timeZone),
            time_zone: timeZone,
            total: items.length,
            ...(offset + page.length < items.length ? { next_offset: offset + page.length } : {}),
        };
    },
});

/** A selected task is read again by ID so the agent never works from a stale picker page. */
export const get = internalQuery({
    args: { userId: v.string(), taskId: v.string() },
    handler: async (ctx, { userId, taskId }) => {
        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((item) => [item.id, item]));
        const target = byId.get(taskId);
        if (!target || target.type !== "task") throw new ConvexError("task not found");

        const path: { id: string; text: string; type: "task" | "section" }[] = [];
        const seen = new Set<string>();
        let parent = target.parentId ? byId.get(target.parentId) : undefined;
        while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            path.unshift({ id: parent.id, text: parent.text, type: parent.type });
            parent = parent.parentId ? byId.get(parent.parentId) : undefined;
        }
        const label = [...path].reverse().find((entry) => entry.type === "section")?.text;
        const visited = new Set<string>();
        const build = async (item: StoredItem): Promise<TaskView> => {
            visited.add(item.id);
            const children = childrenOf(items, item.id)
                .filter((child) => child.type === "task" && !visited.has(child.id));
            const view = await toView(ctx, userId, item, item.id === target.id ? label : undefined, []);
            if (children.length) view.subtasks = await Promise.all(children.map(build));
            return view;
        };
        return { task: await build(target), path };
    },
});

/** Preserve partial work without ever completing the selected parent implicitly. */
export const recordProgress = internalMutation({
    args: {
        userId: v.string(),
        taskId: v.string(),
        completedSubtaskIds: v.array(v.string()),
        remainingSubtasks: v.array(v.object({ text: v.string(), note: v.optional(v.string()) })),
        progressNote: v.optional(v.string()),
        clientName: v.optional(v.string()),
    },
    handler: async (ctx, { userId, taskId, completedSubtaskIds, remainingSubtasks, progressNote, clientName }) => {
        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((item) => [item.id, item]));
        const target = byId.get(taskId);
        if (!target || target.type !== "task") throw new ConvexError("task not found");
        if (target.done) throw new ConvexError("task is already complete");
        if (completedSubtaskIds.length > 100 || remainingSubtasks.length > 50) {
            throw new ConvexError("too many subtasks in one update");
        }
        const selected = new Set(completedSubtaskIds);
        if (selected.size !== completedSubtaskIds.length) throw new ConvexError("duplicate completed_subtask_ids");
        for (const id of completedSubtaskIds) {
            const item = byId.get(id);
            if (!item || item.type !== "task" || id === target.id || !isInside(byId, id, target.id)) {
                throw new ConvexError("completed subtask must belong to the selected task");
            }
            if (item.locked) throw new ConvexError("task is locked; unlock it in the detail panel before completing it");
            if (subtreeOf(items, id).some((child) => child.id !== id && child.type === "task" && !child.done && !selected.has(child.id))) {
                throw new ConvexError("complete unfinished descendants first");
            }
        }
        if (remainingSubtasks.length && depthOf(byId, taskId) >= MAX_DEPTH) {
            throw new ConvexError("task is at maximum depth; attach a progress note instead");
        }
        const directChildren = childrenOf(items, taskId);
        const existingByText = new Map(directChildren.map((item) => [item.text.trim().toLocaleLowerCase(), item]));
        const newSubtasks: { text: string; note?: string }[] = [];
        const reused: { id: string; text: string }[] = [];
        const requested = new Set<string>();
        for (const subtask of remainingSubtasks) {
            const text = subtask.text.trim();
            if (!text || text.length > 500) throw new ConvexError("subtask text must be 1-500 characters");
            const key = text.toLocaleLowerCase();
            if (requested.has(key)) continue;
            requested.add(key);
            const existing = existingByText.get(key);
            if (existing?.done) throw new ConvexError("matching subtask is already complete; describe the remaining action separately");
            if (existing) reused.push({ id: existing.id, text: existing.text });
            else newSubtasks.push({ text, note: subtask.note?.trim() || undefined });
        }
        if (progressNote && progressNote.trim().length > 4000) throw new ConvexError("progress_note is too long");
        const duplicateNote = progressNote?.trim() && liveAttachments(target.attachments).some((att) =>
            att.kind === "text" && att.text === progressNote.trim() && att.by === "ai");
        if (progressNote?.trim() && !duplicateNote && liveAttachments(target.attachments).length >= MAX_ATTACHMENTS) {
            throw new ConvexError(`a task holds at most ${MAX_ATTACHMENTS} attachments`);
        }

        let stamp = stampAfter(items);
        for (const id of completedSubtaskIds) {
            const item = byId.get(id)!;
            if (item.done) continue;
            await writeItem(ctx, userId, {
                ...item, done: true, completedBy: "ai", completedByClient: clientLabel(clientName), updatedAt: stamp++,
            });
        }
        const added: { id: string; text: string }[] = [];
        let order = nextOrder(items, taskId);
        for (const subtask of newSubtasks) {
            const item: StoredItem = {
                id: crypto.randomUUID(), type: "task", parentId: taskId, order: order++, text: subtask.text,
                note: subtask.note, done: false, createdBy: "ai", createdByClient: clientLabel(clientName),
                createdAt: stamp, updatedAt: stamp++,
            };
            await writeItem(ctx, userId, item);
            added.push({ id: item.id, text: item.text });
        }
        if (progressNote?.trim() && !duplicateNote) {
            const attachment = attachmentFrom({ text: progressNote.trim(), title: "作業の途中経過" }, "ai", crypto.randomUUID(), stamp++);
            if (!attachment) throw new ConvexError("invalid progress_note");
            await writeItem(ctx, userId, {
                ...target, attachments: [...(target.attachments ?? []), attachment], updatedAt: stamp,
            });
        }
        return { task_id: taskId, done: false, completed_subtask_ids: completedSubtaskIds, added_subtasks: added, existing_subtasks: reused };
    },
});

export const previewDelete = internalQuery({
    args: { userId: v.string(), taskId: v.string() },
    handler: async (ctx, { userId, taskId }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((item) => item.id === taskId && item.type === "task");
        if (!target) throw new ConvexError("task not found");
        return { id: target.id, text: target.text, count: subtreeOf(items, target.id).length };
    },
});

export const add = internalMutation({
    args: {
        userId: v.string(),
        text: v.string(),
        note: v.optional(v.string()),
        label: v.optional(v.string()),
        estimateMinutes: v.optional(v.number()),
        parentId: v.optional(v.string()),
        dueDate: v.optional(v.string()),
        dueTime: v.optional(v.string()),
        completionCriteria: v.optional(v.string()),
        idempotencyKey: v.optional(v.string()),
        clientName: v.optional(v.string()),
    },
    handler: async (ctx, { userId, text, note, label, estimateMinutes, parentId, dueDate, dueTime, completionCriteria, idempotencyKey, clientName }) => {
        const trimmed = text.trim();
        if (!trimmed) throw new ConvexError("text is empty");
        if (label !== undefined && !label.trim() && !parentId) throw new ConvexError("label is empty");
        validateDeadline(dueDate, dueTime);
        if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 128)) {
            throw new ConvexError("idempotency_key must be 1-128 characters");
        }
        const request = JSON.stringify({ text: trimmed, note: note?.trim() || null, label: label?.trim() || null,
            estimateMinutes: estimateMinutes ?? null, parentId: parentId ?? null, dueDate: dueDate || null,
            dueTime: dueTime || null, completionCriteria: completionCriteria?.trim() || null });
        const autoKey = `auto:${requestHash(request)}`;
        const explicitKey = idempotencyKey ? `explicit:${idempotencyKey}` : undefined;
        if (explicitKey) {
            const prior = await previousAdd(ctx, userId, explicitKey, request, true);
            if (prior !== undefined) return prior;
        }
        const recent = await previousAdd(ctx, userId, autoKey, request, false);
        if (recent !== undefined) {
            if (explicitKey) await rememberAdd(ctx, userId, explicitKey, request, recent);
            return recent;
        }

        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((i) => [i.id, i]));

        let parent: string | null = null;
        if (parentId) {
            const target = byId.get(parentId);
            if (!target) throw new ConvexError("parent not found");
            parent = target.id;
        } else if (label?.trim()) {
            const wanted = label.trim().toLowerCase();
            const found = items.find(
                (i) => i.type === "section" && i.text.trim().toLowerCase() === wanted
            );
            if (!found) throw new ConvexError("label not found");
            parent = found.id;
        }

        const now = stampAfter(items);
        const item: StoredItem = {
            id: crypto.randomUUID(),
            type: "task",
            parentId: parent,
            order: nextOrder(items, parent),
            text: trimmed,
            done: false,
            createdBy: "ai",
            createdByClient: clientLabel(clientName),
            createdAt: now,
            updatedAt: now,
        };
        if (note?.trim()) item.note = note;
        if (dueDate) item.dueDate = dueDate;
        if (dueTime) item.dueTime = dueTime;
        if (completionCriteria?.trim()) item.completionCriteria = completionCriteria.trim();
        if (typeof estimateMinutes === "number" && estimateMinutes > 0) {
            item.estimate = Math.round(estimateMinutes);
        }

        await writeItem(ctx, userId, item);
        const response = { id: item.id, text: item.text };
        await rememberAdd(ctx, userId, autoKey, request, response);
        if (explicitKey) await rememberAdd(ctx, userId, explicitKey, request, response);
        return response;
    },
});

export const complete = internalMutation({
    args: { userId: v.string(), taskId: v.string(), done: v.optional(v.boolean()), clientName: v.optional(v.string()) },
    handler: async (ctx, { userId, taskId, done, clientName }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((i) => i.id === taskId);
        if (!target || target.type !== "task") throw new ConvexError("task not found");

        const next = done ?? true;
        let stamp = stampAfter(items);

        // 子タスクも一緒に。クライアントの toggleDone と揃える
        const subtree = subtreeOf(items, target.id);
        if (next && subtree.some((item) => item.type === "task" && item.locked)) {
            throw new ConvexError("task or descendant is locked; unlock it in the detail panel before completing it");
        }
        for (const item of subtree) {
            if (item.type !== "task" || item.done === next) continue;
            await writeItem(ctx, userId, {
                ...item,
                done: next,
                filed: next ? item.filed : undefined,
                completedBy: next ? "ai" : undefined,
                completedByClient: next ? clientLabel(clientName) : undefined,
                updatedAt: stamp++,
            });
        }
        return { id: target.id, text: target.text, done: next };
    },
});

export const update = internalMutation({
    args: {
        userId: v.string(),
        taskId: v.string(),
        text: v.optional(v.string()),
        note: v.optional(v.string()),
        estimateMinutes: v.optional(v.number()),
        today: v.optional(v.union(v.boolean(), v.string())),
        dueDate: v.optional(v.string()),
        dueTime: v.optional(v.string()),
        completionCriteria: v.optional(v.string()),
    },
    handler: async (ctx, { userId, taskId, text, note, estimateMinutes, today, dueDate, dueTime, completionCriteria }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((i) => i.id === taskId);
        if (!target) throw new ConvexError("task not found");
        const todayDate = await resolveToday(ctx, userId, today);
        if (today && target.type !== "task") throw new ConvexError("only tasks can go into today");
        const nextDueDate = dueDate === undefined ? target.dueDate : dueDate || undefined;
        const nextDueTime = dueTime === undefined ? (nextDueDate ? target.dueTime : undefined) : dueTime || undefined;
        validateDeadline(nextDueDate, nextDueTime);
        if ((dueDate !== undefined || dueTime !== undefined || completionCriteria !== undefined) && target.type !== "task") {
            throw new ConvexError("only tasks can have deadlines and completion criteria");
        }

        const next: StoredItem = { ...target, updatedAt: stampAfter(items) };
        if (text !== undefined) {
            if (!text.trim()) throw new ConvexError("text is empty");
            next.text = text.trim();
        }
        if (note !== undefined) next.note = note.trim() ? note : undefined;
        if (estimateMinutes !== undefined) {
            next.estimate = estimateMinutes > 0 ? Math.round(estimateMinutes) : undefined;
        }
        if (today !== undefined) next.assignedDate = todayDate;
        if (dueDate !== undefined || dueTime !== undefined) {
            next.dueDate = nextDueDate;
            next.dueTime = nextDueTime;
        }
        if (completionCriteria !== undefined) next.completionCriteria = completionCriteria.trim() || undefined;

        await writeItem(ctx, userId, next);
        return { id: next.id, text: next.text, today: next.assignedDate };
    },
});

/**
 * AI がタスクにコンテキスト（リンクか文章）を添える。人が画面で添えるのと同じ形で、
 * 同期では1件ずつ ID で足し合わせるので、同時に人が添えても消えない。
 */
export const attach = internalMutation({
    args: {
        userId: v.string(),
        taskId: v.string(),
        url: v.optional(v.string()),
        text: v.optional(v.string()),
        title: v.optional(v.string()),
    },
    handler: async (ctx, { userId, taskId, url, text, title }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((i) => i.id === taskId);
        if (!target) throw new ConvexError("task not found");
        if (target.type !== "task") throw new ConvexError("only tasks take context");
        if ((url?.trim() ? 1 : 0) + (text?.trim() ? 1 : 0) !== 1) {
            throw new ConvexError("give exactly one of url or text");
        }
        if (liveAttachments(target.attachments).length >= MAX_ATTACHMENTS) {
            throw new ConvexError(`a task holds at most ${MAX_ATTACHMENTS} attachments`);
        }
        const now = stampAfter(items);
        const attachment = attachmentFrom({ url, text, title }, "ai", crypto.randomUUID(), now);
        if (!attachment) throw new ConvexError("url must start with http:// or https://");

        const next: StoredItem = {
            ...target,
            attachments: [...(target.attachments ?? []), attachment],
            updatedAt: now,
        };
        await writeItem(ctx, userId, next);
        return { id: attachment.id, task_id: target.id, kind: attachment.kind, title: attachmentLabel(attachment) };
    },
});

/** 認証済みの HTTP アップロードだけが呼ぶ。実体と所有者を同じトランザクションで記録する。 */
export const attachFile = internalMutation({
    args: {
        userId: v.string(),
        taskId: v.string(),
        attachmentId: v.string(),
        storageId: v.id("_storage"),
        title: v.string(),
        mimeType: v.string(),
        size: v.number(),
    },
    handler: async (ctx, { userId, taskId, attachmentId, storageId, title, mimeType, size }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((item) => item.id === taskId && item.type === "task");
        if (!target) throw new ConvexError("task not found");
        if (liveAttachments(target.attachments).length >= MAX_ATTACHMENTS) {
            throw new ConvexError(`a task holds at most ${MAX_ATTACHMENTS} attachments`);
        }
        const now = stampAfter(items);
        const attachment = attachmentFrom(
            { storageId, title, mimeType, size }, "human", attachmentId, now
        );
        if (!attachment) throw new ConvexError("invalid file");
        await writeItem(ctx, userId, {
            ...target,
            attachments: [...(target.attachments ?? []), attachment],
            updatedAt: now,
        });
        await ctx.db.insert("fileOwners", { userId, itemId: taskId, attachmentId, storageId });
        return { id: attachmentId, storageId, title: attachment.title, mimeType, size };
    },
});

/** クライアントの MAX_DEPTH（src/lib/taskModel.ts）と揃える。ラベルが深さ0 */
const MAX_DEPTH = 4;

function findLabel(items: StoredItem[], name: string): StoredItem | undefined {
    const wanted = name.trim().toLowerCase();
    return items.find((i) => i.type === "section" && i.text.trim().toLowerCase() === wanted);
}

function depthOf(byId: Map<string, StoredItem>, id: string): number {
    let depth = 0;
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentId);
        depth++;
    }
    return depth;
}

/** 自分より下に何段あるか。子がなければ0 */
function subtreeHeight(items: StoredItem[], id: string, seen = new Set<string>()): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    let max = 0;
    for (const child of childrenOf(items, id)) {
        max = Math.max(max, 1 + subtreeHeight(items, child.id, seen));
    }
    return max;
}

function isInside(byId: Map<string, StoredItem>, id: string, ancestorId: string): boolean {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
        if (current.id === ancestorId) return true;
        seen.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
}

export const addLabel = internalMutation({
    args: { userId: v.string(), name: v.string() },
    handler: async (ctx, { userId, name }) => {
        const trimmed = name.trim();
        if (!trimmed) throw new ConvexError("name is empty");

        const items = await loadItems(ctx, userId);
        if (findLabel(items, trimmed)) throw new ConvexError("label already exists");

        // ラベルは常にルート直下。いちばん下に足す
        const now = stampAfter(items);
        const item: StoredItem = {
            id: crypto.randomUUID(),
            type: "section",
            parentId: null,
            order: nextOrder(items, null),
            text: trimmed,
            done: false,
            createdAt: now,
            updatedAt: now,
        };
        await writeItem(ctx, userId, item);
        return { label: item.text };
    },
});

/** 移し先を決める。ラベル名かタスク id、どちらも無ければルート */
function resolveDestination(
    items: StoredItem[],
    byId: Map<string, StoredItem>,
    label: string | undefined,
    parentTaskId: string | undefined
): string | null {
    if (parentTaskId) {
        const parent = byId.get(parentTaskId);
        if (!parent || parent.type !== "task") throw new ConvexError("parent task not found");
        return parent.id;
    }
    if (label?.trim()) {
        const found = findLabel(items, label);
        if (!found) throw new ConvexError("label not found");
        return found.id;
    }
    return null;
}

export const move = internalMutation({
    args: {
        userId: v.string(),
        taskId: v.string(),
        label: v.optional(v.string()),
        parentTaskId: v.optional(v.string()),
    },
    handler: async (ctx, { userId, taskId, label, parentTaskId }) => {
        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((i) => [i.id, i]));
        const target = byId.get(taskId);
        if (!target || target.type !== "task") throw new ConvexError("task not found");

        const parent = resolveDestination(items, byId, label, parentTaskId);
        if (parent && isInside(byId, parent, target.id)) {
            throw new ConvexError("cannot move a task into itself");
        }
        const depth = parent ? depthOf(byId, parent) + 1 : 0;
        if (depth + subtreeHeight(items, target.id) > MAX_DEPTH) {
            throw new ConvexError("too deep");
        }

        await writeItem(ctx, userId, {
            ...target,
            parentId: parent,
            order: nextOrder(items, parent),
            updatedAt: stampAfter(items),
        });
        return { id: target.id, text: target.text, label: label?.trim() || undefined };
    },
});

/** ラベルをタスクに変える。中にあったタスクはそのままサブタスクになる */
export const labelToTask = internalMutation({
    args: { userId: v.string(), label: v.string(), intoLabel: v.optional(v.string()) },
    handler: async (ctx, { userId, label, intoLabel }) => {
        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((i) => [i.id, i]));
        const source = findLabel(items, label);
        if (!source) throw new ConvexError("label not found");

        const parent = resolveDestination(items, byId, intoLabel, undefined);
        if (parent === source.id) throw new ConvexError("cannot move a label into itself");
        const depth = parent ? 1 : 0;
        if (depth + subtreeHeight(items, source.id) > MAX_DEPTH) {
            throw new ConvexError("too deep");
        }

        const next: StoredItem = {
            ...source,
            type: "task",
            parentId: parent,
            order: nextOrder(items, parent),
            updatedAt: stampAfter(items),
        };
        delete next.color;
        await writeItem(ctx, userId, next);
        return { id: next.id, text: next.text, label: intoLabel?.trim() || undefined };
    },
});

/**
 * まとめて足す。1件ずつ呼ぶと往復が増えるうえ、並びが呼んだ順に
 * ならない（同じミリ秒に届くと order の取り合いになる）。
 */
export const addMany = internalMutation({
    args: {
        userId: v.string(),
        tasks: v.array(
            v.object({
                text: v.string(),
                note: v.optional(v.string()),
                estimateMinutes: v.optional(v.number()),
                subtasks: v.optional(
                    v.array(
                        v.object({
                            text: v.string(),
                            note: v.optional(v.string()),
                            estimateMinutes: v.optional(v.number()),
                        })
                    )
                ),
            })
        ),
        label: v.optional(v.string()),
        parentId: v.optional(v.string()),
        clientName: v.optional(v.string()),
    },
    handler: async (ctx, { userId, tasks, label, parentId, clientName }) => {
        if (tasks.length === 0) throw new ConvexError("tasks is empty");
        if (tasks.some((t) => !t.text.trim())) throw new ConvexError("text is empty");
        if (label !== undefined && !label.trim() && !parentId) throw new ConvexError("label is empty");

        const items = await loadItems(ctx, userId);
        const byId = new Map(items.map((i) => [i.id, i]));

        let parent: string | null = null;
        if (parentId) {
            const target = byId.get(parentId);
            if (!target) throw new ConvexError("parent not found");
            parent = target.id;
        } else if (label?.trim()) {
            const found = findLabel(items, label);
            if (!found) throw new ConvexError("label not found");
            parent = found.id;
        }

        const hasSubtasks = tasks.some((t) => t.subtasks?.length);
        const depth = parent ? depthOf(byId, parent) + 1 : 0;
        if (depth + (hasSubtasks ? 1 : 0) > MAX_DEPTH) throw new ConvexError("too deep");

        // 並びは呼ばれた順。order と updatedAt を自分で進めて、取り合いを避ける
        let stamp = stampAfter(items);
        let order = nextOrder(items, parent);
        const added: { id: string; text: string }[] = [];

        const write = async (
            task: { text: string; note?: string; estimateMinutes?: number },
            itemParent: string | null,
            itemOrder: number
        ): Promise<string> => {
            const item: StoredItem = {
                id: crypto.randomUUID(),
                type: "task",
                parentId: itemParent,
                order: itemOrder,
                text: task.text.trim(),
                done: false,
                createdBy: "ai",
                createdByClient: clientLabel(clientName),
                createdAt: stamp,
                updatedAt: stamp++,
            };
            if (task.note?.trim()) item.note = task.note;
            if (typeof task.estimateMinutes === "number" && task.estimateMinutes > 0) {
                item.estimate = Math.round(task.estimateMinutes);
            }
            await writeItem(ctx, userId, item);
            added.push({ id: item.id, text: item.text });
            return item.id;
        };

        for (const task of tasks) {
            const id = await write(task, parent, order++);
            let childOrder = 0;
            for (const sub of task.subtasks ?? []) {
                if (!sub.text.trim()) throw new ConvexError("text is empty");
                await write(sub, id, childOrder++);
            }
        }

        return { added };
    },
});

/** 自分と、その下にあるものすべて */
function subtreeOf(items: StoredItem[], id: string): StoredItem[] {
    const result: StoredItem[] = [];
    const stack = [id];
    const seen = new Set<string>();
    const byId = new Map(items.map((i) => [i.id, i]));
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const item = byId.get(current);
        if (item) result.push(item);
        for (const child of childrenOf(items, current)) stack.push(child.id);
    }
    return result;
}

/**
 * タスクを消す。サブタスクも一緒に。クライアントの remove と揃える。
 * 行は残して deletedAt を打つ。消えたことを他の端末の pull に伝えるため。
 */
export const remove = internalMutation({
    args: { userId: v.string(), taskId: v.string(), expectedText: v.string(), expectedCount: v.number() },
    handler: async (ctx, { userId, taskId, expectedText, expectedCount }) => {
        const items = await loadItems(ctx, userId);
        const target = items.find((i) => i.id === taskId);
        if (!target || target.type !== "task") throw new ConvexError("task not found");

        const doomed = subtreeOf(items, target.id);
        if (target.text !== expectedText || doomed.length !== expectedCount) {
            throw new ConvexError("task changed; confirm deletion again");
        }
        let stamp = stampAfter(items);
        for (const item of doomed) {
            const updatedAt = stamp++;
            await writeItem(ctx, userId, { ...item, deletedAt: updatedAt, updatedAt });
        }
        return { id: target.id, text: target.text, deleted: doomed.length };
    },
});
