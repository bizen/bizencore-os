import type { TaskKind } from './taskModel';

/** クエスト種別の絵と名前。行と詳細パネルで同じものを使う */
export const QUEST_IMG: Record<TaskKind, string> = {
  main: '/quests/mainquest.png',
  tanomi: '/quests/tanomigoto.png',
};

export const QUEST_LABEL: Record<TaskKind, string> = {
  main: 'メインクエスト',
  tanomi: '頼みごと',
};

export const QUEST_KINDS: TaskKind[] = ['main', 'tanomi'];
