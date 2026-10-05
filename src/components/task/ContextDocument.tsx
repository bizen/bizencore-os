import { Check, Copy, Download, FileText, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
const DocumentMarkdown = lazy(() => import('./DocumentMarkdown').catch(() => ({
  default: ({ text }: { text: string }) => <p className="context-document-loading">{text}</p>,
})));

export interface ContextDocumentData {
  id: string;
  title: string;
  text: string;
  revision?: number;
}

function downloadDocument(document: ContextDocumentData, extension: 'md' | 'txt') {
  const blob = new Blob([document.text], { type: extension === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  const name = document.title.replace(/[<>:"/\\|?*]/g, '_').split('').filter((character) => character.charCodeAt(0) > 31).join('').replace(/\.(md|txt)$/i, '').slice(0, 120) || 'document';
  link.href = url;
  link.download = `${name}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ContextDocumentViewer({ document, onClose }: { document: ContextDocumentData; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = window.document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return createPortal(
    <dialog ref={dialog} className="context-document-viewer" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="context-document-shell">
        <header className="context-document-header">
          <div className="context-document-heading"><FileText size={18} aria-hidden /><h2 id={titleId}>{document.title}</h2></div>
          <button type="button" className="icon-btn" aria-label="資料を閉じる" title="閉じる" onClick={onClose} autoFocus><X size={18} /></button>
        </header>
        <div className="context-document-toolbar">
          <button type="button" className="icon-btn" aria-label="本文をコピー" title="本文をコピー" onClick={async () => {
            try { await navigator.clipboard.writeText(document.text); setCopied(true); setError(''); }
            catch { setCopied(false); setError('コピーできませんでした。ファイルとしてダウンロードできます。'); }
          }}>{copied ? <Check size={17} /> : <Copy size={17} />}</button>
          <button type="button" className="context-download" aria-label="Markdownをダウンロード" title="Markdownをダウンロード" onClick={() => downloadDocument(document, 'md')}><Download size={15} />.md</button>
          <button type="button" className="context-download" aria-label="テキストをダウンロード" title="テキストをダウンロード" onClick={() => downloadDocument(document, 'txt')}><Download size={15} />.txt</button>
          <span role="status" className="context-document-status">{error || (copied ? 'コピーしました' : '')}</span>
        </div>
        <article className="context-document-content" tabIndex={0} aria-label="資料の本文">
          <Suspense fallback={<p className="context-document-loading">{document.text}</p>}><DocumentMarkdown text={document.text} /></Suspense>
        </article>
      </div>
    </dialog>, window.document.body,
  );
}

export function ContextDocument({ document }: { document: ContextDocumentData }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="context-document-preview" aria-label={`${document.title}の全文を開く`} onClick={() => setOpen(true)}>
      <span className="context-title">{document.title}</span>
      <span className="context-text">{document.text}</span>
    </button>
    {open ? <ContextDocumentViewer document={document} onClose={() => setOpen(false)} /> : null}
  </>;
}
