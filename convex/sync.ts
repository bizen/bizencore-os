import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mergeItems } from "../src/lib/itemMerge";
import { coerceAttachments } from "../src/lib/attachments";
import { cleanupFiles } from "./fileCleanup";
import { isDateString, isTimeZone } from "../src/lib/taskDates";
import { coerceLifeData, lifeCheckKey, lifeEntryStamp, lifeSubtreeEntries, mergeLifeEntry, mergeLifePreferences } from '../src/lib/lifeWorldModel';
import { lifeEntryFields, lifeCheckFields, lifePreferenceFields } from './lifeWorldFields';
import { accountActive, requireActiveAccount } from './accountAccess';

export const lifeWorldPull = query({
    args: { accountId: v.string() },
    handler: async (ctx, { accountId }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || identity.subject !== accountId || !(await accountActive(ctx, identity.subject))) return null;
        const entries = await ctx.db.query('lifeEntries')
            .withIndex('by_user', q => q.eq('userId', identity.subject)).collect();
        const checks = await ctx.db.query('lifeChecks')
            .withIndex('by_user', q => q.eq('userId', identity.subject)).collect();
        const preferences = await ctx.db.query('lifePreferences')
            .withIndex('by_user', q => q.eq('userId', identity.subject)).unique();
        return coerceLifeData({ version: 1,
            entries: Object.fromEntries(entries.map(entry => [entry.id, entry])),
            checks: Object.fromEntries(checks.map(check => [lifeCheckKey(check.entryId, check.date), check])),
            preferences,
        });
    },
});

export const lifeWorldPush = mutation({
    args: { accountId: v.string(), entries: v.array(v.object(lifeEntryFields)), checks: v.array(v.object(lifeCheckFields)),
        preferences: v.optional(v.object(lifePreferenceFields)) },
    handler: async (ctx, { accountId, entries, checks, preferences }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || identity.subject !== accountId) throw new Error('Unauthorized');
        await requireActiveAccount(ctx, identity.subject);
        if (entries.length > 100 || checks.length > 100) throw new Error('Life world batch exceeds limit');
        const validStamp = (stamp: number) => Number.isFinite(stamp) && stamp >= 0;
        if (preferences && (!validStamp(preferences.updatedAt) || !validStamp(preferences.visibilityStamp) ||
            !validStamp(preferences.placementStamp) || preferences.visibilityStamp > preferences.updatedAt ||
            preferences.placementStamp > preferences.updatedAt || (preferences.beforeId?.length ?? 0) > 256)) {
            throw new Error('Invalid life preferences');
        }
        const ids = new Set<string>();
        for (const entry of entries) {
            if (!entry.id || entry.id.length > 256 || ids.has(entry.id) || !isDateString(entry.startDate) ||
                !Number.isFinite(entry.order) || !validStamp(entry.updatedAt) ||
                (entry.deletedAt !== undefined && (!validStamp(entry.deletedAt) || entry.deletedAt > entry.updatedAt)) ||
                entry.text.length > 10000 || entry.note.length > 40000 ||
                entry.parentId === entry.id || (entry.parentId?.length ?? 0) > 256 ||
                Object.values(entry.stamps ?? {}).some(stamp => stamp !== undefined && (!validStamp(stamp) || stamp > entry.updatedAt))) {
                throw new Error('Invalid life entry');
            }
            ids.add(entry.id);
        }
        const checkIds = new Set<string>();
        const effectiveEntries = new Map<string, ReturnType<typeof mergeLifeEntry>>();
        for (const entry of entries) {
            const existing = await ctx.db.query('lifeEntries')
                .withIndex('by_user_entry', q => q.eq('userId', identity.subject).eq('id', entry.id)).unique();
            effectiveEntries.set(entry.id, existing ? mergeLifeEntry(entry, existing) : entry);
        }
        const completeEntries = checks.some(check => check.done) ? await ctx.db.query('lifeEntries')
            .withIndex('by_user', q => q.eq('userId', identity.subject)).collect() : [];
        const effectiveTree = { version: 1 as const, entries: {
            ...Object.fromEntries(completeEntries.map(entry => [entry.id, entry])),
            ...Object.fromEntries(effectiveEntries),
        }, checks: {} };
        for (const check of checks) {
            const key = lifeCheckKey(check.entryId, check.date);
            if (!isDateString(check.date) || !validStamp(check.updatedAt) || checkIds.has(key)) throw new Error('Invalid life check');
            checkIds.add(key);
            let entry = effectiveEntries.get(check.entryId);
            if (!entry) {
                const stored = await ctx.db.query('lifeEntries')
                    .withIndex('by_user_entry', q => q.eq('userId', identity.subject).eq('id', check.entryId)).unique();
                if (!stored) throw new Error('Life entry not found');
                entry = stored;
            }
            if (entry.locked && check.done && check.updatedAt >= (entry.stamps?.lock ?? entry.updatedAt)) throw new Error('Life task is locked');
            if (check.done && lifeSubtreeEntries(effectiveTree, check.entryId)
                .some(child => child.locked && check.updatedAt >= lifeEntryStamp(child, 'lock'))) throw new Error('Life task subtree is locked');
        }
        for (const entry of entries) {
            const existing = await ctx.db.query('lifeEntries')
                .withIndex('by_user_entry', q => q.eq('userId', identity.subject).eq('id', entry.id)).unique();
            if (!existing) await ctx.db.insert('lifeEntries', { userId: identity.subject, ...entry });
            else await ctx.db.patch(existing._id, mergeLifeEntry(entry, existing));
        }
        for (const check of checks) {
            const existing = await ctx.db.query('lifeChecks')
                .withIndex('by_user_entry_date', q => q.eq('userId', identity.subject).eq('entryId', check.entryId).eq('date', check.date)).unique();
            if (!existing) await ctx.db.insert('lifeChecks', { userId: identity.subject, ...check });
            else if (check.updatedAt > existing.updatedAt ||
                (check.updatedAt === existing.updatedAt && check.done && !existing.done)) {
                await ctx.db.patch(existing._id, check);
            }
        }
        if (preferences) {
            const existing = await ctx.db.query('lifePreferences')
                .withIndex('by_user', q => q.eq('userId', identity.subject)).unique();
            const merged = mergeLifePreferences(existing ?? undefined, preferences)!;
            // Whitelist fields; never copy Convex system fields into a patch.
            const value = { showInAll: merged.showInAll, beforeId: merged.beforeId, updatedAt: merged.updatedAt,
                visibilityStamp: merged.visibilityStamp, placementStamp: merged.placementStamp };
            if (existing) await ctx.db.patch(existing._id, value);
            else await ctx.db.insert('lifePreferences', { userId: identity.subject, ...value });
        }
        return { ok: true };
    },
});

export const getTimeZone = query({
    args: {},
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || !(await accountActive(ctx, identity.subject))) return null;
        const row = await ctx.db.query("userPreferences")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject)).unique();
        return row ? { timeZone: row.timeZone, automatic: row.automatic } : null;
    },
});

export const setTimeZone = mutation({
    args: { timeZone: v.string(), automatic: v.boolean() },
    handler: async (ctx, { timeZone, automatic }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);
        if (!isTimeZone(timeZone)) throw new Error("Invalid IANA time zone");
        const existing = await ctx.db.query("userPreferences")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject)).unique();
        if (existing) await ctx.db.patch(existing._id, { timeZone, automatic, updatedAt: Date.now() });
        else await ctx.db.insert("userPreferences", { userId: identity.subject, timeZone, automatic, updatedAt: Date.now() });
    },
});

const syncItemValidator = v.object({
    itemId: v.string(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
    payload: v.string(),
});

/** 実際に MCP を利用した接続元のみ。現在の OAuth 認可状態とは区別する。 */
export const listMcpConnections = query({
    args: {},
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || !(await accountActive(ctx, identity.subject))) return null;
        const rows = await ctx.db.query("mcpConnections")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();
        return rows.map(({ clientId, clientName, lastUsedAt }) => ({ clientId, clientName, lastUsedAt }))
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    },
});

export const touchMcpConnection = internalMutation({
    args: { userId: v.string(), clientId: v.string(), clientName: v.optional(v.string()) },
    handler: async (ctx, { userId, clientId, clientName }) => {
        await requireActiveAccount(ctx, userId);
        if (!clientId || clientId === "unknown" || clientId.length > 512) return;
        const name = clientName?.trim().slice(0, 256) || undefined;
        const existing = await ctx.db.query("mcpConnections")
            .withIndex("by_user_client", (q) => q.eq("userId", userId).eq("clientId", clientId))
            .unique();
        if (existing) {
            await ctx.db.patch(existing._id, { lastUsedAt: Date.now(), clientName: name ?? existing.clientName });
        } else {
            await ctx.db.insert("mcpConnections", { userId, clientId, clientName: name, lastUsedAt: Date.now() });
        }
    },
});

interface PayloadItem {
    updatedAt: number;
    deletedAt?: number;
    [key: string]: unknown;
}

function readPayload(row: {
    updatedAt: number;
    deletedAt?: number;
    payload: string;
}): PayloadItem | null {
    try {
        const raw = JSON.parse(row.payload) as unknown;
        if (typeof raw !== "object" || raw === null) return null;
        // 行の updatedAt / deletedAt を正とする。payload の中の値は古いことがある
        const item: PayloadItem = { ...(raw as object), updatedAt: row.updatedAt };
        if (row.deletedAt) item.deletedAt = row.deletedAt;
        else delete item.deletedAt;
        return item;
    } catch {
        return null;
    }
}

/**
 * 既にある行と、送られてきた行を欄ごとに合わせる（src/lib/itemMerge.ts）。
 * 行ごとに新しい方を採ると、別々の欄への同時の変更が黙って消えるため。
 */
export function mergeRows(
    existing: { updatedAt: number; deletedAt?: number; payload: string },
    incoming: { updatedAt: number; deletedAt?: number; payload: string }
): { updatedAt: number; deletedAt: number | undefined; payload: string } | null {
    const a = readPayload(existing);
    const b = readPayload(incoming);
    if (!a || !b) return null;
    const merged = mergeItems(a, b);
    return {
        updatedAt: merged.updatedAt,
        deletedAt: merged.deletedAt,
        payload: JSON.stringify(merged),
    };
}

/** サインイン中のユーザーのアイテムを全部返す。ローカルとは欄ごとに突き合わせる */
export const pull = query({
    args: {},
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || !(await accountActive(ctx, identity.subject))) return null;

        const rows = await ctx.db
            .query("syncItems")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();

        return rows.map((row) => ({
            itemId: row.itemId,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
            payload: row.payload,
        }));
    },
});

/** タスクに結びついたファイルだけ、そのユーザーへダウンロード URL を返す。 */
export const fileUrl = query({
    args: { taskId: v.string(), attachmentId: v.string() },
    handler: async (ctx, { taskId, attachmentId }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || !(await accountActive(ctx, identity.subject))) return null;
        const row = await ctx.db.query("syncItems")
            .withIndex("by_user_item", (q) => q.eq("userId", identity.subject).eq("itemId", taskId))
            .unique();
        if (!row || row.deletedAt) return null;
        let attachments;
        try {
            attachments = coerceAttachments((JSON.parse(row.payload) as { attachments?: unknown }).attachments);
        } catch {
            return null;
        }
        const file = attachments?.find((att) => att.id === attachmentId && att.kind === "file" && !att.deletedAt);
        if (!file?.storageId) return null;
        const owners = await ctx.db.query("fileOwners")
            .withIndex("by_user_item", (q) => q.eq("userId", identity.subject).eq("itemId", taskId))
            .collect();
        if (!owners.some((owner) => owner.attachmentId === attachmentId && owner.storageId === file.storageId)) return null;
        try {
            return await ctx.storage.getUrl(file.storageId as Id<"_storage">);
        } catch {
            return null;
        }
    },
});

/** ローカルで更新された分を送る。既にある行とは欄ごとに新しい方を採る */
export const push = mutation({
    args: { items: v.array(syncItemValidator) },
    handler: async (ctx, { items }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);

        for (const item of items) {
            const existing = await ctx.db
                .query("syncItems")
                .withIndex("by_user_item", (q) =>
                    q.eq("userId", identity.subject).eq("itemId", item.itemId)
                )
                .unique();

            if (!existing) {
                await ctx.db.insert("syncItems", {
                    userId: identity.subject,
                    itemId: item.itemId,
                    updatedAt: item.updatedAt,
                    deletedAt: item.deletedAt,
                    payload: item.payload,
                });
                continue;
            }

            const merged = mergeRows(existing, item);
            if (!merged) {
                // 中身が読めないときは、以前どおり行ごとに新しい方
                if (existing.updatedAt >= item.updatedAt) continue;
                await ctx.db.patch(existing._id, {
                    updatedAt: item.updatedAt,
                    deletedAt: item.deletedAt,
                    payload: item.payload,
                });
                try {
                    const raw = JSON.parse(item.payload) as { attachments?: unknown };
                    await cleanupFiles(ctx, identity.subject, item.itemId, raw.attachments, !!item.deletedAt);
                } catch {
                    if (item.deletedAt) await cleanupFiles(ctx, identity.subject, item.itemId, undefined, true);
                }
                continue;
            }
            if (merged.payload === existing.payload && merged.updatedAt === existing.updatedAt) {
                continue;
            }
            await ctx.db.patch(existing._id, merged);
            const raw = JSON.parse(merged.payload) as { attachments?: unknown };
            await cleanupFiles(ctx, identity.subject, item.itemId, raw.attachments, !!merged.deletedAt);
        }

        return { ok: true };
    },
});

/**
 * 旧 tasks / taskListEntries を新しいツリーへ一度だけ移行する。
 * 旧「見出し」はそのままラベル（親ノード）になり、その下に並んでいたタスクが子になる。
 */
export const importLegacy = mutation({
    args: {},
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);

        const already = await ctx.db
            .query("syncItems")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .first();
        if (already) return { imported: 0 };

        const entries = await ctx.db
            .query("taskListEntries")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();
        if (entries.length === 0) return { imported: 0 };

        entries.sort((a, b) => a.order - b.order);

        const now = Date.now();
        let rootOrder = 0;
        let childOrder = 0;
        let currentSectionId: string | null = null;
        let imported = 0;

        for (const entry of entries) {
            if (entry.kind === "section") {
                currentSectionId = entry._id;
                childOrder = 0;
                await ctx.db.insert("syncItems", {
                    userId: identity.subject,
                    itemId: entry._id,
                    updatedAt: now,
                    payload: JSON.stringify({
                        type: "section",
                        parentId: null,
                        order: rootOrder++,
                        text: entry.sectionTitle?.trim() || "ラベル",
                        done: false,
                        createdAt: entry._creationTime,
                    }),
                });
                imported += 1;
                continue;
            }

            if (!entry.taskId) continue;
            const task = await ctx.db.get(entry.taskId);
            if (!task || task.userId !== identity.subject) continue;

            await ctx.db.insert("syncItems", {
                userId: identity.subject,
                itemId: task._id,
                updatedAt: now,
                payload: JSON.stringify({
                    type: "task",
                    parentId: currentSectionId,
                    order: currentSectionId ? childOrder++ : rootOrder++,
                    text: task.text,
                    note: task.summary?.trim() || undefined,
                    done: task.done,
                    kind: task.kind,
                    assignedDate: task.assignedDate,
                    createdAt: task.createdAt,
                }),
            });
            imported += 1;
        }

        return { imported };
    },
});
