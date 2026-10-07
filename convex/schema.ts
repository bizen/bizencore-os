import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { lifeEntryFields, lifeCheckFields, lifePreferenceFields } from './lifeWorldFields';

export default defineSchema({
    partnerAccounts: defineTable({
        userId: v.string(), name: v.string(), partnerId: v.optional(v.string()),
        sharedLabelIds: v.array(v.string()),
    }).index('by_user', ['userId']),
    partnerInvites: defineTable({
        ownerId: v.string(), code: v.string(), expiresAt: v.number(),
    }).index('by_owner', ['ownerId']).index('by_code', ['code']),
    lifeEntries: defineTable({ userId: v.string(), ...lifeEntryFields })
        .index('by_user', ['userId']).index('by_user_entry', ['userId', 'id']),
    lifeChecks: defineTable({ userId: v.string(), ...lifeCheckFields })
        .index('by_user', ['userId']).index('by_user_entry_date', ['userId', 'entryId', 'date']),
    lifePreferences: defineTable({ userId: v.string(), ...lifePreferenceFields }).index('by_user', ['userId']),
    /**
     * タスクツリーの同期用ストア。
     * クライアント（localStorage）が正で、ここは任意サインイン時のミラー。
     * payload はアイテムの JSON。サーバ側は中身を解釈しない。
     */
    syncItems: defineTable({
        userId: v.string(),
        itemId: v.string(),
        updatedAt: v.number(),
        deletedAt: v.optional(v.number()),
        payload: v.string(),
    })
        .index("by_user", ["userId"])
        .index("by_user_item", ["userId", "itemId"]),

    /** サーバがアップロードしたファイルだけを、参照削除時に回収するための台帳 */
    fileOwners: defineTable({
        userId: v.string(),
        itemId: v.string(),
        attachmentId: v.string(),
        storageId: v.id("_storage"),
    }).index("by_user_item", ["userId", "itemId"]),

    /** MCP の認証済みリクエストを受けた接続元。認可状態そのものではない。 */
    mcpConnections: defineTable({
        userId: v.string(),
        clientId: v.string(),
        clientName: v.optional(v.string()),
        lastUsedAt: v.number(),
    })
        .index("by_user", ["userId"])
        .index("by_user_client", ["userId", "clientId"]),

    userPreferences: defineTable({
        userId: v.string(),
        timeZone: v.string(),
        automatic: v.boolean(),
        updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    mcpIdempotency: defineTable({
        userId: v.string(),
        key: v.string(),
        request: v.string(),
        response: v.string(),
        createdAt: v.number(),
    })
        .index("by_user_key", ["userId", "key"])
        .index("by_user_createdAt", ["userId", "createdAt"]),

    /** character count のストック（ログイン時に Convex へ） */
    countStocks: defineTable({
        userId: v.string(),
        text: v.string(),
        savedAt: v.number(),
    }).index("by_user", ["userId"]),

    /* ---------- 以下は旧スキーマ。既存ドキュメントの互換と一度きりの移行のためだけに残す ---------- */

    taskListEntries: defineTable({
        userId: v.string(),
        order: v.number(),
        kind: v.union(v.literal("task"), v.literal("section")),
        taskId: v.optional(v.id("tasks")),
        sectionTitle: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    tasks: defineTable({
        userId: v.string(),
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
        kind: v.optional(v.union(v.literal("main"), v.literal("tanomi"))),
        summary: v.optional(v.string()),
        dueDate: v.optional(v.string()),
        assignedDate: v.optional(v.string()),
        todayOrder: v.optional(v.number()),
        goalId: v.optional(v.id("goals")),
        scheduleStartAt: v.optional(v.number()),
        scheduleEndAt: v.optional(v.number()),
        scheduleStart: v.optional(v.string()),
        scheduleEnd: v.optional(v.string()),
        order: v.optional(v.number()),
        blockId: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    goals: defineTable({
        userId: v.string(),
        title: v.string(),
        dueDate: v.optional(v.string()),
        order: v.number(),
        createdAt: v.number(),
    }).index("by_user", ["userId"]),
});
