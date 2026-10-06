import { useAuth } from '@clerk/clerk-react';
import { useQuery } from 'convex/react';
import { FileUp, Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import { MAX_FILE_SIZE } from '../../lib/attachments';
import { convexUrl } from '../../lib/cloudConfig';

interface FileInputProps {
  taskId: string;
  disabled: boolean;
  onUploaded: (input: { id: string; storageId: string; title: string; mimeType: string; size: number }) => void;
}

export function TaskFileInput({ taskId, disabled, onUploaded }: FileInputProps) {
  const { isSignedIn, getToken, sessionClaims } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File) => {
    setError('');
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
      setError('ファイルは 10 MB 以下にしてください');
      return;
    }
    setUploading(true);
    try {
      const token = await getToken(sessionClaims?.aud === 'convex' ? undefined : { template: 'convex' });
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
      if (!response.ok) throw new Error(data.error || 'アップロードできませんでした');
      if (typeof data.id !== 'string' || typeof data.storageId !== 'string') throw new Error('アップロードできませんでした');
      onUploaded({ id: data.id, storageId: data.storageId, title: file.name, mimeType: file.type, size: file.size });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'アップロードできませんでした');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="context-upload">
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
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
        {uploading ? 'アップロード中' : 'ファイル'}
      </button>
      {!isSignedIn ? <span className="inspector-hint">ファイルはサインイン後に追加できます</span> : null}
      {error ? <span className="context-error" role="alert">{error}</span> : null}
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
