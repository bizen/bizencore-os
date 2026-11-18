import { z } from 'zod';

const task_id = z.string().trim().min(1).max(256);
const idempotency_key = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(8000);
const link = z.string().trim().max(4096).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Use an HTTPS link without credentials');

const reason = z.string().trim().min(1).max(2000).describe('Why, in one or two sentences the user can judge quickly.');
const until = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('defer only: the first day the task should come back, YYYY-MM-DD in the user’s time zone, after today.');
const listArgs = z.object({ task_id: task_id.optional(), offset: z.number().int().min(0).optional() });

export const grokBotTools = {
  assigned_tasks: listArgs,
  all_tasks: listArgs,
  add_assigned_task: z.object({ title: z.string().trim().min(1).max(500), note: text.optional(), idempotency_key }),
  request_decision: z.object({
    task_id, idempotency_key,
    kind: z.enum(['approval', 'choice', 'info'], { error: 'Required: approval, choice or info' }).describe('approval: approve or reject a stated plan (exactly 2 options). choice: pick one of 2–4 options. info: the user writes a free-text answer (no options, no recommendation).'),
    headline: z.string({ error: 'Required: one line (at most 80 characters) saying what is being decided' }).trim().min(1).max(80).describe('One line: what is being decided. One decision per card.'),
    context: z.string({ error: 'Required: why this needs deciding now (at most 400 characters)' }).trim().min(1).max(400).describe('Why this needs deciding now and the background the user needs to judge it.'),
    options: z.array(z.object({
      label: z.string().trim().min(1).max(60).describe('The short answer shown on the button.'),
      consequence: z.string().trim().min(1).max(200).describe('What concretely happens if the user picks it: what you will do, what changes, who sees it.'),
      irreversible: z.boolean().optional().describe('True when picking it starts something that cannot be undone (deleting, sending, paying, publishing, merging).'),
    })).max(4).optional().describe('approval: exactly 2 (approve, reject). choice: 2–4. Omit for info.'),
    recommendation: z.object({
      option: z.string().trim().min(1).max(60).describe('Exactly one of the option labels.'),
      reason: z.string().trim().min(1).max(200).describe('Why you recommend it.'),
      confidence: z.enum(['high', 'medium', 'low']),
    }).optional().describe('Required for approval and choice; omit for info.'),
    checks: z.array(z.string().trim().min(1).max(120), { error: 'Required: 1–3 things the user must actually look at before deciding' }).min(1).max(3).describe('1–3 things the user must actually look at before deciding (a figure, a date, a recipient), not generic advice.'),
    evidence: z.array(z.object({ url: link, title: z.string().trim().min(1).max(80).optional() })).max(8).optional().describe('Links the checks can be verified against.'),
  }),
  claim_decision: z.object({ task_id, question_id: task_id, claim_key: z.string().uuid() }),
  record_work_result: z.object({
    task_id,
    summary: text.describe('What you did, what changed or what you verified. A process or outcome in words is sufficient.'),
    links: z.array(link).max(8).optional().describe('Optional accessible links to PRs, files or other evidence.'),
    complete: z.boolean().optional().describe('True only when all work and completion criteria were verified.'),
    needs_review: z.boolean().optional().describe('With complete: the user checks before the task closes. Set it when you resolved any ambiguity yourself or made a judgment call. With a pr_head_sha other than the approved one, it resubmits an approved pull request.'),
    assumptions: text.optional().describe('The ambiguities you resolved and judgment calls you made. Required when needs_review and complete are true, optional for a pull request.'),
    headline: z.string().trim().min(1).max(80).optional().describe('One line: what was done. Required whenever the completion waits for review.'),
    checks: z.array(z.string().trim().min(1).max(120)).min(1).max(3).optional().describe('1–3 things the user must actually look at before approving (a changed figure, a page, a diff hunk). Required whenever the completion waits for review.'),
    pr_head_sha: z.string().regex(/^[0-9a-f]{40}$/).optional().describe('With complete and a https://github.com/<owner>/<repo>/pull/<n> link: the full head commit SHA of the pull request. It always waits for review; the user approves exactly this commit.'),
    expected_task_version: z.number().int().positive().optional().describe('The task_version from a fresh assigned_tasks detail read. Required when complete is true.'),
    applied_question_id: task_id.optional().describe('The answered question or returned review ID, once this result reflects it.'),
    claim_key: z.string().uuid().optional().describe('The claim key used to claim the applied decision or returned review.'),
    idempotency_key,
  }),
  /** Every kind; the server decides which kinds the caller may use. */
  propose: z.object({
    kind: z.enum(['delete', 'defer', 'move', 'new_task']).describe('delete: not needed. defer: not now. move: sort an unsorted task into a label. new_task: a missing task.'),
    task_id: task_id.optional().describe('The task for delete, defer and move.'),
    label_id: task_id.optional().describe('move: the destination label. new_task: optional label; omit for unsorted.'),
    title: z.string().trim().min(1).max(500).optional().describe('new_task only.'),
    note: text.optional().describe('new_task only.'),
    until: until.optional(), reason, idempotency_key,
  }),
  /** The label Bot's view of propose: only delete and defer of its own tasks. */
  propose_in_label: z.object({
    kind: z.enum(['delete', 'defer']).describe('delete: the task is not needed. defer: not now; set until.'),
    task_id, until: until.optional(), reason, idempotency_key,
  }),
};
