export function workOnTaskInstructions(taskId?: string, latestIncluded = false): string {
  const selection = latestIncluded
    ? 'The latest task details are already included below. Use them to assess the next step; re-fetch only if you need to check for changes.'
    : taskId
    ? `Call the bizencore work_on_task tool with task_id "${taskId}" to read the latest task. Do not rely on a copied snapshot.`
    : 'Call the bizencore work_on_task tool so I can choose a label and then an unfinished task. If your client cannot show its forms, use list_tasks to show me the labels, ask me to choose one, then show matching tasks and ask me to choose one. Call work_on_task with the exact task_id after I choose.';

  return `${selection} Read the task, attachments, subtasks and completion criteria. If essential information is missing, consult with me: ask focused questions, offer concrete options and a recommendation, and continue working in this same conversation once I answer. Do not demand a complete specification when a responsible next step is clear. Save only durable decisions as concise task context with attach_context so they are available next time. Then do the actual work; do not stop after selecting, summarizing, or consulting. When the outcome is verified against the completion criteria, call complete_task. If work remains or you are waiting for an answer, call record_task_progress to check only verified finished subtasks, add concrete remaining work without duplication, and record a short progress or blocker note. Keep the parent task incomplete until its completion criteria are met. Tell me what you did and what remains.`;
}

export function buildMcpHandoffPrompt(taskId: string, title: string): string {
  return `bizencore のタスク「${title.trim() || '（無題）'}」を進めてください。\nタスクID: ${taskId}\n\n${workOnTaskInstructions(taskId)}\n\nbizencore MCP に接続できない場合は、タスクを読めず、進捗も反映できないことを伝えてください。`;
}
