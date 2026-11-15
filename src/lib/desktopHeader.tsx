import { createContext } from 'react';

export const DesktopHeaderContext = createContext<{ host: HTMLDivElement | null; showTasks: () => void } | null>(null);
