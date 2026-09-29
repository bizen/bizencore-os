import { createClerkClient } from '@clerk/backend';
import type { AuthInfo, CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
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

Call list_tasks first when you need to know what is already there, or to get the exact label names and task ids. Labels are the user's own groupings; add_task only files a task under a label that already exists.

Tasks can carry context: links, text, and files attached by the user. list_tasks returns them under attachments, including download URLs for files; read them before working on a task. Use attach_context when your conversation turns up something the user will need for that task (a doc, a PR, a spec, a decision) — one link or one piece of text per call, attached to the task it belongs to.

This is the user's list, not a scratchpad. Do not add duplicates, do not add things they did not ask for, and do not complete a task unless they said it is done.`;

const clerk = createClerkClient({
  secretKey: clerkSecretKey(),
  publishableKey: clerkPublishableKey(),
});

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

/** Convex 側が返した理由（「そのラベルは無い」など）は、そのままエージェントに見せる */
async function call(
  ctx: ServerContext,
  path: string,
  body: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const response = await fetch(`${convexSiteUrl()}/mcp/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mcpSecret()}`,
      },
      body: JSON.stringify({ ...body, userId: userIdOf(ctx) }),
    });

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: payload?.error ?? `HTTP ${response.status}` }],
      };
    }
    return json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'list_tasks',
      {
        title: "Read the user's task list",
        description:
          "Read the user's task list: what is still open, which labels exist, and the ids you need for the other tools. Unfinished tasks only unless include_done is set. Narrow it with label, or with today to get just the user's today list and the total of its remaining estimates. Each task includes the context attached to it (links and text) under attachments.",
        inputSchema: z.object({
          include_done: z.boolean().optional().describe('Also return finished tasks'),
          label: z.string().optional().describe('Only tasks under this label (a name from list_tasks)'),
          today: z
            .string()
            .optional()
            .describe(
              "The user's local date as YYYY-MM-DD. Only tasks in today, plus today_remaining_minutes"
            ),
        }),
        annotations: { readOnlyHint: true },
      },
      ({ include_done, label, today }, ctx) =>
        call(ctx, 'list', { includeDone: include_done, label, today })
    );

    server.registerTool(
      'add_task',
      {
        title: "Add a task to the user's list",
        description:
          "Put one task into the user's list. Write it as a line the user would write for themselves, in their language. Use label only with a name from list_tasks; an unknown label leaves the task at the top level and is reported back. Use parent_task_id to add it as a subtask of an existing task.",
        inputSchema: z.object({
          text: z.string().describe('One line, like a task list entry'),
          note: z.string().optional().describe('Details or context, shown under the task'),
          label: z.string().optional().describe('An existing label name from list_tasks'),
          estimate_minutes: z.number().int().positive().optional().describe('Rough working time'),
          parent_task_id: z.string().optional().describe('Add as a subtask of this task'),
        }),
      },
      ({ text, note, label, estimate_minutes, parent_task_id }, ctx) =>
        call(ctx, 'add', {
          text,
          note,
          label,
          estimateMinutes: estimate_minutes,
          parentId: parent_task_id,
        })
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
        call(ctx, 'add-many', {
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
          label,
          parentId: parent_task_id,
        })
    );

    server.registerTool(
      'complete_task',
      {
        title: 'Check off a task',
        description:
          'Mark a task as done, together with its subtasks. Only when the user has said it is done — do not decide that yourself. Pass done: false to put it back.',
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
          'Delete a task from the list, together with its subtasks. Only when the user asked for it to be deleted — a finished task is checked off with complete_task, not deleted.',
        inputSchema: z.object({
          task_id: z.string(),
        }),
        annotations: { destructiveHint: true },
      },
      ({ task_id }, ctx) => call(ctx, 'delete', { taskId: task_id })
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
          today: z
            .string()
            .optional()
            .describe(
              "The user's local date as YYYY-MM-DD puts the task into today. Empty string takes it out"
            ),
        }),
      },
      ({ task_id, text, note, estimate_minutes, today }, ctx) =>
        call(ctx, 'update', {
          taskId: task_id,
          text,
          note,
          estimateMinutes: estimate_minutes,
          today,
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
        call(ctx, 'move', { taskId: task_id, label, parentTaskId: parent_task_id })
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
      ({ label, into_label }, ctx) => call(ctx, 'label-to-task', { label, intoLabel: into_label })
    );
  },
  {
    serverInfo: { name: 'bizencore', version: '0.1.0' },
    instructions: INSTRUCTIONS,
  }
);

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
});

export const GET = authed;
export const POST = authed;
export const DELETE = authed;
