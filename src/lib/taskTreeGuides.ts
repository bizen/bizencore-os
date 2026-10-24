/** Continuations are based on visible rows, so filtered and folded trees end cleanly. */
export function treeContinuations(rows: readonly { depth: number }[]): boolean[][] {
  const nextAtDepth: boolean[] = [];
  const result: boolean[][] = new Array(rows.length);
  for (let index = rows.length - 1; index >= 0; index--) {
    const depth = rows[index].depth;
    result[index] = Array.from({ length: depth }, (_, level) => nextAtDepth[level + 1] === true);
    nextAtDepth.length = depth + 1;
    nextAtDepth[depth] = true;
  }
  return result;
}

/** Labels occupy a display level, but only task-to-task edges get rails. */
export function firstTaskDepths(rows: readonly { depth: number; item: { type: string } }[]): number[] {
  let firstTaskDepth = rows[0]?.depth ?? 0;
  return rows.map(row => {
    if (row.depth === 0) firstTaskDepth = row.item.type === 'section' ? 1 : 0;
    return firstTaskDepth;
  });
}
