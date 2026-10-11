import { useEffect, useState, type RefObject } from 'react';

const MARKS = 8;

export function TaskScrollRail({ container, controls }: { container?: RefObject<HTMLElement | null>; controls: string }) {
  const [position, setPosition] = useState({ progress: 0, maximum: 0 });
  const scroller = () => container?.current ?? document.scrollingElement as HTMLElement;

  useEffect(() => {
    const element = container?.current ?? document.scrollingElement as HTMLElement;
    const target = container?.current ?? window;
    let frame = 0;
    const update = () => {
      const maximum = Math.max(0, element.scrollHeight - (container ? element.clientHeight : window.innerHeight));
      const progress = maximum ? Math.max(0, Math.min(1, element.scrollTop / maximum)) : 0;
      setPosition(previous => previous.maximum === maximum && previous.progress === progress ? previous : { maximum, progress });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const content = container ? container.current?.querySelector('.app-shell') : document.querySelector('.app-shell');
    if (content) resize.observe(content);
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => {
      resize.disconnect(); cancelAnimationFrame(frame);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [container]);

  if (!position.maximum) return null;
  const active = Math.round(position.progress * (MARKS - 1));
  const moveTo = (clientY: number, element: HTMLDivElement) => {
    const rect = element.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (clientY - rect.top - 8 - 7) / (rect.height - 16 - 14)));
    scroller().scrollTop = progress * position.maximum;
  };
  return <div className="task-scroll-rail" role="scrollbar" aria-label="タスクリストのスクロール位置"
    aria-controls={controls} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.round(position.progress * 100)} tabIndex={0}
    title={`スクロール位置 ${Math.round(position.progress * 100)}%`}
    onKeyDown={event => {
      const element = scroller();
      const page = (container ? element.clientHeight : window.innerHeight) * 0.9;
      const next = { ArrowUp: element.scrollTop - 40, ArrowDown: element.scrollTop + 40,
        PageUp: element.scrollTop - page, PageDown: element.scrollTop + page, Home: 0, End: position.maximum }[event.key];
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation();
      element.scrollTop = Math.max(0, Math.min(position.maximum, next));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      moveTo(event.clientY, event.currentTarget);
    }}
    onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event.clientY, event.currentTarget);
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}>
    {Array.from({ length: MARKS }, (_, index) => <span key={index} className={`task-scroll-mark${index === active ? ' is-current' : ''}`} aria-hidden="true" />)}
  </div>;
}
