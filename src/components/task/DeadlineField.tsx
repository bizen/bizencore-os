import { CalendarDays, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 232;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export function DeadlineField({
  dueDate,
  dueTime,
  isOverdue,
  isOpen,
  onOpenChange,
  onSave,
  dataMeta,
  onChipKeyDown,
  onChipFocus,
}: {
  dueDate?: string;
  dueTime?: string;
  isOverdue: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (dueDate: string | undefined, dueTime: string | undefined) => void;
  dataMeta?: string;
  onChipKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  onChipFocus?: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = dueDate ? `${Number(dueDate.slice(5, 7))}/${Number(dueDate.slice(8, 10))}` : null;

  return (
    <div ref={anchorRef} className="deadline-field">
      <button
        type="button"
        data-meta={dataMeta}
        className={`deadline-chip${dueDate ? ' is-set' : ''}${isOverdue ? ' is-overdue' : ''}`}
        onClick={() => onOpenChange(!isOpen)}
        onKeyDown={onChipKeyDown}
        onFocus={onChipFocus}
        tabIndex={-1}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={dueDate ? `期限 ${dueDate}${dueTime ? ` ${dueTime}` : ''}を編集` : '期限を設定'}
        title={dueDate ? `期限 ${dueDate}${dueTime ? ` ${dueTime}` : ''}` : '期限を設定'}
      >
        {label ?? <CalendarDays size={14} aria-hidden />}
      </button>
      {isOpen ? (
        <DeadlinePopover
          anchorRef={anchorRef}
          dueDate={dueDate}
          dueTime={dueTime}
          onSave={onSave}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </div>
  );
}

function DeadlinePopover({
  anchorRef,
  dueDate,
  dueTime,
  onSave,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  dueDate?: string;
  dueTime?: string;
  onSave: (dueDate: string | undefined, dueTime: string | undefined) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN));
    let top = rect.bottom + ANCHOR_GAP;
    if (top + popover.offsetHeight > window.innerHeight - VIEWPORT_MARGIN) {
      top = rect.top - popover.offsetHeight - ANCHOR_GAP;
    }
    popover.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    popover.style.left = `${left}px`;
    popover.style.visibility = 'visible';
    dateRef.current?.focus();
  }, [anchorRef]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      className="deadline-popover"
      role="group"
      aria-label="期限"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        ref={dateRef}
        type="date"
        value={dueDate ?? ''}
        onChange={(event) => onSave(event.target.value || undefined, dueTime)}
        aria-label="期限の日付"
      />
      {dueDate ? (
        <input
          type="time"
          value={dueTime ?? ''}
          onChange={(event) => onSave(dueDate, event.target.value || undefined)}
          aria-label="期限の時刻（任意）"
        />
      ) : null}
      {dueDate ? (
        <button type="button" onClick={() => onSave(undefined, undefined)} aria-label="期限を削除" title="期限を削除">
          <X size={15} aria-hidden />
        </button>
      ) : null}
    </div>,
    document.body
  );
}
