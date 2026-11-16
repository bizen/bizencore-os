import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { notificationPreferences, pushSubscription, noticeFields } from './notificationFields';

export default defineSchema({
    notificationDevices: defineTable({ userId: v.string(), deviceId: v.string(), platform: v.union(v.literal('web'), v.literal('desktop')),
        preferences: notificationPreferences, subscription: v.optional(pushSubscription), enabledAt: v.number(), nextCheckAt: v.optional(v.number()),
    }).index('by_user', ['userId']).index('by_user_device', ['userId', 'deviceId']).index('by_next', ['nextCheckAt'])
      .index('by_endpoint', ['subscription.endpoint']),
    notificationDeliveries: defineTable({ userId: v.string(), device: v.id('notificationDevices'), ...noticeFields,
        status: v.union(v.literal('pending'), v.literal('sent'), v.literal('failed')), attempts: v.number(),
    }).index('by_user', ['userId']).index('by_device_key', ['device', 'key']).index('by_device_status', ['device', 'status', 'expiresAt']).index('by_expiry', ['expiresAt']),
    // Keep only an account ID tombstone so old sessions cannot recreate deleted data.
    accountDeletions: defineTable({
        userId: v.string(),
        phase: v.union(v.literal('data'), v.literal('identity'), v.literal('complete')),
        attempts: v.number(), updatedAt: v.number(), retrying: v.boolean(), nextAttemptAt: v.number(),
    }).index('by_user', ['userId']),
    partnerAccounts: defineTable({
        userId: v.string(), name: v.string(), partnerId: v.optional(v.string()),
        sharedLabelIds: v.array(v.string()),
    }).index('by_user', ['userId']),
    partnerInvites: defineTable({
        ownerId: v.string(), code: v.string(), expiresAt: v.number(),
    }).index('by_owner', ['ownerId']).index('by_code', ['code']),
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
    }).index("by_user_item", ["userId", "itemId"]).index('by_user', ['userId']),

    /** MCP の認証済みリクエストを受けた接続元。認可状態そのものではない。 */
    mcpConnections: defineTable({
        userId: v.string(),
        clientId: v.string(),
        clientName: v.optional(v.string()),
        lastUsedAt: v.number(),
    })
        .index("by_user", ["userId"])
        .index("by_user_client", ["userId", "clientId"]),

    /** UI-independent confirmations. IDs locate a request; they never authorize it. */
    taskActions: defineTable({
        userId: v.string(), requestId: v.string(), clientId: v.string(),
        clientName: v.optional(v.string()), kind: v.literal('delete_task'), taskId: v.string(),
        text: v.string(), count: v.number(), revision: v.string(),
        status: v.union(v.literal('pending'), v.literal('completed'), v.literal('cancelled'), v.literal('changed'), v.literal('expired')),
        createdAt: v.number(), expiresAt: v.number(), deleted: v.optional(v.number()),
    }).index('by_user', ['userId'])
        .index('by_user_request', ['userId', 'requestId'])
        .index('by_user_client_task', ['userId', 'clientId', 'taskId']),

    taskWork: defineTable({
        userId: v.string(), taskId: v.string(), key: v.string(), text: v.string(),
        assignmentId: v.optional(v.id('grokBotAssignments')),
        // review → approved | returned → revised: a Bot completion that waits for the human's check.
        // A pull request review (prUrl + prHeadSha) is approved into merging; the Bot merges that commit → merged,
        // or resubmits a new head for review → superseded.
        status: v.union(v.literal('waiting'), v.literal('answered'), v.literal('applied'), v.literal('progress'), v.literal('complete'),
            v.literal('review'), v.literal('approved'), v.literal('returned'), v.literal('revised'),
            v.literal('merging'), v.literal('merged'), v.literal('superseded')),
        links: v.optional(v.array(v.string())), appliedQuestionId: v.optional(v.string()), answer: v.optional(v.string()), answeredAt: v.optional(v.number()),
        prUrl: v.optional(v.string()), prHeadSha: v.optional(v.string()), mergedAt: v.optional(v.number()),
        kind: v.optional(v.union(v.literal('approval'), v.literal('choice'), v.literal('info'))), options: v.optional(v.array(v.string())),
        recommendation: v.optional(v.string()), irreversible: v.optional(v.boolean()), assumptions: v.optional(v.string()),
        claimKey: v.optional(v.string()), claimUntil: v.optional(v.number()),
        wakeAt: v.optional(v.number()), wakeStatus: v.optional(v.union(v.literal('queued'), v.literal('accepted'), v.literal('failed'))),
    }).index('by_user', ['userId']).index('by_user_status', ['userId', 'status'])
        .index('by_user_task', ['userId', 'taskId']).index('by_user_task_key_assignment', ['userId', 'taskId', 'key', 'assignmentId'])
        .index('by_user_task_assignment', ['userId', 'taskId', 'assignmentId'])
        .index('by_user_task_status', ['userId', 'taskId', 'status'])
        .index('by_user_answered', ['userId', 'answeredAt']),
    // role 'vp': the user's single cross-label idea slot. It has no label (labelId '') and may only read and propose.
    grokBotAssignments: defineTable({
        userId: v.string(), labelId: v.string(), role: v.optional(v.literal('vp')), name: v.optional(v.string()), connectorName: v.optional(v.string()), tokenHash: v.string(),
        webhookUrl: v.optional(v.string()), webhookKey: v.optional(v.string()), connectedAt: v.optional(v.number()),
        oauthTokenHash: v.optional(v.string()),
        oauthGrant: v.optional(v.object({
            codeHash: v.string(), challenge: v.string(), redirectUri: v.string(), expiresAt: v.number(),
        })),
    }).index('by_user', ['userId']).index('by_user_label', ['userId', 'labelId'])
        .index('by_token', ['tokenHash']).index('by_oauth_token', ['oauthTokenHash']),
    grokBotSkins: defineTable({
        userId: v.string(), assignmentId: v.id('grokBotAssignments'), image: v.string(),
    }).index('by_user', ['userId']).index('by_assignment', ['assignmentId']),
    grokBotSchedules: defineTable({
        userId: v.string(), enabled: v.boolean(), time: v.string(), savedAt: v.number(),
        assignmentId: v.optional(v.id('grokBotAssignments')), nextCheckAt: v.optional(v.number()),
        lastDay: v.optional(v.string()), lastRunAt: v.optional(v.number()),
        lastStatus: v.optional(v.union(v.literal('queued'), v.literal('accepted'), v.literal('failed'))),
    }).index('by_user', ['userId']).index('by_user_assignment', ['userId', 'assignmentId']).index('by_next', ['nextCheckAt']),
    grokBotDelegations: defineTable({ userId: v.string(), taskId: v.string(), labelId: v.string(), assignmentId: v.optional(v.id('grokBotAssignments')),
        reviewCompletion: v.optional(v.boolean()) })
        .index('by_user', ['userId']).index('by_user_task', ['userId', 'taskId']),
    /** Bot suggestions that change nothing until the human adopts them. assignmentId is absent for the pilot. */
    grokBotProposals: defineTable({
        userId: v.string(), assignmentId: v.optional(v.id('grokBotAssignments')), key: v.string(),
        kind: v.union(v.literal('delete'), v.literal('defer'), v.literal('move'), v.literal('new_task')),
        taskId: v.optional(v.string()), labelId: v.optional(v.string()), title: v.optional(v.string()), note: v.optional(v.string()),
        until: v.optional(v.string()), reason: v.string(),
        // delete: the subtree the human is shown, so a changed task is never deleted.
        count: v.optional(v.number()), revision: v.optional(v.string()),
        status: v.union(v.literal('pending'), v.literal('adopted'), v.literal('dismissed'), v.literal('changed')),
        resolvedAt: v.optional(v.number()), createdTaskId: v.optional(v.string()),
    }).index('by_user', ['userId']).index('by_user_status', ['userId', 'status'])
        .index('by_user_assignment_status', ['userId', 'assignmentId', 'status'])
        .index('by_user_assignment_key', ['userId', 'assignmentId', 'key'])
        .index('by_user_kind_task', ['userId', 'kind', 'taskId']),
    /** Adopted deferrals: hidden from Bot task lists while today (user's time zone) is before until. */
    grokBotDeferrals: defineTable({ userId: v.string(), taskId: v.string(), until: v.string(), proposalId: v.optional(v.id('grokBotProposals')) })
        .index('by_user', ['userId']).index('by_user_task', ['userId', 'taskId']),

    userPreferences: defineTable({
        userId: v.string(),
        focusedLabelIds: v.optional(v.array(v.string())),
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

    /** 廃止した生活世界のデータ。既存ドキュメントを有効なまま保つためだけに残し、アカウント削除時に消す */
    lifeEntries: defineTable({
        userId: v.string(), id: v.string(), text: v.string(), note: v.string(), startDate: v.string(),
        repeat: v.union(v.literal('once'), v.literal('daily'), v.literal('weekdays')),
        order: v.number(), updatedAt: v.number(), deletedAt: v.optional(v.number()),
        locked: v.optional(v.boolean()),
        collapsed: v.optional(v.boolean()),
        parentId: v.optional(v.union(v.string(), v.null())),
        stamps: v.optional(v.object({ text: v.optional(v.number()), note: v.optional(v.number()),
            schedule: v.optional(v.number()), order: v.optional(v.number()), deletion: v.optional(v.number()), lock: v.optional(v.number()), collapse: v.optional(v.number()), hierarchy: v.optional(v.number()) })),
    }).index('by_user', ['userId']),
    lifeChecks: defineTable({
        userId: v.string(), entryId: v.string(), date: v.string(), done: v.boolean(), updatedAt: v.number(),
        filed: v.optional(v.boolean()),
        cleared: v.optional(v.boolean()),
    }).index('by_user', ['userId']),
    lifePreferences: defineTable({
        userId: v.string(), showInAll: v.boolean(), beforeId: v.union(v.string(), v.null()), updatedAt: v.number(),
        visibilityStamp: v.number(), placementStamp: v.number(),
    }).index('by_user', ['userId']),
});
