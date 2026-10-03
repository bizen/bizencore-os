export const TASK_SELECTION_INSTRUCTIONS = `Choose a label and then an unfinished task, using this ordered selection flow:
1. MCP Apps picker: in an MCP Apps-capable host, call open_task_picker and wait for the user's selection. A successful picker call means selection is pending, not that selection failed. Do not call the no-ID work_on_task form or show a competing text list while the picker is pending. The model's inability to see the rendered app, the lack of a task ID yet, or unsupported elicitation does not mean that MCP Apps failed. Fall back only when the host explicitly reports that the app is unavailable or failed to render, or the user says the picker is not usable or requests another method.
2. Native selection form: only when MCP Apps is unavailable, call work_on_task without task_id to choose a label and task through the client's elicitation form. First ask for a label and wait for the user's label choice; only then show tasks belonging to that label and wait for the user's task choice. Do not combine both steps into one form or skip the label step unless the user already specified a label or there are no labels. A cancelled selection alone is not evidence that forms are unsupported; stop and wait unless the host reports lack of support or the user asks for another method.
3. Numbered text lists: only when neither UI is usable, call list_tasks and show a plain numbered list of labels including an All choice (1. All, 2. first label, etc.). Wait for the user's number. Then call list_tasks for that label with include_subtasks: true (omit label for All), show a plain numbered list of unfinished tasks with parent/label context as needed, and wait for the user's number. Retain the exact number-to-ID mapping; never guess an ID or silently choose a task. Offer search and more pages using query and next_offset; do not silently truncate the list. A form-shaped text block or an unnumbered bullet list is not the numbered fallback.
After any selection method returns an exact task ID, call work_on_task with that task_id to read the latest task before doing the work. Do not restart selection. Authentication or data-loading failures are not UI capability failures: report them instead of inventing choices from stale data.`;

export const TASK_PICKER_PENDING_MESSAGE = 'タスクピッカーを開く処理が成功しました。ユーザーの選択とAIハンドオフによるタスクIDを待ってください。選択待ちは表示失敗ではありません。AIが画面を直接見られないことや、別方式の選択フォームが非対応であることを理由に「ピッカーが表示できない」と説明したり、別の一覧を出したりしないでください。ホストがMCP Appsの非対応・描画失敗を明示した場合、またはユーザーが使えないと伝えた場合のみ、work_on_taskの選択フォームへ切り替えてください。そのフォームも使えない場合に限り、list_tasksでラベル→タスクの番号リストを出し、番号の回答を待ってください。';

export const TASK_PICKER_PENDING = {
  selection_status: 'awaiting_user',
  next_action: 'wait_for_user_selection',
  message: TASK_PICKER_PENDING_MESSAGE,
} as const;

export function workOnTaskInstructions(taskId?: string, latestIncluded = false): string {
  const selection = latestIncluded
    ? 'The latest task details are already included below. Use them to assess the next step; re-fetch only if you need to check for changes.'
    : taskId
    ? `Call the bizencore work_on_task tool with task_id "${taskId}" to read the latest task. Do not rely on a copied snapshot.`
    : TASK_SELECTION_INSTRUCTIONS;

  return `${selection} Read the task, attachments, subtasks and completion criteria. If essential information is missing, consult with me: ask focused questions, offer concrete options and a recommendation, and continue working in this same conversation once I answer. Do not demand a complete specification when a responsible next step is clear. Save only durable decisions as concise task context with attach_context so they are available next time. Then do the actual work; do not stop after selecting, summarizing, or consulting. When the outcome is verified against the completion criteria, call complete_task. If work remains or you are waiting for an answer, call record_task_progress to check only verified finished subtasks, add concrete remaining work without duplication, and record a short progress or blocker note. Keep the parent task incomplete until its completion criteria are met. Tell me what you did and what remains.`;
}

export function buildMcpHandoffPrompt(taskId: string, title: string): string {
  return `bizencore のタスク「${title.trim() || '（無題）'}」を進めてください。\nタスクID: ${taskId}\n\n${workOnTaskInstructions(taskId)}\n\nbizencore MCP に接続できない場合は、タスクを読めず、進捗も反映できないことを伝えてください。`;
}
