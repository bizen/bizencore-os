import { useContext, useEffect, useRef, useState } from 'react';
import { DesktopHeaderContext } from '../lib/desktopHeader';
import { DesktopInspectorContext } from '../lib/desktopInspector';
import { mascotThoughts, pickMascotThought, type MascotThought } from '../lib/mascotThoughts';
import { taskStore, useTaskState } from '../lib/taskStore';
import { useUserTimeZone } from '../lib/userTimeZone';

export function MascotIdleThought({ paused }: { paused: boolean }) {
  const { items } = useTaskState();
  const timeZone = useUserTimeZone();
  const inspector = useContext(DesktopInspectorContext);
  const header = useContext(DesktopHeaderContext);
  const [thought, setThought] = useState<MascotThought | null>(null);
  const [since] = useState(Date.now);
  const recent = useRef<MascotThought[]>([]);
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    let timer: number;
    const blocked = () => document.hidden || !!document.querySelector('[role="dialog"], dialog[open]') ||
      !!document.activeElement?.closest('input, textarea, select, [contenteditable="true"]');
    const hide = () => { setThought(null); };
    const schedule = () => { timer = window.setTimeout(show, 30_000 + Math.random() * 30_000); };
    const show = () => {
      if (!pausedRef.current && !blocked() && Math.random() < 0.8) {
        const next = pickMascotThought(mascotThoughts(taskStore.getState().items, Date.now(), since, timeZone), recent.current);
        if (next) {
          recent.current = [...recent.current.slice(-5), next];
          setThought(next);
        }
      }
      timer = window.setTimeout(dismiss, 5_000);
    };
    const dismiss = () => {
      if (document.querySelector('.mascot-idle-thought:hover, .mascot-idle-thought:focus-within')) {
        timer = window.setTimeout(dismiss, 1_000); return;
      }
      setThought(null); schedule();
    };
    schedule();
    document.addEventListener('focusin', hideOutside);
    document.addEventListener('keydown', hideOnKey);
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('pointerdown', hideOutside);
    function hideOnKey(event: KeyboardEvent) {
      if (event.key === 'Escape') hide();
      else hideOutside(event);
    }
    function hideOutside(event: Event) {
      if (!(event.target instanceof Element) || !event.target.closest('.mascot-idle-thought')) hide();
    }
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', hideOutside);
      document.removeEventListener('keydown', hideOnKey);
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('pointerdown', hideOutside);
    };
  }, [timeZone, since]);

  const current = thought?.taskId ? items[thought.taskId] : undefined;
  const valid = !thought?.taskId || (current && !current.deletedAt && !current.filed && !current.locked &&
    current.text.replace(/\p{Cc}/gu, ' ').trim() === thought.title && current.done === (thought.kind === 'joy'));
  if (!thought || paused || !valid) return null;
  const content = <>{thought.title ? <><span className="mascot-thought-title">「{thought.title}」</span><span>{thought.ending.replace(/^、/, '')}</span></> : thought.ending}</>;
  return thought.taskId ? <button type="button" className="mascot-thought mascot-idle-thought" aria-label={`${thought.title}${thought.ending} タスクを開く`}
    onClick={() => {
      const id = thought.taskId!;
      setThought(null);
      header?.showTasks();
      if (inspector?.openTask) inspector.openTask(id);
      else window.dispatchEvent(new CustomEvent('bizencore:inspect-task', { detail: id }));
    }}>{content}</button> : <div className="mascot-thought mascot-idle-thought">{content}</div>;
}
