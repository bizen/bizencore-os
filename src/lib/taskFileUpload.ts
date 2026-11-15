import { MAX_ATTACHMENTS, MAX_FILE_SIZE } from './attachments';

export interface UploadedTaskFile {
  id: string;
  storageId: string;
  title: string;
  mimeType: string;
  size: number;
}

/** The chooser and row drops share validation, sequential uploads and sync-aware capacity. */
export async function uploadTaskFiles(options: {
  taskId: string;
  files: File[];
  convexUrl: string;
  getToken: () => Promise<string | null>;
  isCurrent: () => boolean;
  attachmentIds: () => string[];
  onUploaded: (input: UploadedTaskFile) => boolean;
  onProgress: (current: number, total: number) => void;
  onErrors: (errors: string[]) => void;
}): Promise<{ uploaded: number; errors: string[] }> {
  const failures: string[] = [];
  const uploadedIds = new Set<string>();
  let uploaded = 0;
  const fail = (message: string) => {
    failures.push(message);
    options.onErrors([...failures]);
  };
  for (const [index, file] of options.files.entries()) {
    if (!options.isCurrent()) break;
    // An early sync response and the upload response may contain the same ID.
    if (new Set([...options.attachmentIds(), ...uploadedIds]).size >= MAX_ATTACHMENTS) {
      fail(`残り${options.files.length - index}件は添付できませんでした。コンテキストは合計${MAX_ATTACHMENTS}件までです。`);
      break;
    }
    options.onProgress(index + 1, options.files.length);
    try {
      if (file.size === 0) throw new Error('空のファイルは添付できません');
      if (file.size > MAX_FILE_SIZE) throw new Error('ファイルは10 MB以下にしてください');
      const token = await options.getToken();
      if (!options.isCurrent()) break;
      if (!token || !options.convexUrl) throw new Error('サインインを確認してください');
      const response = await fetch(`${options.convexUrl.replace(/\.convex\.cloud$/, '.convex.site')}/files/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'X-Task-Id': options.taskId,
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await response.json() as { id?: unknown; storageId?: unknown; error?: string };
      if (!options.isCurrent()) break;
      if (!response.ok) throw new Error(data.error || 'アップロードできませんでした');
      if (typeof data.id !== 'string' || typeof data.storageId !== 'string') throw new Error('アップロードできませんでした');
      uploadedIds.add(data.id);
      if (options.onUploaded({ id: data.id, storageId: data.storageId, title: file.name, mimeType: file.type, size: file.size })) {
        uploaded++;
      } else {
        fail(`${file.name}：アップロード済みですが、この端末に反映できませんでした。再読み込みして確認してください。`);
      }
    } catch (cause) {
      if (!options.isCurrent()) break;
      fail(`${file.name}：${cause instanceof Error ? cause.message : 'アップロードできませんでした'}`);
    }
  }
  return { uploaded, errors: failures };
}
