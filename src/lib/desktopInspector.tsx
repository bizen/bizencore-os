import { createContext } from 'react';

export const DesktopInspectorContext = createContext<{
  host: HTMLDivElement | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  openTask?: (id: string) => void;
  registerTaskOpener?: (opener: ((id: string) => void) | null) => void;
} | null>(null);
