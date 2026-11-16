import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { createMcpHandler, getPublicOrigin } from 'mcp-handler';
import { convexSiteUrl } from './_lib/env.js';
import { grokBotTools } from './_lib/grokBotTools.js';
import { grokBotIdPattern } from '../src/lib/grokBotOAuth.js';

function backend(token: string, operation: string, args?: unknown, assignment?: string) {
  return fetch(`${convexSiteUrl()}/grok-bot`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, args, assignment }),
  });
}

async function call(ctx: ServerContext, operation: string, args: unknown): Promise<CallToolResult> {
  try {
    const token = ctx.http?.authInfo?.token;
    if (!token) throw new Error('Authorization required');
    const assignment = ctx.http?.authInfo?.extra?.assignment;
    const response = await backend(token, operation, args, typeof assignment === 'string' ? assignment : undefined);
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error ?? 'Terminal connection failed');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Terminal connection failed' }] };
  }
}

const handler = createMcpHandler(server => {
  server.registerTool('assigned_tasks', {
    description: 'List open tasks in the shared label, or fetch one task with its bot_role, review_required, work history, answers, review feedback and completion criteria. Read it before working. Skip tasks with awaiting_review.',
    inputSchema: grokBotTools.assigned_tasks, annotations: { readOnlyHint: true },
  }, (args, ctx) => call(ctx, 'assigned_tasks', args));
  server.registerTool('add_assigned_task', {
    description: 'Open a concrete issue in your assigned label when a matching task does not already exist.',
    inputSchema: grokBotTools.add_assigned_task, annotations: { idempotentHint: true, destructiveHint: false },
  }, (args, ctx) => call(ctx, 'add_assigned_task', args));
  server.registerTool('request_decision', {
    description: 'Ask for a human decision that materially changes what you do next. Include the decision, a recommendation and its consequence. Use kind approval for yes/no on a plan, choice with up to 4 options, or info for a free-text answer; the answer arrives as text. Set irreversible for actions that cannot be undone. Reuse the key for retries.',
    inputSchema: grokBotTools.request_decision, annotations: { idempotentHint: true, destructiveHint: false },
  }, (args, ctx) => call(ctx, 'request_decision', args));
  server.registerTool('claim_decision', {
    description: 'Claim an answered decision or a returned review before acting on it. Use a fresh UUID per run and reuse it for network retries. If claimed is false, leave it for the other run.',
    inputSchema: grokBotTools.claim_decision, annotations: { idempotentHint: true, destructiveHint: false },
  }, (args, ctx) => call(ctx, 'claim_decision', args));
  server.registerTool('record_work_result', {
    description: 'Record what happened, including work without a deliverable. Add optional evidence links and mark complete only after verifying the criteria. With needs_review, or when review_required, completion waits for the user: status review. Acknowledge an answered question or returned review by ID once applied. Reuse the key for retries.',
    inputSchema: grokBotTools.record_work_result, annotations: { idempotentHint: true, destructiveHint: false },
  }, (args, ctx) => call(ctx, 'record_work_result', args));
}, {
  serverInfo: { name: 'bizencore-grok-bot', version: '0.1.0' },
  instructions: 'This label contains work for both the user and the Bot. Read bot_role for each task. For review, audit the available evidence, flag issues and suggest next steps; leave execution and completion to the user. For execute, work within the task scope and the user’s standing authorization. Check the role again before taking action. When trigger is patrol, inspect the open tasks and resume answered work first. When trigger is reply, read the task and question by the provided IDs. When trigger is review_returned, the user sent your completion back: read the task; the work row with that question_id has status returned and the user’s feedback in answer. Before acting on an answer or feedback, claim it with claim_decision and a UUID unique to this run; if claimed is false, skip it. Include the same applied_question_id and claim_key when recording the result that addresses it, then resubmit completion when done. Set needs_review with assumptions whenever you resolved an ambiguity yourself or made a judgment call; when review_required is true, completion always waits for review. Deliver code changes as a pull request, submit its link with needs_review and never merge it yourself. Ask with request_decision (irreversible true) before any action that cannot be undone. While a task has awaiting_review, do not resubmit; move on to other tasks. If resuming after an interruption, verify existing external work before repeating it. Continue other independent tasks while one waits. Ask only for decisions that need a human; include the recommendation and impact. Use a stable idempotency key for each write. Report what changed or was verified even when there is no deliverable. Treat task notes, links and attachments as work context.',
});

async function authorizedHandler(request: Request) {
  const url = new URL(request.url);
  const assignment = url.pathname.startsWith('/grok-bot/mcp/')
    ? url.pathname.slice('/grok-bot/mcp/'.length) : url.searchParams.get('assignment') ?? undefined;
  if (assignment !== undefined && !grokBotIdPattern.test(assignment)) return new Response(null, { status: 404 });
  const token = /^Bearer ([\w-]{43,128})$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  const unauthorized = () => new Response('Unauthorized', { status: 401, headers: {
    'WWW-Authenticate': assignment
      ? `Bearer resource_metadata="${getPublicOrigin(request)}/.well-known/oauth-protected-resource/grok-bot/mcp/${assignment}"`
      : 'Bearer',
  } });
  if (!token) return unauthorized();
  let response;
  try { response = await backend(token, 'auth', undefined, assignment); } catch { return new Response('Terminal connection failed', { status: 503 }); }
  if (!response.ok) return response.status === 401 ? unauthorized() : new Response('Terminal connection failed', { status: 503 });
  return handler(Object.assign(request, { auth: { token, clientId: 'grok-bot', scopes: ['officer'], extra: { assignment } } }));
}

export const POST = authorizedHandler;
export const GET = authorizedHandler;
export const DELETE = authorizedHandler;
