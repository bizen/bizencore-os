/**
 * タスクに添えるコンテキスト（リンク、文章、ファイル参照）。
 *
 * 人は詳細パネルから、AI は MCP の attach_context からリンク・文章を足す。
 * MCP の list_tasks と エージェントハンドオフにも載る。
 *
 * 人と AI が同時に足しても片方が消えないよう、同期では1件ずつ ID で合わせて
 * 足し合わせる（src/lib/itemMerge.ts）。外すときは消さずに deletedAt を打つ。
 *
 * DOM にも Convex にも依存させないこと。ブラウザと Convex の両方から読まれる。
 */

export type AttachmentKind = 'link' | 'text' | 'file';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** kind === 'link' のとき */
  url?: string;
  /** kind === 'text' のときの本文 */
  text?: string;
  /** kind === 'file' のとき。実体は Convex Storage に置く */
  storageId?: string;
  mimeType?: string;
  size?: number;
  title?: string;
  /** 誰が添えたか */
  by: 'human' | 'ai';
  createdAt: number;
  /** 外した時刻。同期で「外した」ことを伝えるために残す */
  deletedAt?: number;
}

export const MAX_ATTACHMENT_TEXT = 4000;
export const MAX_ATTACHMENT_TITLE = 200;
/** 1つのタスクに添えられる数（外したものは数えない） */
export const MAX_ATTACHMENTS = 50;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 保存や通信で崩れた形を直す。読めないものは捨てる */
export function coerceAttachments(raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: Attachment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || (r.kind !== 'link' && r.kind !== 'text' && r.kind !== 'file')) continue;
    const att: Attachment = {
      id: r.id,
      kind: r.kind,
      by: r.by === 'ai' ? 'ai' : 'human',
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    };
    if (typeof r.url === 'string') att.url = r.url;
    if (typeof r.text === 'string') att.text = clip(r.text, MAX_ATTACHMENT_TEXT);
    if (typeof r.storageId === 'string') att.storageId = r.storageId;
    if (typeof r.mimeType === 'string') att.mimeType = r.mimeType;
    if (typeof r.size === 'number' && Number.isFinite(r.size)) att.size = r.size;
    if (typeof r.title === 'string' && r.title.trim()) att.title = clip(r.title.trim(), MAX_ATTACHMENT_TITLE);
    if (typeof r.deletedAt === 'number') att.deletedAt = r.deletedAt;
    if (att.kind === 'link' ? !att.url : att.kind === 'text' ? !att.text : !att.storageId || !att.title) continue;
    list.push(att);
  }
  return list.length > 0 ? list : undefined;
}

/**
 * 両側の添付を ID で合わせて足し合わせる。同じ ID で片方が外されていれば外した方を採る。
 * merge(a, b) と merge(b, a) は同じ中身になる。
 */
export function mergeAttachments(a: unknown, b: unknown): Attachment[] | undefined {
  const byId = new Map<string, Attachment>();
  for (const att of [...(coerceAttachments(a) ?? []), ...(coerceAttachments(b) ?? [])]) {
    const seen = byId.get(att.id);
    if (!seen) {
      byId.set(att.id, att);
      continue;
    }
    if (seen.deletedAt !== undefined || att.deletedAt !== undefined) {
      const deletedAt = Math.min(seen.deletedAt ?? Infinity, att.deletedAt ?? Infinity);
      byId.set(att.id, { ...(JSON.stringify(att) > JSON.stringify(seen) ? att : seen), deletedAt });
    } else if (JSON.stringify(att) > JSON.stringify(seen)) {
      byId.set(att.id, att);
    }
  }
  const merged = [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
  return merged.length > 0 ? merged : undefined;
}

/** 外していないものだけ */
export function liveAttachments(list: Attachment[] | undefined): Attachment[] {
  return (list ?? []).filter((att) => att.deletedAt === undefined);
}

/** 一覧に出す名前。リンクはタイトルかホストとパス、文章はタイトルか1行目 */
export function attachmentLabel(att: Attachment): string {
  if (att.title) return att.title;
  if (att.kind === 'link' && att.url) {
    try {
      const u = new URL(att.url);
      return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return att.url;
    }
  }
  return (att.text ?? '').trim().split('\n')[0].slice(0, 80) || '（文章）';
}

/** 貼られた文字列から添付を作る。URL だけならリンク、それ以外は文章 */
export function attachmentFrom(
  input: { url?: string; text?: string; title?: string; storageId?: string; mimeType?: string; size?: number },
  by: 'human' | 'ai',
  id: string,
  now: number
): Attachment | null {
  const title = input.title?.trim() ? clip(input.title.trim(), MAX_ATTACHMENT_TITLE) : undefined;
  if (input.storageId) {
    if (!title || !Number.isFinite(input.size) || !input.size || input.size > MAX_FILE_SIZE) return null;
    return {
      id, kind: 'file', storageId: input.storageId, title, by, createdAt: now,
      mimeType: input.mimeType || undefined, size: input.size,
    };
  }
  const url = input.url?.trim();
  if (url) {
    if (!isUrl(url)) return null;
    return { id, kind: 'link', url, title, by, createdAt: now };
  }
  const text = input.text?.trim();
  if (!text) return null;
  if (isUrl(text)) return { id, kind: 'link', url: text, title, by, createdAt: now };
  return { id, kind: 'text', text: clip(text, MAX_ATTACHMENT_TEXT), title, by, createdAt: now };
}
