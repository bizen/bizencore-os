import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function DocumentMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
    // Do not send private document reads to external image/tracking servers.
    img: ({ alt }) => <span className="context-document-image">{alt || '画像'}</span>,
  }}>{text}</Markdown>;
}
