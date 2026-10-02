---
name: bizencore-work-on-task
description: Select a bizencore task by label in Codex CLI, work on it, and record verified completion or partial progress through bizencore MCP.
---

# Work on a bizencore task

Use the connected `bizencore` MCP server. If it cannot be reached or authenticated, explain that the task cannot be read or updated and stop. Do not treat a pasted task description as current state.

1. If the user provided an exact task ID, skip selection. Otherwise call `list_tasks` to obtain the current labels. Show the labels and an "All" choice, then wait for the user to choose. Do not silently choose a label. Use `list_tasks` again for the chosen label (`include_subtasks: true`; omit `label` for All). Show unfinished task titles with enough context to distinguish them, and wait for one task choice. Use `query` and `offset` when needed; do not assume the first page is complete. Codex CLI selection is conversational: do not rely on the no-argument `work_on_task` elicitation form.
2. Call `work_on_task` with the exact `task_id`. Read the returned latest task, context, subtasks, and completion criteria. If essential information is missing, ask focused questions with options and a recommendation. Continue the same task when the user replies; avoid asking for a full specification when a responsible next step is clear.
3. Do the work, respecting the task's actual scope and normal permissions. Save durable decisions concisely with `attach_context` when they would help a future session.
4. Call `complete_task` only after verifying the completion criteria. If work remains or an answer is pending, call `record_task_progress` with verified completed subtasks, concrete remaining subtasks where useful, and a short progress or blocker note. Leave the parent task incomplete. Report what is done and what remains.
