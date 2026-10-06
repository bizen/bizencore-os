import { useLayoutEffect, useRef } from 'react';

export function fitTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + border}px`;
}

export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => fitTextarea(el);
    fit();
    let width = el.clientWidth;
    let active = true;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    const fitAfterFonts = () => { if (active) fit(); };
    void document.fonts.ready.then(fitAfterFonts);
    document.fonts.addEventListener('loadingdone', fitAfterFonts);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', fitAfterFonts);
    };
  }, [value]);
  return ref;
}
