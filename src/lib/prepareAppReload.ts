import { lifeWorldStore } from './lifeWorldStore';
import { saveTasksBeforeReload } from './taskStore';

export function prepareAppReload(): boolean {
  if (document.querySelector('.context-upload-btn[aria-busy="true"]')) {
    window.alert('ファイルのアップロードが終わってから更新してください。');
    return false;
  }
  const draft = document.querySelector<HTMLTextAreaElement>('.context-input');
  if (draft?.value.trim() && !window.confirm('まだ添付していない文章は失われます。新版に更新しますか？')) return false;
  const tasksSaved = saveTasksBeforeReload();
  const lifeSaved = lifeWorldStore.saveBeforeReload();
  let otherInputsSaved = true;
  try {
    for (const input of document.querySelectorAll<HTMLTextAreaElement>('[data-reload-storage-key]')) {
      const key = input.dataset.reloadStorageKey;
      if (key) localStorage.setItem(key, input.value);
    }
  } catch { otherInputsSaved = false; }
  if (!tasksSaved || !lifeSaved || !otherInputsSaved) {
    window.alert('端末への保存に失敗したため、更新を中止しました。入力内容を控えて、端末の保存容量などを確認してください。');
    return false;
  }
  return true;
}
