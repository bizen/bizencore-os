import { createContext } from 'react';

// Set only below the native authorization gate. Signed-out screens never load
// account workspace preferences or expose restored panes.
export const DesktopWorkspaceAccount = createContext<string | null>(null);
