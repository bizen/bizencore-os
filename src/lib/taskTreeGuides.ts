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
