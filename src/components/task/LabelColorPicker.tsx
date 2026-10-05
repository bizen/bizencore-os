import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LABEL_COLORS, LABEL_COLOR_KEYS, LABEL_COLOR_NAMES, type LabelColor } from '../../lib/taskModel';

const POPOVER_WIDTH = 176;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
const GRID_COLUMNS = 4;

/**
 * ラベルの色。ふだんは丸ひとつだけ置いて、押したときに選ぶ場所を出す。
 * 色の選択肢はポップオーバーに収める。
 */
export function LabelColorPicker({
  color,
  isOpen,
  onOpenChange,
  onSelect,
  dataMeta,
  onChipKeyDown,
  onChipFocus,
}: {
  color?: LabelColor;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (color: LabelColor | undefined) => void;
  dataMeta?: string;
  onChipKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  onChipFocus?: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={anchorRef} className="label-color">
      <button
        type="button"
        data-meta={dataMeta}
        className={`color-dot${color ? ' is-set' : ''}`}
        style={color ? ({ '--swatch': LABEL_COLORS[color] } as React.CSSProperties) : undefined}
        onClick={() => onOpenChange(!isOpen)}
        onKeyDown={onChipKeyDown}
        onFocus={onChipFocus}
        tabIndex={-1}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label="ラベルの色を選ぶ"
        title="ラベルの色（⌥M でも切り替えられます）"
      />
      {isOpen ? (
        <ColorPopover
          anchorRef={anchorRef}
          color={color}
          onSelect={(next) => {
            onSelect(next);
            onOpenChange(false);
            anchorRef.current?.querySelector('button')?.focus();
          }}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </div>
  );
}

function ColorPopover({
  anchorRef,
  color,
  onSelect,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  color?: LabelColor;
  onSelect: (color: LabelColor | undefined) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // 位置が決まって見える状態になってから、いまの色にフォーカスを置く
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const rect = anchor.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        rect.right - POPOVER_WIDTH,
        window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN
      )
    );
    let top = rect.bottom + ANCHOR_GAP;
    if (top + popover.offsetHeight > window.innerHeight - VIEWPORT_MARGIN) {
      top = rect.top - popover.offsetHeight - ANCHOR_GAP;
    }
    popover.style.position = 'fixed';
    popover.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    popover.style.left = `${left}px`;
    popover.style.visibility = 'visible';

    const current =
      popover.querySelector<HTMLElement>('.color-option.is-on') ??
      popover.querySelector<HTMLElement>('.color-option');
    current?.focus();
  }, [anchorRef]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [anchorRef, onClose]);

  const step = (from: HTMLElement, direction: number) => {
    const all = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>('.color-option') ?? []
    );
    const index = all.indexOf(from);
    const nextIndex = direction === GRID_COLUMNS && index >= LABEL_COLOR_KEYS.length - GRID_COLUMNS
      ? LABEL_COLOR_KEYS.length
      : direction === -GRID_COLUMNS && index === LABEL_COLOR_KEYS.length
        ? LABEL_COLOR_KEYS.length - GRID_COLUMNS
        : index + direction;
    const next = all[nextIndex];
    next?.focus();
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="color-popover"
      role="group"
      aria-label="ラベルの色"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          anchorRef.current?.querySelector('button')?.focus();
          return;
        }
        const direction = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLUMNS, ArrowUp: -GRID_COLUMNS }[e.key];
        if (direction !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          step(e.target as HTMLElement, direction);
        }
      }}
    >
      <div className="color-swatches">
        {LABEL_COLOR_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`color-option${color === key ? ' is-on' : ''}`}
            style={{ '--swatch': LABEL_COLORS[key] } as React.CSSProperties}
            onClick={() => onSelect(key)}
            aria-pressed={color === key}
            aria-label={LABEL_COLOR_NAMES[key]}
            title={LABEL_COLOR_NAMES[key]}
          ><span className="swatch" aria-hidden="true" /></button>
        ))}
      </div>
      <button
        type="button"
        className={`color-option color-reset${color ? '' : ' is-on'}`}
        onClick={() => onSelect(undefined)}
        aria-pressed={!color}
        title="色なし"
      ><span className="swatch swatch--none" aria-hidden="true" />色なし</button>
    </div>,
    document.body
  );
}
