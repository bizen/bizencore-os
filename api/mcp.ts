import { createClerkClient } from '@clerk/backend';
import { acceptedContent, createRequestStateCodec, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { AuthInfo, CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clerkPublishableKey, clerkSecretKey, convexSiteUrl, mcpSecret } from './_lib/env.js';

/*
 * bizencore の MCP サーバ。
 *
 * Claude や ChatGPT の connector から /mcp に来る。Clerk の OAuth トークンで人を
 * 特定し、その userId を Convex の /mcp/* （convex/http.ts）へ渡す。
 * 共有の秘密は Authorization ヘッダで送る。Convex の関数の引数に載せると
 * 実行ログに残るため。
 *
 * ここは中継だけ。並びや親子の面倒は Convex 側の mcpTasks が持つ。
 */

const INSTRUCTIONS = `bizencore is the user's own task list — the one they look at and work from. This server lets you read it and put things into it.

Use add_task when the user asks you to remember something, or when your conversation produces a follow-up they will have to do themselves. One line, in the user's language (usually Japanese), phrased as the user would write it — not as a report to them.

Call list_tasks first when you need to know what is already there, or to get the exact label names and task ids. Use query for a title or note search, and next_offset for another page. Labels are the user's own groupings; add_task only files a task under a label that already exists. If a label is unknown, ask the user to choose one rather than guessing.

Tasks can carry context: links, text, and files attached by the user. list_tasks returns them under attachments, including download URLs for files; read them before working on a task. Use attach_context when your conversation turns up something the user will need for that task (a doc, a PR, a spec, a decision) — one link or one piece of text per call, attached to the task it belongs to.

This is the user's list, not a scratchpad. Do not add duplicates or things they did not ask for. When carrying out work the user requested, search for a clearly matching existing task. The user has opted in to checking it off once the work is genuinely finished and verified, even without a separate "mark done" message. Review completion criteria first; partial work, an ambiguous match, or an unverified result must not be checked off. Ask the user when uncertain. Deletion requires the user's confirmation in the MCP client. Reuse the same idempotency_key when retrying add_task. today: true uses the account's saved time zone.`;

const clerk = createClerkClient({
  secretKey: clerkSecretKey(),
  publishableKey: clerkPublishableKey(),
});

type ConfirmationState =
  | { kind: 'delete'; taskId: string; text: string; count: number }
  | { kind: 'label'; operation: string; requested: string };

const confirmationState = createRequestStateCodec<ConfirmationState>({
  key: createHash('sha256').update(mcpSecret()).digest(),
  ttlSeconds: 600,
  bind: (ctx) => `${userIdOf(ctx)}\0${ctx.http?.authInfo?.clientId ?? ''}`,
});

let clientNames: { at: number; values: Map<string, string> } | undefined;

async function clientNameOf(clientId: string | undefined): Promise<string | undefined> {
  if (!clientId || clientId === 'unknown') return undefined;
  if (!clientNames || Date.now() - clientNames.at > 10 * 60_000) {
    try {
      const apps = await clerk.oauthApplications.list({ limit: 500 });
      clientNames = {
        at: Date.now(),
        values: new Map(apps.data.map((app) => [app.clientId, app.name])),
      };
    } catch {
      return undefined;
    }
  }
  return clientNames.values.get(clientId);
}

async function verifyToken(request: Request, token?: string): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const state = await clerk.authenticateRequest(request, { acceptsToken: 'oauth_token' });
  const auth = state.toAuth();
  if (!auth?.isAuthenticated || !auth.userId) return undefined;
  return {
    token,
    clientId: auth.clientId ?? 'unknown',
    scopes: auth.scopes ?? [],
    extra: { userId: auth.userId },
  };
}

function userIdOf(ctx: ServerContext): string {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== 'string') throw new Error('Not signed in');
  return userId;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Unknown error' }],
  };
}

async function fetchConvex(
  ctx: ServerContext,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const clientId = ctx.http?.authInfo?.clientId;
  const clientName = await clientNameOf(clientId);
  const response = await fetch(`${convexSiteUrl()}/mcp/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mcpSecret()}`,
    },
    body: JSON.stringify({ ...body, userId: userIdOf(ctx), clientId, clientName }),
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload;
}

/** Convex 側が返した理由（「そのラベルは無い」など）は、そのままエージェントに見せる */
async function call(
  ctx: ServerContext,
  path: string,
  body: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    return json(await fetchConvex(ctx, path, body));
  } catch (error) {
    return toolError(error);
  }
}

export async function withResolvedLabel(
  ctx: ServerContext,
  label: string | undefined,
  operation: string,
  write: (label: string | undefined) => Promise<CallToolResult>
): Promise<CallToolResult | InputRequiredResult> {
  if (label === undefined) return write(undefined);
  if (!label.trim()) return toolError(new Error('ラベル名が空です。ラベルなしにするなら label を省略してください。'));
  try {
    const { labels } = await fetchConvex(ctx, 'list', { limit: 1 }) as { labels: string[] };
    const exact = labels.find((name) => name.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase());
    if (exact) return write(exact);
    if (labels.length === 0) throw new Error('ラベルがありません。先にラベルを作成してください。');

    const response = inputResponse(ctx.mcpReq.inputResponses, 'label');
    if (response.kind !== 'missing') {
      const state = ctx.mcpReq.requestState<ConfirmationState>();
      if (!state || state.kind !== 'label' || state.operation !== operation || state.requested !== label) {
        throw new Error('ラベルの確認が無効になりました。もう一度選んでください。');
      }
      if (response.kind === 'elicit' && response.action !== 'accept') return json({ cancelled: true });
      const chosen = acceptedContent(ctx.mcpReq.inputResponses, 'label', z.object({ label: z.string() }))?.label;
      const matched = labels.find((name) => name === chosen);
      if (!matched) throw new Error('選択されたラベルが見つかりません。もう一度選んでください。');
      return write(matched);
    }

    return inputRequired({
      requestState: await confirmationState.mint({ kind: 'label', operation, requested: label }, ctx),
      inputRequests: {
        label: inputRequired.elicit({
          message: `「${label}」というラベルは見つかりません。保存先を選んでください。`,
          requestedSchema: {
            type: 'object',
            properties: { label: { type: 'string', enum: labels, title: 'ラベル' } },
            required: ['label'],
          },
        }),
      },
    });
  } catch (error) {
    return toolError(error);
  }
}

export async function deleteWithConfirmation(ctx: ServerContext, taskId: string): Promise<CallToolResult | InputRequiredResult> {
  try {
    const preview = await fetchConvex(ctx, 'preview-delete', { taskId }) as { id: string; text: string; count: number };
    const response = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
    if (response.kind !== 'missing') {
      const state = ctx.mcpReq.requestState<ConfirmationState>();
      if (!state || state.kind !== 'delete' || state.taskId !== taskId ||
          state.text !== preview.text || state.count !== preview.count) {
        throw new Error('タスクが変更されました。削除をもう一度確認してください。');
      }
      if (response.kind === 'elicit' && response.action !== 'accept') return json({ cancelled: true });
      const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }))?.confirm;
      if (!confirmed) return json({ cancelled: true });
      return call(ctx, 'delete', { taskId, expectedText: preview.text, expectedCount: preview.count });
    }

    const descendants = preview.count - 1;
    return inputRequired({
      requestState: await confirmationState.mint({ kind: 'delete', taskId, text: preview.text, count: preview.count }, ctx),
      inputRequests: {
        confirm: inputRequired.elicit({
          message: `「${preview.text}」を削除しますか？${descendants ? `サブタスク ${descendants} 件も削除されます。` : ''}`,
          requestedSchema: z.object({ confirm: z.boolean().describe('削除する場合のみ true') }),
        }),
      },
    });
  } catch (error) {
    return toolError(error);
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'list_tasks',
      {
        title: "Read the user's task list",
        description:
          "Read the user's task list: open tasks, labels, ids, deadlines, completion criteria and attached context. Unfinished tasks only unless include_done is set. Narrow with label, today or query. Returns up to 50 tasks by default; use next_offset to read more. today: true uses the account's saved time zone.",
        inputSchema: z.object({
          include_done: z.boolean().optional().describe('Also return finished tasks'),
          label: z.string().optional().describe('Only tasks under this label (a name from list_tasks)'),
          today: z.union([z.boolean(), z.string()]).optional().describe('true uses the account time zone; YYYY-MM-DD remains supported'),
          query: z.string().max(200).optional().describe('Case-insensitive text search in task title and note, including subtasks'),
          limit: z.number().int().min(1).max(100).optional().describe('Tasks per page, default 50, maximum 100'),
          offset: z.number().int().min(0).optional().describe('Pass the previous next_offset to read the next page'),
        }),
        annotations: { readOnlyHint: true },
      },
      ({ include_done, label, today, query, limit, offset }, ctx) =>
        call(ctx, 'list', { includeDone: include_done, label, today, query, limit, offset })
    );

    server.registerTool(
      'add_task',
      {
        title: "Add a task to the user's list",
        description:
          "Put one task into the user's list. Write it as a line the user would write for themselves, in their language. An unknown label asks the user to choose an existing one; it never silently files at the top level. Use parent_task_id for a subtask. Reuse idempotency_key on retries; identical requests are also deduplicated briefly even if the key changes.",
        inputSchema: z.object({
          text: z.string().describe('One line, like a task list entry'),
          note: z.string().optional().describe('Details or context, shown under the task'),
          label: z.string().optional().describe('An existing label name from list_tasks'),
          estimate_minutes: z.number().int().positive().optional().describe('Rough working time'),
          parent_task_id: z.string().optional().describe('Add as a subtask of this task'),
          due_date: z.string().optional().describe('Deadline date, YYYY-MM-DD'),
          due_time: z.string().optional().describe('Optional deadline time, HH:mm in the account time zone'),
          completion_criteria: z.string().optional().describe('What must be true for the task to be complete'),
          idempotency_key: z.string().optional().describe('Stable unique key for this intended task. Reuse it on retries, not for a different task.'),
        }),
      },
      ({ text, note, label, estimate_minutes, parent_task_id, due_date, due_time, completion_criteria, idempotency_key }, ctx) =>
        withResolvedLabel(ctx, parent_task_id ? undefined : label, 'add_task', (resolvedLabel) => call(ctx, 'add', {
          text,
          note,
          label: resolvedLabel,
          estimateMinutes: estimate_minutes,
          parentId: parent_task_id,
          dueDate: due_date,
          dueTime: due_time,
          completionCriteria: completion_criteria,
          idempotencyKey: idempotency_key,
        }))
    );

    server.registerTool(
      'add_tasks',
      {
        title: "Add several tasks at once",
        description:
          "Put several tasks into the user's list in one go, in the order given — use this instead of calling add_task again and again. All of them go under the same label (or the same parent task), and each may bring its own subtasks.",
        inputSchema: z.object({
          tasks: z
            .array(
              z.object({
                text: z.string().describe('One line, like a task list entry'),
                note: z.string().optional().describe('Details or context, shown under the task'),
                estimate_minutes: z.number().int().positive().optional(),
                subtasks: z.array(z.object({
            text: z.string(),
            note: z.string().optional(),
            estimate_minutes: z.number().int().positive().optional(),
          })).optional(),
              })
            )
            .min(1)
            .describe('The tasks, in the order they should appear'),
          label: z.string().optional().describe('An existing label name from list_tasks'),
          parent_task_id: z.string().optional().describe('Add them as subtasks of this task'),
        }),
      },
      ({ tasks, label, parent_task_id }, ctx) =>
        withResolvedLabel(ctx, parent_task_id ? undefined : label, 'add_tasks', (resolvedLabel) => call(ctx, 'add-many', {
          tasks: tasks.map((t) => ({
            text: t.text,
            note: t.note,
            estimateMinutes: t.estimate_minutes,
            subtasks: t.subtasks?.map((s) => ({
              text: s.text,
              note: s.note,
              estimateMinutes: s.estimate_minutes,
            })),
          })),
          label: resolvedLabel,
          parentId: parent_task_id,
        }))
    );

    server.registerTool(
      'complete_task',
      {
        title: 'Check off a task',
        description:
          'Mark a task as done, together with its subtasks. Do this when the user says it is done, or when you have finished and verified explicitly requested work that clearly matches this task. Review completion_criteria first; never check off partial or ambiguous work. Pass done: false to put it back.',
        inputSchema: z.object({
          task_id: z.string(),
          done: z.boolean().optional().describe('false puts the task back to unfinished'),
        }),
      },
      ({ task_id, done }, ctx) => call(ctx, 'complete', { taskId: task_id, done })
    );

    server.registerTool(
      'attach_context',
      {
        title: 'Attach context to a task',
        description:
          'Attach one link or one piece of text to a task, so the user (and any agent that later works on it) has what it needs in one place. Give exactly one of url or text. Shown in the task\'s detail panel and returned by list_tasks.',
        inputSchema: z.object({
          task_id: z.string(),
          url: z.string().optional().describe('A link starting with http:// or https://'),
          text: z.string().optional().describe('A note, excerpt or decision, up to 4000 characters'),
          title: z.string().optional().describe('A short name shown in the list'),
        }),
      },
      ({ task_id, url, text, title }, ctx) => call(ctx, 'attach', { taskId: task_id, url, text, title })
    );

    server.registerTool(
      'delete_task',
      {
        title: 'Delete a task',
        description:
          'Delete a task from the list, together with its subtasks, only after the user confirms the specific task in an elicitation. A finished task is checked off with complete_task, not deleted. If the client cannot show the confirmation, use the web app instead.',
        inputSchema: z.object({
          task_id: z.string(),
        }),
        annotations: { destructiveHint: true },
      },
      ({ task_id }, ctx) => deleteWithConfirmation(ctx, task_id)
    );

    server.registerTool(
      'update_task',
      {
        title: 'Edit a task',
        description:
          "Change the wording, the note or the estimate of a task that is already in the list, or put it into (or take it out of) the user's today list.",
        inputSchema: z.object({
          task_id: z.string(),
          text: z.string().optional(),
          note: z.string().optional().describe('Empty string clears the note'),
          estimate_minutes: z.number().int().min(0).optional().describe('0 clears the estimate'),
          today: z.union([z.boolean(), z.string()]).optional().describe('true adds to today in account time zone; false or empty string removes it'),
          due_date: z.string().optional().describe('YYYY-MM-DD; empty string clears the deadline'),
          due_time: z.string().optional().describe('HH:mm; empty string clears the deadline time'),
          completion_criteria: z.string().optional().describe('What must be true to finish; empty string clears it'),
        }),
      },
      ({ task_id, text, note, estimate_minutes, today, due_date, due_time, completion_criteria }, ctx) =>
        call(ctx, 'update', {
          taskId: task_id,
          text,
          note,
          estimateMinutes: estimate_minutes,
          today,
          dueDate: due_date,
          dueTime: due_time,
          completionCriteria: completion_criteria,
        })
    );

    server.registerTool(
      'add_label',
      {
        title: 'Create a label',
        description:
          "Create a new label (a group of tasks) at the bottom of the user's list. Only when the user asked for it — labels are theirs to organise.",
        inputSchema: z.object({
          name: z.string().describe('The label name, exactly as the user wants it'),
        }),
      },
      ({ name }, ctx) => call(ctx, 'add-label', { name })
    );

    server.registerTool(
      'move_task',
      {
        title: 'Move a task',
        description:
          'Move a task (with its subtasks) under an existing label, or under another task as a subtask. With neither, it goes to the top level. It lands at the end.',
        inputSchema: z.object({
          task_id: z.string(),
          label: z.string().optional().describe('An existing label name from list_tasks'),
          parent_task_id: z.string().optional().describe('Make it a subtask of this task'),
        }),
      },
      ({ task_id, label, parent_task_id }, ctx) =>
        withResolvedLabel(ctx, parent_task_id ? undefined : label, 'move_task', (resolvedLabel) =>
          call(ctx, 'move', { taskId: task_id, label: resolvedLabel, parentTaskId: parent_task_id }))
    );

    server.registerTool(
      'label_to_task',
      {
        title: 'Turn a label into a task',
        description:
          'Turn an existing label into a task. The tasks that were under it become its subtasks. Optionally put it under another label.',
        inputSchema: z.object({
          label: z.string().describe('The label to turn into a task'),
          into_label: z.string().optional().describe('An existing label to put the new task under'),
        }),
      },
      ({ label, into_label }, ctx) =>
        withResolvedLabel(ctx, into_label, 'label_to_task', (resolvedLabel) =>
          call(ctx, 'label-to-task', { label, intoLabel: resolvedLabel }))
    );
  },
  {
    serverInfo: { name: 'bizencore', version: '0.1.0' },
    instructions: INSTRUCTIONS,
    requestState: { verify: confirmationState.verify },
  }
);

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
});

export const GET = authed;
export const POST = authed;
export const DELETE = authed;
