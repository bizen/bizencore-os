import type { CSSProperties } from 'react';

/** Keep each ancestor's rail visible across its whole subtree, including tall notes. */
export function TaskTreeGuides({ depth, hasChildren }: { depth: number; hasChildren: boolean }) {
  if (depth === 0 && !hasChildren) return null;
  return <span className="row-tree-guides" aria-hidden="true">
    {Array.from({ length: depth }, (_, level) => (
      <span key={level} className={`row-tree-guide${level === depth - 1 ? ' is-parent' : ''}`} style={{ '--tree-level': level } as CSSProperties} />
    ))}
    {hasChildren ? <span className="row-tree-guide row-tree-stem" style={{ '--tree-level': depth } as CSSProperties} /> : null}
  </span>;
}
