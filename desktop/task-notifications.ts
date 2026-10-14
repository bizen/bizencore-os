type AssignedTask = { paneId: string; taskId: string; title: string; done: boolean };
// Compare only tasks that existed and were assigned on both snapshots.
export function completedAssignments(previous: AssignedTask[], current: AssignedTask[]): AssignedTask[] {
  return current.filter(task => task.done && previous.some(before => before.paneId === task.paneId && before.taskId === task.taskId && !before.done));
}
