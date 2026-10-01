export function workOnTaskInstructions(taskId?: string, latestIncluded = false): string {
  const selection = latestIncluded
    ? 'The latest task details are already included below. Use them to start work; re-fetch only if you need to check for changes.'
    : taskId
    ? `Call the bizencore work_on_task tool with task_id "${taskId}" to read the latest task. Do not rely on a copied snapshot.`
    : 'Call the bizencore work_on_task tool so I can choose a task. If your client cannot show its selection form, use list_tasks to present matching tasks, ask me to choose one, then call work_on_task with its exact task_id.';

  return `${selection} Read the task, attachments, subtasks and completion criteria, then start the actual work in this conversation. Do not stop after selecting or summarizing the task. When the outcome is verified, call complete_task. If work remains, call record_task_progress to check only verified finished subtasks, add concrete remaining subtasks without duplication, and attach a short progress note. Keep the parent task incomplete until its completion criteria are met. Tell me what you did and what remains.`;
}

export function buildMcpHandoffPrompt(taskId: string, title: string): string {
  return `bizencore のタスク「${title.trim() || '（無題）'}」を進めてください。\nタスクID: ${taskId}\n\n${workOnTaskInstructions(taskId)}\n\nbizencore MCP に接続できない場合は、タスクを読めず、進捗も反映できないことを伝えてください。`;
}
