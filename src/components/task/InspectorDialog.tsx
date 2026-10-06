import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const CONTROLS = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])';

export function InspectorDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLElement>(null);
  const moveFocus = (current: EventTarget | null, direction: -1 | 1) => {
    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])]
      .filter(element => element.getClientRects().length > 0);
    if (!controls.length) return;
    const index = controls.indexOf(current as HTMLElement);
    controls[index < 0 ? (direction === 1 ? 0 : controls.length - 1)
      : (index + direction + controls.length) % controls.length].focus();
  };
  return (
    <aside ref={panelRef} className="inspector" role="dialog" aria-label={label}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
        if (event.key === 'Tab') { event.preventDefault(); moveFocus(event.target, event.shiftKey ? -1 : 1); return; }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        const target = event.target;
        if (!event.altKey && target instanceof HTMLTextAreaElement) {
          if (target.selectionStart !== target.selectionEnd) return;
          if (event.key === 'ArrowUp' && target.selectionStart !== 0) return;
          if (event.key === 'ArrowDown' && target.selectionStart !== target.value.length) return;
        } else if (!event.altKey && (target instanceof HTMLSelectElement ||
          (target instanceof HTMLInputElement && (target.type === 'date' || target.type === 'time')))) return;
        event.preventDefault();
        moveFocus(target, event.key === 'ArrowUp' ? -1 : 1);
      }}>
      <div className="inspector-head">
        <span className="inspector-kicker">詳細</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる（Esc）" title="閉じる（Esc）">
          <X size={16} aria-hidden />
        </button>
      </div>
      {children}
    </aside>
  );
}
