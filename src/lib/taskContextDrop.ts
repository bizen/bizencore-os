interface DropData {
  types: readonly string[];
  files: ArrayLike<File>;
  getData: (type: string) => string;
}

export function hasContextDrop(types: readonly string[]): boolean {
  return types.some(type => type === 'Files' || type === 'text/uri-list' || type === 'text/plain');
}

function webUrl(value: string): string | null {
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Snapshot at drop time: browser drag data is no longer readable after awaiting auth. */
export function readContextDrop(data: DropData): { files: File[]; urls: string[] } {
  const files = Array.from(data.files);
  if (files.length || data.types.includes('Files')) return { files, urls: [] };
  const uriList = data.getData('text/uri-list');
  const text = uriList || data.getData('text/plain');
  if (text.length > 100000) return { files: [], urls: [] };
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && (!uriList || !line.startsWith('#')));
  const urls = lines.map(webUrl);
  // Do not interpret ordinary dragged prose, HTML or executable URLs as attachments.
  return { files: [], urls: urls.length && urls.every((url): url is string => !!url) ? [...new Set(urls)] : [] };
}
