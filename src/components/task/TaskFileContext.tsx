import { useAuth } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { FileUp, Paperclip } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import { uploadTaskFiles } from '../../lib/taskFileUpload';
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
    const isCurrent = () => batchRef.current === batch && latest.current.taskId === taskId &&
      latest.current.userId === userId && latest.current.isSignedIn === true;
    setErrors([]);
    setProgress({ current: 1, total: files.length });
    try {
      await uploadTaskFiles({ taskId, files, convexUrl: convexUrl ?? '', isCurrent,
        getToken: () => getToken(sessionClaims?.aud === 'convex' ? undefined : { template: 'convex' }),
        attachmentIds: () => latest.current.attachmentIds,
        onUploaded: input => latest.current.onUploaded(input),
        onProgress: (current, total) => setProgress({ current, total }), onErrors: setErrors });
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
