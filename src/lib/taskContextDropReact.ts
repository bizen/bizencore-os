import { createContext, useContext, type DragEvent } from 'react';

export type TaskDropHandlers = {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

export const TaskContextDropContext = createContext<{
  targetId: string | null;
  handlers: (id: string) => TaskDropHandlers;
} | null>(null);

export function useTaskContextDrop(id: string) {
  const context = useContext(TaskContextDropContext);
  return { active: context?.targetId === id, handlers: context?.handlers(id) };
}
