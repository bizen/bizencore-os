import { useAuth } from '@clerk/clerk-react';
import { Check, LoaderCircle, Paperclip, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { liveAttachments, MAX_ATTACHMENTS } from '../../lib/attachments';
import { convexUrl, isCloudConfigured } from '../../lib/cloudConfig';
import { hasContextDrop, readContextDrop } from '../../lib/taskContextDrop';
import { TaskContextDropContext, type TaskDropHandlers } from '../../lib/taskContextDropReact';
import { uploadTaskFiles } from '../../lib/taskFileUpload';
import { isLive } from '../../lib/taskModel';
import { taskStore, useTaskState } from '../../lib/taskStore';

type DropAuth = { userId: string | null | undefined; signedIn: boolean; getToken: () => Promise<string | null> };
type DropStatus = { taskId: string; name: string; message: string; busy: boolean; errors: string[] };

export function TaskContextDropProvider({ children }: { children: ReactNode }) {
  return isCloudConfigured ? <CloudDropProvider>{children}</CloudDropProvider> : <DropProvider>{children}</DropProvider>;
}

function CloudDropProvider({ children }: { children: ReactNode }) {
  const { userId, isSignedIn, getToken, sessionClaims } = useAuth();
  return <DropProvider key={userId ?? 'signed-out'} auth={{ userId, signedIn: isSignedIn === true,
    getToken: () => getToken(sessionClaims?.aud === 'convex' ? undefined : { template: 'convex' }) }}>{children}</DropProvider>;
}

function DropProvider({ children, auth }: { children: ReactNode; auth?: DropAuth }) {
  const { items } = useTaskState();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [status, setStatus] = useState<DropStatus | null>(null);
  const latest = useRef({ items, auth });
  const batchRef = useRef<symbol | null>(null);
  const internalText = useRef(false);
  useLayoutEffect(() => { latest.current = { items, auth }; }, [items, auth]);
  useLayoutEffect(() => () => { batchRef.current = null; }, []);
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      internalText.current = event.target instanceof Element && !!event.target.closest('textarea, input, [contenteditable="true"]');
    };
    const finish = () => { internalText.current = false; setTargetId(null); };
    const guard = (event: globalThis.DragEvent) => {
      // A missed row must not replace the app with a local file or a dragged link.
      if (event.dataTransfer && !internalText.current && (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes('text/uri-list') ||
          (event.type === 'drop' && readContextDrop(event.dataTransfer).urls.length > 0))) {
        const handled = event.defaultPrevented;
        event.preventDefault();
        if (event.type === 'dragover' && !handled) event.dataTransfer.dropEffect = 'none';
      }
      if (event.type === 'drop') finish();
    };
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', finish);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragstart', start); window.removeEventListener('dragend', finish);
      window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard);
    };
  }, []);
  useEffect(() => {
    if (!status || status.busy || status.errors.length) return;
    const timeout = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timeout);
  }, [status]);

  const attach = async (id: string, data: DataTransfer) => {
    const item = latest.current.items[id];
    if (!isLive(item) || item.type !== 'task') return;
    const { files, urls } = readContextDrop(data);
    const name = item.text.trim() || '無題';
    if (batchRef.current) return;
    if (!files.length && !urls.length) {
      setStatus({ taskId: id, name, busy: false, message: '', errors: ['ファイルまたは http / https のリンクを添付してください。フォルダは添付できません。'] });
      return;
    }
    if (files.length) {
      const account = latest.current.auth;
      if (!account?.signedIn || !convexUrl) {
        setStatus({ taskId: id, name, busy: false, message: '', errors: ['ファイル添付にはサインインが必要です。'] });
        return;
      }
      const batch = Symbol(); batchRef.current = batch;
      const isCurrent = () => batchRef.current === batch && latest.current.auth?.signedIn === true &&
        latest.current.auth.userId === account.userId && isLive(latest.current.items[id]);
      const base = { taskId: id, name, busy: true, message: 'アップロード中', errors: [] as string[] };
      setStatus(base);
      try {
        const result = await uploadTaskFiles({ taskId: id, files, convexUrl, getToken: account.getToken, isCurrent,
          attachmentIds: () => liveAttachments(latest.current.items[id]?.attachments).map(attachment => attachment.id),
          onUploaded: input => taskStore.addAttachment(id, input),
          onProgress: (current, total) => setStatus(previous => ({ ...base, errors: previous?.errors ?? [], message: `アップロード中（${current}/${total}）` })),
          onErrors: errors => setStatus(previous => ({ ...base, message: previous?.message ?? base.message, errors })),
        });
        if (isCurrent()) setStatus({ ...base, busy: false, message: `${result.uploaded}件添付しました`, errors: result.errors });
        else if (batchRef.current === batch) setStatus(null);
      } finally {
        if (batchRef.current === batch) batchRef.current = null;
      }
      return;
    }
    let added = 0;
    const errors: string[] = [];
    for (const url of urls) {
      const existing = liveAttachments(latest.current.items[id]?.attachments);
      if (existing.some(attachment => {
        if (attachment.kind !== 'link' || !attachment.url) return false;
        try { return new URL(attachment.url).href === url; } catch { return false; }
      })) continue;
      if (existing.length >= MAX_ATTACHMENTS) { errors.push(`コンテキストは合計${MAX_ATTACHMENTS}件までです。`); break; }
      if (taskStore.addAttachment(id, { url })) added++;
      else { errors.push('リンクを保存できませんでした。保存領域と添付上限を確認してください。'); break; }
      // A link drop is synchronous; the React subscription may not have rendered yet.
      latest.current.items = taskStore.getState().items;
    }
    setStatus({ taskId: id, name, busy: false, message: added ? `${added}件添付しました` : errors.length ? '' : '添付済みのリンクです', errors });
  };

  const handlers = (id: string): TaskDropHandlers => {
    const accepts = (event: DragEvent<HTMLElement>) => !internalText.current && hasContextDrop(event.dataTransfer.types);
    const hover = (event: DragEvent<HTMLElement>) => {
      if (!accepts(event)) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = batchRef.current ? 'none' : 'copy';
      if (!batchRef.current) setTargetId(id);
    };
    return {
      onDragEnter: hover, onDragOver: hover,
      onDragLeave: event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setTargetId(previous => previous === id ? null : previous);
      },
      onDrop: event => {
        if (!accepts(event)) return;
        event.preventDefault(); event.stopPropagation(); setTargetId(null);
        void attach(id, event.dataTransfer);
      },
    };
  };
  return <TaskContextDropContext.Provider value={{ targetId, handlers }}>
    {children}
    {status ? <div className="task-drop-status" aria-busy={status.busy}>
      <span className="task-drop-status-icon" aria-hidden>{status.busy ? <LoaderCircle size={16} /> : status.errors.length ? <Paperclip size={16} /> : <Check size={16} />}</span>
      <div className="task-drop-status-body">
        <span className="task-drop-status-task">{status.name}</span>
        <span role="status">{status.message}</span>
        {status.errors.length ? <ul className="context-upload-errors context-error" role="alert">{status.errors.map((error, index) => <li key={index}>{error}</li>)}</ul> : null}
      </div>
      <button type="button" className="icon-btn" onClick={() => setStatus(null)} aria-label="添付の通知を閉じる" title="閉じる"><X size={15} /></button>
    </div> : null}
  </TaskContextDropContext.Provider>;
}
