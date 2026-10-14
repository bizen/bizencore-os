import { createContext, useContext } from 'react';
import type { HandoffIntent } from './taskWorkPrompt';

export type PaneAssignment = { taskId: string; intent: HandoffIntent; mode: 'mcp' | 'text' };
export type HandoffPane = { id: string; name: string; busy: boolean; taskId?: string };
export const DesktopHandoffContext = createContext<{
  panes: HandoffPane[];
  mcpAvailable: boolean;
  assign: (paneId: string | null, assignment: PaneAssignment) => string | null;
  openTools?: (mode: 'execute' | 'decompose', taskIds: string[]) => void;
} | null>(null);
export const useDesktopHandoff = () => useContext(DesktopHandoffContext);
