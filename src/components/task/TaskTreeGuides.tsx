import type { CSSProperties } from 'react';

const RAIL_COLORS = ['59, 130, 203', '39, 148, 108', '181, 124, 35', '151, 91, 194'];

/** Keep inner ancestor rails continuous, leaving the outermost column clear. */
export function TaskTreeGuides({ depth, hasChildren, continuations = [] }: { depth: number; hasChildren: boolean; continuations?: readonly boolean[] }) {
  const levels = Array.from({ length: depth + (hasChildren ? 1 : 0) }, (_, level) => level).slice(1).filter(level => level >= depth - 1 || continuations[level]);
  if (!levels.length) return null;
  return <span className="row-tree-guides" aria-hidden="true">
    {levels.map(level => <span key={level}
      className={`row-tree-guide${level === depth ? ' row-tree-stem' : level === depth - 1 ? ' is-parent' : ''}${level === depth - 1 && continuations[level] ? ' is-continuing' : ''}`}
      style={{ '--tree-level': level, '--tree-color': RAIL_COLORS[Math.min(level - 1, RAIL_COLORS.length - 1)] } as CSSProperties}>{level === depth - 1 ? <span className="row-tree-branch" /> : null}</span>)}
  </span>;
}
