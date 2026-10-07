import { useAuth } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { Check, ChevronRight, LockKeyhole, Users } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { partnerDisplayRows, type PartnerItem } from '../lib/partnerModel';
import { LABEL_COLORS } from '../lib/taskModel';
import { TaskTreeGuides } from './task/TaskTreeGuides';

interface WorkspaceProps {
  children: ReactNode;
  side: 'self' | 'partner';
  onSideChange: (side: 'self' | 'partner') => void;
}

export function PartnerWorkspace({ enabled, ...props }: WorkspaceProps & { enabled: boolean }) {
  return enabled && isCloudConfigured ? <AuthenticatedWorkspace {...props} /> : <>{props.children}</>;
}

function AuthenticatedWorkspace(props: WorkspaceProps) {
  const { isSignedIn, userId } = useAuth();
  return isSignedIn && userId ? <Workspace key={userId} accountId={userId} {...props} /> : <>{props.children}</>;
}

function Workspace({ accountId, children, side, onSideChange }: WorkspaceProps & { accountId: string }) {
  const partner = useQuery(api.partners.list, { accountId });
  if (!partner || partner.accountId !== accountId) return <>{children}</>;
  return <div className="partner-workspace is-connected" data-partner-view={side}>
    <div className="partner-side-switch" role="tablist" aria-label="表示する人" data-partner-surface
      onKeyDown={event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 'self' : event.key === 'End' ? 'partner' : side === 'self' ? 'partner' : 'self';
          onSideChange(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-side="${next}"]`)?.focus();
        }
      }}>
      <button type="button" role="tab" data-side="self" tabIndex={side === 'self' ? 0 : -1} aria-selected={side === 'self'} onClick={() => onSideChange('self')}>自分</button>
      <button type="button" role="tab" data-side="partner" tabIndex={side === 'partner' ? 0 : -1} aria-selected={side === 'partner'} onClick={() => onSideChange('partner')}><Users size={14} aria-hidden />パートナー</button>
    </div>
    <div className="partner-self"><h2 className="partner-column-heading">自分</h2>{children}</div>
    <PartnerList name={partner.name} items={partner.items} />
  </div>;
}

function PartnerList({ name, items }: { name: string; items: PartnerItem[] }) {
  const [shelfOpen, setShelfOpen] = useState(false);
  const { active, done } = partnerDisplayRows(items);
  const rows = (list: typeof active) => list.map(({ item, depth, hasChildren }) => <li key={item.id}
    className={`row ${item.type === 'section' ? 'row--section' : 'row--task'}${depth === 0 ? ' row--root' : ''}${item.done ? ' is-done' : ''}`}
    style={{ '--depth': depth, ...(item.color ? { '--label-color': LABEL_COLORS[item.color] } : {}) } as CSSProperties}>
    <div className="row-main">
      <TaskTreeGuides depth={depth} hasChildren={hasChildren && item.type !== 'section'} />
      <div className="row-mark">{item.type === 'section' ? <span className="row-section-mark" aria-hidden />
        : item.locked ? <span className="row-lock-mark" role="img" aria-label="ロック中"><LockKeyhole size={14} aria-hidden /></span>
        : <span className={`check partner-check${item.done ? ' is-checked' : ''}`} role="img" aria-label={item.done ? '完了' : '未完了'}>
          <span className="check-fill" aria-hidden />{item.done ? <Check size={15} className="partner-check-mark" aria-hidden /> : null}
        </span>}</div>
      <div className="row-text"><span className={`row-title partner-title${item.type === 'section' ? ' row-title--section' : ''}`}>{item.text || '無題'}</span>
        {item.dueDate ? <time className="partner-deadline" dateTime={item.dueDate}>{item.dueDate.replaceAll('-', '/')}{item.dueTime ? ` ${item.dueTime}` : ''}</time> : null}
      </div>
    </div>
  </li>);
  return <section className="partner-list" aria-label={`${name}の共有タスク`} data-partner-surface>
    <h2 className="partner-column-heading"><span>{name}</span><span className="partner-readonly">閲覧のみ</span></h2>
    <ul className="row-list">{rows(active)}</ul>
    {items.length === 0 ? <p className="muted">公開されたラベルはありません。</p> : null}
    {done.length ? <section className={`done-shelf${shelfOpen ? ' is-open' : ''}`}>
      <button type="button" className="done-shelf-toggle" aria-expanded={shelfOpen} onClick={() => setShelfOpen(value => !value)}>
        <ChevronRight size={14} className="done-shelf-caret" aria-hidden />完了済み<span className="done-shelf-count">{done.filter(row => row.item.type === 'task').length}</span>
      </button>
      {shelfOpen ? <ul className="row-list">{rows(done)}</ul> : null}
    </section> : null}
  </section>;
}
