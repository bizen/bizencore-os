import type { Terminal } from '@xterm/xterm';

const validation = window.bizencoreDesktop?.validation;
const sample = (kind: string, surface: string, ms: number, start?: number) => {
  void validation?.sample({ kind, surface, ms, start }).catch(() => {});
};
const afterFrame = (callback: () => void) => requestAnimationFrame(() => requestAnimationFrame(callback));
const surfaceOf = (target: EventTarget | null) => target instanceof Element && target.closest('.agent-terminal') ? 'terminal' : 'task';

export function installInputValidation() {
  if (!validation) return;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (entry.name === 'keydown') sample('event', surfaceOf(entry.target), entry.duration, entry.startTime);
    }
  });
  const options: PerformanceObserverInit & { durationThreshold: number } = { type: 'event', buffered: false, durationThreshold: 16 };
  observer.observe(options);
  document.addEventListener('keydown', event => {
    if (event.isTrusted && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      sample('key', surfaceOf(event.target), 0, event.timeStamp);
    }
  }, true);
  // No key values, input contents, task IDs or authentication data are retained.
  document.addEventListener('input', event => {
    if (!event.isTrusted || surfaceOf(event.target) === 'terminal') return;
    const start = event.timeStamp;
    afterFrame(() => sample('input-frame', 'task', performance.now() - start, start));
  }, true);
  document.addEventListener('compositionend', event => {
    if (event.isTrusted) sample('composition', surfaceOf(event.target), 0);
  }, true);
}

export function validateTerminalInput(term: Terminal, host: HTMLElement) {
  if (!validation) return { input: (data: string) => { void data; }, dispose: () => {} };
  let eventTime = 0;
  let pending: { start: number; before: string } | undefined;
  const viewport = () => {
    const buffer = term.buffer.active;
    return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString() ?? '').join('\n');
  };
  const key = (event: KeyboardEvent) => { if (event.isTrusted) eventTime = event.timeStamp; };
  host.addEventListener('keydown', key, true);
  const render = term.onRender(() => {
    if (!pending) return;
    if (viewport() === pending.before) return;
    const start = pending.start;
    pending = undefined;
    afterFrame(() => sample('terminal-frame', 'terminal', performance.now() - start, start));
  });
  return {
    input(data: string) {
      if (!data || Array.from(data).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || pending) return;
      pending = { start: eventTime && performance.now() - eventTime < 1000 ? eventTime : performance.now(), before: viewport() };
    },
    dispose() { host.removeEventListener('keydown', key, true); render.dispose(); pending = undefined; },
  };
}
