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

export const grokBotTools = {
  assigned_tasks: z.object({ task_id: task_id.optional(), offset: z.number().int().min(0).optional() }),
  add_assigned_task: z.object({ title: z.string().trim().min(1).max(500), note: text.optional(), idempotency_key }),
  request_decision: z.object({ task_id, question: text, idempotency_key }),
  claim_decision: z.object({ task_id, question_id: task_id, claim_key: z.string().uuid() }),
  record_work_result: z.object({
    task_id,
    summary: text.describe('What you did, what changed or what you verified. A process or outcome in words is sufficient.'),
    links: z.array(link).max(8).optional().describe('Optional accessible links to PRs, files or other evidence.'),
    complete: z.boolean().optional().describe('True only when all work and completion criteria were verified.'),
    expected_task_version: z.number().int().positive().optional().describe('The task_version from a fresh assigned_tasks detail read. Required when complete is true.'),
    applied_question_id: task_id.optional().describe('The answered question ID, once this result reflects the decision.'),
    claim_key: z.string().uuid().optional().describe('The claim key used to claim the applied decision.'),
    idempotency_key,
  }),
};
