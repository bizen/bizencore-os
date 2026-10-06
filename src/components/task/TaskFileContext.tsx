import { useAuth } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { FileUp, Paperclip } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import { MAX_ATTACHMENTS, MAX_FILE_SIZE } from '../../lib/attachments';
import { convexUrl } from '../../lib/cloudConfig';

interface FileInputProps {
  taskId: string;
  disabled: boolean;
  attachmentIds: string[];
  onUploaded: (input: { id: string; storageId: string; title: string; mimeType: string; size: number }) => boolean;
}

export function TaskFileInput({ taskId, disabled, attachmentIds, onUploaded }: FileInputProps) {
  const { isSignedIn, userId, getToken, sessionClaims } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const batchRef = useRef<symbol | null>(null);
  const latest = useRef({ taskId, userId, isSignedIn, attachmentIds, onUploaded });

  useLayoutEffect(() => {
    latest.current = { taskId, userId, isSignedIn, attachmentIds, onUploaded };
  }, [taskId, userId, isSignedIn, attachmentIds, onUploaded]);
  useLayoutEffect(() => () => { batchRef.current = null; }, []);

  const upload = async (files: File[]) => {
    if (batchRef.current || disabled || !isSignedIn || files.length === 0) return;
    const batch = Symbol();
    batchRef.current = batch;
    const failures: string[] = [];
    const uploadedIds = new Set<string>();
    const isCurrent = () => batchRef.current === batch && latest.current.taskId === taskId &&
      latest.current.userId === userId && latest.current.isSignedIn;
    setErrors([]);
    setProgress({ current: 1, total: files.length });
    try {
      for (const [index, file] of files.entries()) {
        if (!isCurrent()) break;
        // Union IDs so early sync delivery neither double-counts nor hides a pending upload.
        if (new Set([...latest.current.attachmentIds, ...uploadedIds]).size >= MAX_ATTACHMENTS) {
          failures.push(`残り${files.length - index}件は添付できませんでした。コンテキストは合計${MAX_ATTACHMENTS}件までです。`);
          setErrors([...failures]);
          break;
        }
        setProgress({ current: index + 1, total: files.length });
        try {
          if (file.size === 0) throw new Error('空のファイルは添付できません');
          if (file.size > MAX_FILE_SIZE) throw new Error('ファイルは10 MB以下にしてください');
          const token = await getToken(sessionClaims?.aud === 'convex' ? undefined : { template: 'convex' });
          if (!isCurrent()) break;
          if (!token || !convexUrl) throw new Error('サインインを確認してください');
          const response = await fetch(`${convexUrl.replace(/\.convex\.cloud$/, '.convex.site')}/files/upload`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': file.type || 'application/octet-stream',
              'X-Task-Id': taskId,
              'X-File-Name': encodeURIComponent(file.name),
            },
            body: file,
          });
          const data = await response.json() as { id?: unknown; storageId?: unknown; error?: string };
          if (!isCurrent()) break;
          if (!response.ok) throw new Error(data.error || 'アップロードできませんでした');
          if (typeof data.id !== 'string' || typeof data.storageId !== 'string') throw new Error('アップロードできませんでした');
          uploadedIds.add(data.id);
          if (!latest.current.onUploaded({ id: data.id, storageId: data.storageId, title: file.name, mimeType: file.type, size: file.size })) {
            failures.push(`${file.name}：アップロード済みですが、この端末に反映できませんでした。再読み込みして確認してください。`);
            setErrors([...failures]);
          }
        } catch (cause) {
          if (!isCurrent()) break;
          failures.push(`${file.name}：${cause instanceof Error ? cause.message : 'アップロードできませんでした'}`);
          setErrors([...failures]);
        }
      }
    } finally {
      if (batchRef.current === batch) {
        batchRef.current = null;
        setProgress(null);
      }
    }
  };

  const uploading = progress !== null;

  return (
    <div className="context-upload">
      <input
        ref={inputRef}
        type="file"
        multiple
        disabled={disabled || uploading || !isSignedIn}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void upload(files);
        }}
        aria-label="ファイルを選ぶ"
      />
      <button
        type="button"
        className="ghost-btn context-upload-btn"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading || !isSignedIn}
        aria-busy={uploading}
        title={!isSignedIn ? 'ファイル添付にはサインインが必要です' : 'ファイルを添付'}
      >
        {uploading ? <FileUp size={14} aria-hidden /> : <Paperclip size={14} aria-hidden />}
        {progress ? `アップロード中（${progress.current}/${progress.total}）` : 'ファイル'}
      </button>
      {!isSignedIn ? <span className="inspector-hint">ファイルはサインイン後に追加できます</span> : null}
      {errors.length ? <ul className="context-upload-errors context-error" role="alert">
        {errors.map((error, index) => <li key={index}>{error}</li>)}
      </ul> : null}
    </div>
  );
}

export function TaskFileLink({ taskId, attachmentId, title }: { taskId: string; attachmentId: string; title: string }) {
  const { isSignedIn } = useAuth();
  const url = useQuery(api.sync.fileUrl, isSignedIn ? { taskId, attachmentId } : 'skip');
  return url ? (
    <a className="context-title" href={url} target="_blank" rel="noopener noreferrer">{title}</a>
  ) : (
    <span className="context-title">{title}</span>
  );
}
