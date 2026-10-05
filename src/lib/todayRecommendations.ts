import { isDateString, isTimeString } from './taskDates';
import { flattenAll, flattenToday, type Item, type ItemMap } from './taskModel';

export interface TodayRecommendation {
  item: Item;
  context: string;
  reason: string;
  overdue: boolean;
}

export function todayRecommendations(items: ItemMap, todayDate: string, todayTime: string): TodayRecommendation[] {
  if (!isDateString(todayDate) || !isTimeString(todayTime)) return [];
  const cutoff = new Date(`${todayDate}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 3);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const todayIds = new Set(flattenToday(items, todayDate).map(({ item }) => item.id));
  const rows = flattenAll(items);
  const candidateParents = new Set<string>();
  const ancestors: Item[] = [];

  const candidates: TodayRecommendation[] = [];
  for (const { item, depth } of rows) {
    ancestors.length = depth;
    const hiddenByCompletion = ancestors.some(ancestor => ancestor.type === 'task' && (ancestor.done || ancestor.filed));
    const context = ancestors.map(ancestor => ancestor.text.trim()).filter(Boolean).join(' › ');
    ancestors[depth] = item;
    if (item.type !== 'task' || item.done || item.filed || item.locked || !item.text.trim() ||
      hiddenByCompletion || todayIds.has(item.id) ||
      !item.dueDate || !isDateString(item.dueDate) || item.dueDate > cutoffDate) continue;

    const overdue = item.dueDate < todayDate || (item.dueDate === todayDate &&
      !!item.dueTime && isTimeString(item.dueTime) && item.dueTime < todayTime);
    const days = Math.round((Date.parse(`${item.dueDate}T12:00:00Z`) - Date.parse(`${todayDate}T12:00:00Z`)) / 86_400_000);
    const reason = overdue ? '期限超過' : days === 0 ? '今日締切' : days === 1 ? '明日締切' : `${days}日後締切`;
    candidates.push({ item, context, reason, overdue });
    for (let index = 0; index < depth; index++) candidateParents.add(ancestors[index].id);
  }

  // Prefer a matching child, but do not lose a parent's deadline when children have none.
  return candidates.filter(candidate => !candidateParents.has(candidate.item.id)).sort((a, b) => {
    const left = `${a.item.dueDate}T${isTimeString(a.item.dueTime ?? '') ? a.item.dueTime : '23:59'}`;
    const right = `${b.item.dueDate}T${isTimeString(b.item.dueTime ?? '') ? b.item.dueTime : '23:59'}`;
    return left < right ? -1 : left > right ? 1 : 0;
  }).slice(0, 3);
}
