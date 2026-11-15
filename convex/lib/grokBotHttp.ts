import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { grokBotTools } from '../../api/_lib/grokBotTools';
import { grokBotClientId, grokBotHex, grokBotIdPattern, grokBotRandomCode, isGrokBotRedirect } from '../../src/lib/grokBotOAuth';

export const grokBotOAuthToken = httpAction(async (ctx, request) => {
    const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
    const failure = (error: string) => Response.json({ error }, { status: 400, headers });
    const form = new URLSearchParams(await request.text());
    const clientId = form.get('client_id');
    const assignmentId = form.get('assignment');
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    if (form.get('grant_type') !== 'authorization_code') return failure('unsupported_grant_type');
    if (clientId !== grokBotClientId || !assignmentId || !grokBotIdPattern.test(assignmentId) ||
        !/^[a-f0-9]{64}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !isGrokBotRedirect(redirectUri)) {
        return failure('invalid_grant');
    }
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    const token = grokBotRandomCode();
    const [codeHash, challenge, tokenHash] = await Promise.all([
        digest(code).then(grokBotHex),
        digest(verifier).then(bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
        digest(token).then(grokBotHex),
    ]);
    const accepted = await ctx.runMutation(internal.grokBot.exchangeOAuth, { assignmentId, codeHash, challenge, redirectUri, tokenHash });
    return accepted ? Response.json({ access_token: token, token_type: 'Bearer' }, { headers }) : failure('invalid_grant');
});

export const grokBotHttp = httpAction(async (ctx, request) => {
    const token = /^Bearer ([\w-]{43,128})$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
    const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!token) return unauthorized();
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('operation' in body)) return Response.json({ error: 'Invalid request' }, { status: 400 });
    const assignment = 'assignment' in body ? body.assignment : undefined;
    if (assignment !== undefined && (typeof assignment !== 'string' || !grokBotIdPattern.test(assignment))) return unauthorized();
    const connection = await ctx.runQuery(internal.grokBot.authorize, { token, assignment });
    if (!connection) return unauthorized();
    const { userId, assignmentId } = connection;
    const scope = { userId, assignmentId };
    if (assignmentId && !connection.webhookConfigured && body.operation !== 'auth' && body.operation !== 'assigned_tasks') {
        return Response.json({ error: 'Finish setting up the routine in Terminal before writing to this label' }, { status: 403 });
    }
    const input = 'args' in body ? body.args : undefined;
    try {
        switch (body.operation) {
            case 'auth':
                if (assignmentId && connection.tokenHash && !connection.connectedAt) {
                    await ctx.runMutation(internal.grokBot.markConnected, { assignmentId, tokenHash: connection.tokenHash });
                }
                return Response.json({ authorized: true });
            case 'assigned_tasks': {
                const args = grokBotTools.assigned_tasks.parse(input);
                return Response.json(await ctx.runQuery(internal.grokBot.assignedTasks, { ...scope, taskId: args.task_id, offset: args.offset }));
            }
            case 'add_assigned_task': {
                const args = grokBotTools.add_assigned_task.parse(input);
                return Response.json(await ctx.runMutation(internal.grokBot.addAssignedTask, { ...scope, title: args.title, note: args.note, key: args.idempotency_key }));
            }
            case 'request_decision': {
                const args = grokBotTools.request_decision.parse(input);
                return Response.json(await ctx.runMutation(internal.grokBot.requestDecision, { ...scope, taskId: args.task_id, question: args.question, key: args.idempotency_key }));
            }
            case 'claim_decision': {
                const args = grokBotTools.claim_decision.parse(input);
                return Response.json(await ctx.runMutation(internal.grokBot.claimDecision, { ...scope, taskId: args.task_id, questionId: args.question_id, claimKey: args.claim_key }));
            }
            case 'record_work_result': {
                const args = grokBotTools.record_work_result.parse(input);
                return Response.json(await ctx.runMutation(internal.grokBot.recordWorkResult, {
                    ...scope, taskId: args.task_id, summary: args.summary, links: args.links ?? [], complete: args.complete ?? false,
                    appliedQuestionId: args.applied_question_id, claimKey: args.claim_key, expectedTaskVersion: args.expected_task_version, key: args.idempotency_key,
                }));
            }
            default:
                return Response.json({ error: 'Unknown operation' }, { status: 400 });
        }
    } catch (error) {
        const data = (error as { data?: unknown })?.data;
        return Response.json({ error: typeof data === 'string' ? data : 'Invalid arguments or Terminal operation failed' }, { status: 400 });
    }
});
