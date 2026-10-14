import { Flag, HandHelping } from 'lucide-react';
import { QUEST_IMG } from '../../lib/quests';
import type { TaskKind } from '../../lib/taskModel';

export function QuestIcon({ kind }: { kind: TaskKind }) {
  if (import.meta.env.VITE_DESKTOP_SAFE_ASSETS === 'true') {
    const Icon = kind === 'main' ? Flag : HandHelping;
    return <Icon size={16} aria-hidden />;
  }
  return <img src={QUEST_IMG[kind]} alt="" />;
}
