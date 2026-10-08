import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MAX_FILE_SIZE } from "../src/lib/attachments";

/*
 * MCP サーバ（api/mcp.ts）からの入口。
 *
 * 呼び出し元の確認は Authorization ヘッダで行う。Convex の関数の引数に
 * 秘密を載せると、ダッシュボードの実行ログや引数の検証エラーに残るため。
 * 秘密は Convex と Vercel の両方に MCP_SHARED_SECRET で置く。
 *
 * 人の特定は MCP 側が Clerk の OAuth トークンで済ませていて、ここには
 * その結果の userId だけが渡ってくる。
 */

function sharedSecret(): string | undefined {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
        ?.env;
    return env?.MCP_SHARED_SECRET;
}

/** 文字数の違いから中身を推測されないよう、長さによらず全桁を比べる */
function sameSecret(given: string, expected: string): boolean {
    const length = Math.max(given.length, expected.length);
    let diff = given.length ^ expected.length;
    for (let i = 0; i < length; i++) {
        diff |= (given.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
    }
    return diff === 0;
}

function authorized(request: Request): boolean {
    const expected = sharedSecret();
    if (!expected) return false;
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return token.length > 0 && sameSecret(token, expected);
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** 中の関数が投げた理由は、そのままエージェントに見せたいので本文に載せる */
function route(run: (ctx: Parameters<Parameters<typeof httpAction>[0]>[0], body: Record<string, unknown>) => Promise<unknown>) {
    return httpAction(async (ctx, request) => {
        if (!authorized(request)) return jsonResponse({ error: "Unauthorized" }, 401);

        let body: Record<string, unknown>;
        try {
            body = (await request.json()) as Record<string, unknown>;
        } catch {
            return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        if (typeof body.userId !== "string" || !body.userId) {
            return jsonResponse({ error: "userId is required" }, 400);
        }

        try {
            const result = await run(ctx, body);
            if (typeof body.clientId === "string") {
                try {
                    await ctx.runMutation(internal.sync.touchMcpConnection, {
                        userId: body.userId as string,
                        clientId: body.clientId,
                        clientName: typeof body.clientName === "string" ? body.clientName : undefined,
                    });
                } catch (error) {
                    console.error("Could not record MCP connection", error);
                }
            }
            return jsonResponse(result);
        } catch (error) {
            const message =
                typeof (error as { data?: unknown })?.data === "string"
                    ? ((error as { data: string }).data)
                    : error instanceof Error
                      ? error.message
                      : "Unknown error";
            return jsonResponse({ error: message }, 400);
        }
    });
}

const http = httpRouter();

const uploadHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Task-Id, X-File-Name",
};

function uploadResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...uploadHeaders, "Content-Type": "application/json" },
    });
}

http.route({
    path: "/files/upload",
    method: "OPTIONS",
    handler: httpAction(async () => new Response(null, { status: 204, headers: uploadHeaders })),
});

http.route({
    path: "/files/upload",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return uploadResponse({ error: "Unauthorized" }, 401);
        if (await ctx.runQuery(internal.accountDeletion.job, { userId: identity.subject })) {
            return uploadResponse({ error: "Account is being deleted" }, 403);
        }

        const taskId = request.headers.get("X-Task-Id")?.trim();
        const encodedName = request.headers.get("X-File-Name");
        if (!taskId || !encodedName || encodedName.length > 1000) {
            return uploadResponse({ error: "Task and file name are required" }, 400);
        }
        let title: string;
        try {
            title = decodeURIComponent(encodedName);
        } catch {
            return uploadResponse({ error: "Invalid file name" }, 400);
        }
        if (!title.trim()) return uploadResponse({ error: "Invalid file name" }, 400);
        const contentLength = Number(request.headers.get("Content-Length"));
        if (contentLength > MAX_FILE_SIZE) return uploadResponse({ error: "File exceeds 10 MB" }, 413);

        const blob = await request.blob();
        if (blob.size === 0 || blob.size > MAX_FILE_SIZE) {
            return uploadResponse({ error: "File must be between 1 byte and 10 MB" }, 413);
        }

        const storageId = await ctx.storage.store(blob);
        try {
            const result = await ctx.runMutation(internal.mcpTasks.attachFile, {
                userId: identity.subject,
                taskId,
                attachmentId: crypto.randomUUID(),
                storageId,
                title,
                mimeType: blob.type,
                size: blob.size,
            });
            return uploadResponse(result);
        } catch (error) {
            await ctx.storage.delete(storageId);
            return uploadResponse({ error: error instanceof Error ? error.message : "Upload failed" }, 400);
        }
    }),
});

http.route({
    path: "/mcp/list",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runQuery(internal.mcpTasks.list, {
            userId: body.userId as string,
            includeDone: body.includeDone === true,
            label: typeof body.label === "string" ? body.label : undefined,
            today: typeof body.today === "string" || typeof body.today === "boolean" ? body.today : undefined,
            query: typeof body.query === "string" ? body.query : undefined,
            flat: body.flat === true,
            limit: typeof body.limit === "number" ? body.limit : undefined,
            offset: typeof body.offset === "number" ? body.offset : undefined,
        })
    ),
});

http.route({
    path: "/mcp/task-view",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runQuery(internal.mcpTasks.taskView, {
            userId: body.userId as string,
            offset: typeof body.offset === "number" ? body.offset : undefined,
        })
    ),
});

http.route({
    path: "/mcp/get",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runQuery(internal.mcpTasks.get, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
        })
    ),
});

http.route({
    path: "/mcp/record-progress",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.recordProgress, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            completedSubtaskIds: (Array.isArray(body.completedSubtaskIds) ? body.completedSubtaskIds : []) as string[],
            remainingSubtasks: (Array.isArray(body.remainingSubtasks) ? body.remainingSubtasks : []) as { text: string; note?: string }[],
            progressNote: typeof body.progressNote === "string" ? body.progressNote : undefined,
            clientName: typeof body.clientName === "string" ? body.clientName : undefined,
        })
    ),
});

http.route({
    path: "/mcp/preview-delete",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runQuery(internal.mcpTasks.previewDelete, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
        })
    ),
});

http.route({
    path: "/mcp/add",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.add, {
            userId: body.userId as string,
            text: String(body.text ?? ""),
            note: typeof body.note === "string" ? body.note : undefined,
            label: typeof body.label === "string" ? body.label : undefined,
            estimateMinutes:
                typeof body.estimateMinutes === "number" ? body.estimateMinutes : undefined,
            parentId: typeof body.parentId === "string" ? body.parentId : undefined,
            dueDate: typeof body.dueDate === "string" ? body.dueDate : undefined,
            dueTime: typeof body.dueTime === "string" ? body.dueTime : undefined,
            completionCriteria: typeof body.completionCriteria === "string" ? body.completionCriteria : undefined,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
            clientName: typeof body.clientName === "string" ? body.clientName : undefined,
        })
    ),
});

http.route({
    path: "/mcp/complete",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.complete, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            done: typeof body.done === "boolean" ? body.done : undefined,
            clientName: typeof body.clientName === "string" ? body.clientName : undefined,
        })
    ),
});

http.route({
    path: "/mcp/update",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.update, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            text: typeof body.text === "string" ? body.text : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
            estimateMinutes:
                typeof body.estimateMinutes === "number" ? body.estimateMinutes : undefined,
            today: typeof body.today === "string" || typeof body.today === "boolean" ? body.today : undefined,
            dueDate: typeof body.dueDate === "string" ? body.dueDate : undefined,
            dueTime: typeof body.dueTime === "string" ? body.dueTime : undefined,
            completionCriteria: typeof body.completionCriteria === "string" ? body.completionCriteria : undefined,
        })
    ),
});

http.route({
    path: "/mcp/attach",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.attach, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            url: typeof body.url === "string" ? body.url : undefined,
            text: typeof body.text === "string" ? body.text : undefined,
            title: typeof body.title === "string" ? body.title : undefined,
        })
    ),
});

http.route({
    path: "/mcp/update-context",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.updateContext, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            attachmentId: String(body.attachmentId ?? ""),
            text: String(body.text ?? ""),
            title: typeof body.title === "string" ? body.title : undefined,
            mode: body.mode === undefined ? "replace" : body.mode as "replace" | "append",
            expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : -1,
        })
    ),
});

http.route({
    path: "/mcp/add-many",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.addMany, {
            userId: body.userId as string,
            tasks: (Array.isArray(body.tasks) ? body.tasks : []) as {
                text: string;
                note?: string;
                estimateMinutes?: number;
                subtasks?: { text: string; note?: string; estimateMinutes?: number }[];
            }[],
            label: typeof body.label === "string" ? body.label : undefined,
            parentId: typeof body.parentId === "string" ? body.parentId : undefined,
            clientName: typeof body.clientName === "string" ? body.clientName : undefined,
        })
    ),
});

http.route({
    path: "/mcp/add-label",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.addLabel, {
            userId: body.userId as string,
            name: String(body.name ?? ""),
        })
    ),
});

http.route({
    path: "/mcp/move",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.move, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            label: typeof body.label === "string" ? body.label : undefined,
            parentTaskId: typeof body.parentTaskId === "string" ? body.parentTaskId : undefined,
        })
    ),
});

http.route({
    path: "/mcp/label-to-task",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.labelToTask, {
            userId: body.userId as string,
            label: String(body.label ?? ""),
            intoLabel: typeof body.intoLabel === "string" ? body.intoLabel : undefined,
        })
    ),
});

http.route({
    path: "/mcp/delete",
    method: "POST",
    handler: route((ctx, body) =>
        ctx.runMutation(internal.mcpTasks.remove, {
            userId: body.userId as string,
            taskId: String(body.taskId ?? ""),
            expectedText: String(body.expectedText ?? ""),
            expectedCount: Number(body.expectedCount ?? 0),
        })
    ),
});

export default http;
