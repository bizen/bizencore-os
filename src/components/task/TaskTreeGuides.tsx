import type { CSSProperties } from 'react';

const RAIL_COLORS = ['59, 130, 203', '39, 148, 108', '181, 124, 35', '151, 91, 194'];

/** Connect tasks continuously while leaving label-to-task edges clear. */
export function TaskTreeGuides({ depth, hasChildren, continuations = [], firstTaskDepth = 0 }: { depth: number; hasChildren: boolean; continuations?: readonly boolean[]; firstTaskDepth?: number }) {
  const levels = Array.from({ length: depth + (hasChildren ? 1 : 0) }, (_, level) => level).slice(firstTaskDepth).filter(level => level >= depth - 1 || continuations[level]);
  if (!levels.length) return null;
  return <span className="row-tree-guides" aria-hidden="true">
    {levels.map(level => <span key={level}
      className={`row-tree-guide${level === depth ? ' row-tree-stem' : level === depth - 1 ? ' is-parent' : ''}${level === depth - 1 && continuations[level] ? ' is-continuing' : ''}`}
      style={{ '--tree-level': level, '--tree-color': RAIL_COLORS[Math.min(level - firstTaskDepth, RAIL_COLORS.length - 1)] } as CSSProperties}>{level === depth - 1 ? <span className="row-tree-branch" /> : null}</span>)}
  </span>;
}
