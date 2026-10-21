import type { CSSProperties } from 'react';

const RAIL_COLORS = ['97, 139, 174', '102, 157, 134', '170, 145, 97', '151, 126, 174'];

/** Keep inner ancestor rails continuous, leaving the outermost column clear. */
export function TaskTreeGuides({ depth, hasChildren }: { depth: number; hasChildren: boolean }) {
  const levels = Array.from({ length: depth + (hasChildren ? 1 : 0) }, (_, level) => level).slice(1);
  if (!levels.length) return null;
  return <span className="row-tree-guides" aria-hidden="true">
    {levels.map(level => <span key={level}
      className={`row-tree-guide${level === depth ? ' row-tree-stem' : level === depth - 1 ? ' is-parent' : ''}`}
      style={{ '--tree-level': level, '--tree-color': RAIL_COLORS[Math.min(level - 1, RAIL_COLORS.length - 1)] } as CSSProperties} />)}
  </span>;
}
