import { convexUrl } from './cloudConfig';
import { focusCacheKey } from './focusedLabels';

export const ACCOUNT_DELETION_EVENT = 'bizencore:account-deletion';
export const deletionKey = (userId: string) => `bizencore.account-deletion.${userId}`;

export function deletionRemembered(userId: string): boolean {
  try { return localStorage.getItem(deletionKey(userId)) === 'accepted'; }
  catch { return false; }
}

export function rememberAccountDeletion(userId: string) {
  try { localStorage.setItem(deletionKey(userId), 'accepted'); } catch { /* Reactive server status also blocks access. */ }
  window.dispatchEvent(new CustomEvent(ACCOUNT_DELETION_EVENT, { detail: userId }));
}

export function clearDeletedAccountCache(userId: string): boolean {
  let cleared = true;
  // The task/text caches are shared across accounts: never erase them here.
  try {
    localStorage.removeItem(`chrct.tasks.synced.${userId}`);
    // Retired Life World cache of the deleted account; the feature no longer reads it.
    localStorage.removeItem(`bizencore.life-world.account.${userId}.v1`);
    localStorage.removeItem(focusCacheKey(convexUrl ?? 'local', userId));
  } catch { cleared = false; }
  return cleared;
}
