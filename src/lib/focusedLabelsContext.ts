import { createContext, useContext } from 'react';

export interface FocusedLabels {
  ids: string[];
  change: (labelId: string, focused: boolean) => void;
  error: string | null;
}
export const FocusedLabelsContext = createContext<FocusedLabels | null>(null);

export function useFocusedLabels(): FocusedLabels {
  const value = useContext(FocusedLabelsContext);
  if (!value) throw new Error('Missing focused labels provider');
  return value;
}
