import { lifeWorldStore, lifeStorageKey } from './lifeWorldStore';

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
  try { lifeWorldStore.clearAccount(userId); } catch { cleared = false; }
  // The task/text caches are shared across accounts: never erase them here.
  try {
    localStorage.removeItem(`chrct.tasks.synced.${userId}`);
    localStorage.removeItem(lifeStorageKey(userId));
  } catch { cleared = false; }
  return cleared;
}
