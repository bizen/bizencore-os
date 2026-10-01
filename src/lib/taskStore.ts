/**
 * ローカル保存（localStorage）を正とするタスクストア。
 * サインインは不要。サインインした場合だけ SyncBridge が Convex と双方向同期する。
 */
import { useSyncExternalStore } from 'react';
import {
  MAX_DEPTH,
  type Item,
  type ItemMap,
  type LabelColor,
  type TaskKind,
  childrenOf,
  depthOf,
  flattenAll,
  isLabelColor,
  isLive,
  needsRebalance,
  newId,
  nextKind,
  nextLabelColor,
  orderBetween,
  subtreeHeight,
  subtreeIds,
} from './taskModel';
import {
  type FieldGroup,
  changedGroups,
  coerceStamps,
  mergeItems,
  restamp,
  sameStampedState,
  withGroups,
} from './itemMerge';
import { MAX_ATTACHMENTS, attachmentFrom, coerceAttachments, liveAttachments } from './attachments';
import { isDateString, isTimeString } from './taskDates';

const STORAGE_KEY = 'chrct.tasks.v2';
const UNDO_LIMIT = 50;
/** これだけ手が止まったら、次の打鍵から新しい取り消し単位にする */
const COALESCE_MS = 600;

export interface TaskState {
  items: ItemMap;
  /** 保存済みのリビジョン。参照等価の判定に使う */
  rev: number;
}

export interface RemoteItem {
  itemId: string;
  updatedAt: number;
  deletedAt?: number;
  payload: string;
}

function coerceItem(raw: unknown): Item | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const type = r.type === 'section' ? 'section' : 'task';
  const now = Date.now();
  return {
    id: r.id,
    type,
    parentId: typeof r.parentId === 'string' ? r.parentId : null,
    order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0,
    text: typeof r.text === 'string' ? r.text : '',
    note: typeof r.note === 'string' && r.note ? r.note : undefined,
    completionCriteria: typeof r.completionCriteria === 'string' && r.completionCriteria ? r.completionCriteria : undefined,
    done: r.done === true,
    createdBy: r.createdBy === 'user' || r.createdBy === 'ai' ? r.createdBy : undefined,
    createdByClient: r.createdBy === 'ai' && typeof r.createdByClient === 'string' ? r.createdByClient : undefined,
    completedBy: r.done === true && (r.completedBy === 'user' || r.completedBy === 'ai') ? r.completedBy : undefined,
    completedByClient: r.done === true && r.completedBy === 'ai' && typeof r.completedByClient === 'string' ? r.completedByClient : undefined,
    filed: r.filed === true ? true : undefined,
    kind: r.kind === 'main' || r.kind === 'tanomi' ? r.kind : undefined,
    color: isLabelColor(r.color) ? r.color : undefined,
    estimate:
      typeof r.estimate === 'number' && Number.isFinite(r.estimate) && r.estimate > 0
        ? Math.round(r.estimate)
        : undefined,
    assignedDate: typeof r.assignedDate === 'string' ? r.assignedDate : undefined,
    dueDate: typeof r.dueDate === 'string' && isDateString(r.dueDate) ? r.dueDate : undefined,
    dueTime: typeof r.dueDate === 'string' && isDateString(r.dueDate) && typeof r.dueTime === 'string' && isTimeString(r.dueTime) ? r.dueTime : undefined,
    attachments: coerceAttachments(r.attachments),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
    deletedAt: typeof r.deletedAt === 'number' ? r.deletedAt : undefined,
    stamps: coerceStamps(r.stamps),
  };
}

function loadItems(): ItemMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return {};
    const items: ItemMap = {};
    for (const entry of parsed) {
      const item = coerceItem(entry);
      if (item) items[item.id] = item;
    }
    return items;
  } catch {
    return {};
  }
}

const PERSIST_DELAY_MS = 180;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: ItemMap | null = null;

function writeNow(items: ItemMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.values(items)));
  } catch {
    // 容量超過などは無視（メモリ上の状態は生きている）
  }
}

/** 1文字ごとの書き込みでカクつかないよう、保存だけ少し遅らせる */
function persist(items: ItemMap) {
  pendingPersist = items;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = pendingPersist;
    pendingPersist = null;
    if (snapshot) writeNow(snapshot);
  }, PERSIST_DELAY_MS);
}

export function flushPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const snapshot = pendingPersist;
  pendingPersist = null;
  if (snapshot) writeNow(snapshot);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
}

let state: TaskState = { items: loadItems(), rev: 0 };
const listeners = new Set<() => void>();
const undoStack: ItemMap[] = [];
/** 直前にまとめた編集。打ち続けている間は履歴を増やさない */
let lastCoalesced: { key: string; at: number } | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function commit(
  nextItems: ItemMap,
  options?: { undoable?: boolean; previous?: ItemMap; coalesceKey?: string }
) {
  let undoable = options?.undoable !== false;

  if (undoable && options?.coalesceKey) {
    // 同じ行を打ち続けている間はひとまとめ。手が止まったら次の区切りにする
    const now = Date.now();
    const key = options.coalesceKey;
    if (lastCoalesced?.key === key && now - lastCoalesced.at < COALESCE_MS) undoable = false;
    lastCoalesced = { key, at: now };
  } else {
    lastCoalesced = null;
  }

  if (undoable) {
    undoStack.push(options?.previous ?? state.items);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  state = { items: nextItems, rev: state.rev + 1 };
  persist(nextItems);
  emit();
}

/**
 * 変更の時刻。
 *
 * Date.now() をそのまま使うと、同じミリ秒に2回変更したときに updatedAt が
 * 並び、同期先が後の変更を「古い」と見なして弾いてしまう。必ず1つ進める。
 *
 * また、これまでに見たどの時刻よりも後にする。この端末の時計が遅れていても、
 * 他の端末や AI の変更を見てから書いた編集が「古い」と負けないように。
 */
let lastStamp = Object.values(state.items).reduce((max, item) => Math.max(max, item.updatedAt), 0);

function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

function observeStamp(stamp: number) {
  if (stamp > lastStamp) lastStamp = stamp;
}

/** updatedAt を除いた中身が同じか */
function sameContent(a: Item, b: Item): boolean {
  return (
    a.type === b.type &&
    a.parentId === b.parentId &&
    a.order === b.order &&
    a.text === b.text &&
    a.note === b.note &&
    a.completionCriteria === b.completionCriteria &&
    a.done === b.done &&
    a.createdBy === b.createdBy &&
    a.createdByClient === b.createdByClient &&
    a.completedBy === b.completedBy &&
    a.completedByClient === b.completedByClient &&
    a.filed === b.filed &&
    a.kind === b.kind &&
    a.color === b.color &&
    a.estimate === b.estimate &&
    a.assignedDate === b.assignedDate &&
    a.dueDate === b.dueDate &&
    a.dueTime === b.dueTime &&
    JSON.stringify(a.attachments ?? null) === JSON.stringify(b.attachments ?? null) &&
    a.createdAt === b.createdAt &&
    a.deletedAt === b.deletedAt
  );
}

/** 変更対象に updatedAt を打ちながら新しい items を作る */
function withPatches(patches: Item[], base: ItemMap = state.items): ItemMap {
  const now = nextStamp();
  const next: ItemMap = { ...base };
  for (const patch of patches) {
    next[patch.id] = restamp(base[patch.id], patch, now);
  }
  return next;
}

function siblings(items: ItemMap, parentId: string | null): Item[] {
  return childrenOf(items, parentId);
}

/** 兄弟の order が詰まりすぎたら 0,1,2... に振り直す */
function rebalanceIfNeeded(items: ItemMap, parentId: string | null): Item[] {
  const list = siblings(items, parentId);
  let tight = false;
  for (let i = 1; i < list.length; i++) {
    if (needsRebalance(list[i - 1].order, list[i].order)) {
      tight = true;
      break;
    }
  }
  if (!tight) return [];
  return list.map((item, index) => ({ ...item, order: index }));
}

/** 振り直しが要るなら適用済みのマップを返す。挿入位置の計算はこの結果に対して行う */
function withRebalanced(
  items: ItemMap,
  parentId: string | null
): { items: ItemMap; patches: Item[] } {
  const patches = rebalanceIfNeeded(items, parentId);
  if (patches.length === 0) return { items, patches };
  const next: ItemMap = { ...items };
  for (const patch of patches) next[patch.id] = patch;
  return { items: next, patches };
}

function orderForPosition(items: ItemMap, parentId: string | null, index: number): number {
  const list = siblings(items, parentId);
  const prev = index > 0 ? list[index - 1]?.order : undefined;
  const next = list[index]?.order;
  return orderBetween(prev, next);
}

function blankItem(parentId: string | null, order: number, type: 'task' | 'section'): Item {
  const now = Date.now();
  return {
    id: newId(),
    type,
    parentId,
    order,
    text: '',
    done: false,
    createdBy: 'user',
    createdAt: now,
    updatedAt: now,
  };
}

export const taskStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getState(): TaskState {
    return state;
  },

  canUndo(): boolean {
    return undoStack.length > 0;
  },

  /**
   * ひとつ前の状態に戻す。
   *
   * 単に古いスナップショットを入れ直すと updatedAt まで巻き戻り、同期先が
   * 「自分のほうが新しい」と押し返して取り消しが無かったことになる。
   * そこで、戻した項目には「いま」の時刻を打ち直す。
   * 取り消しで無かったことになる項目は、消した印を付けて同期にも伝える。
   */
  undo(): void {
    const previous = undoStack.pop();
    if (!previous) return;
    lastCoalesced = null;

    const now = nextStamp();
    const next: ItemMap = {};

    for (const item of Object.values(previous)) {
      const current = state.items[item.id];
      next[item.id] =
        current && sameContent(current, item) ? current : restamp(current, item, now);
    }
    for (const item of Object.values(state.items)) {
      if (next[item.id]) continue;
      next[item.id] = restamp(item, { ...item, deletedAt: now }, now);
    }

    state = { items: next, rev: state.rev + 1 };
    persist(next);
    emit();
  },

  /**
   * 指定アイテムの直後に新しい行を作る。
   * 子を持つ行の直後なら最初の子として、そうでなければ同じ階層の次に入る。
   */
  insertAfter(
    anchorId: string | null,
    options?: { type?: 'task' | 'section'; asChild?: boolean; assignedDate?: string }
  ): string {
    const type = options?.type ?? 'task';
    const items = state.items;

    let parentId: string | null = null;
    let index = siblings(items, null).length;

    const anchor = anchorId ? items[anchorId] : undefined;
    if (isLive(anchor)) {
      if (type === 'section') {
        // ラベルは常にルート直下。アンカーの属するルート系列の次に置く
        const rootId = rootAncestorId(items, anchor.id);
        const rootList = siblings(items, null);
        index = rootList.findIndex((i) => i.id === rootId) + 1;
      } else if (options?.asChild || siblings(items, anchor.id).length > 0) {
        parentId = anchor.id;
        index = 0;
      } else {
        parentId = anchor.parentId;
        const list = siblings(items, parentId);
        index = list.findIndex((i) => i.id === anchor.id) + 1;
      }
    }

    if (type === 'task' && parentId && depthOf(items, parentId) + 1 > MAX_DEPTH) {
      parentId = items[parentId]?.parentId ?? null;
      index = siblings(items, parentId).length;
    }

    const balanced = withRebalanced(items, parentId);
    const item = blankItem(parentId, orderForPosition(balanced.items, parentId, index), type);
    if (type === 'task' && options?.assignedDate) item.assignedDate = options.assignedDate;

    commit(withPatches([...balanced.patches, item]));
    return item.id;
  },

  addSection(): string {
    return taskStore.insertAfter(null, { type: 'section' });
  },

  update(id: string, patch: Partial<Omit<Item, 'id' | 'createdAt'>>, undoable = true): void {
    const current = state.items[id];
    if (!isLive(current)) return;
    const merged: Item = { ...current, ...patch };
    commit(withPatches([merged]), { undoable });
  },

  setText(id: string, text: string): void {
    const current = state.items[id];
    if (!isLive(current) || current.text === text) return;
    commit(withPatches([{ ...current, text }]), { coalesceKey: `text:${id}` });
  },

  setNote(id: string, note: string): void {
    const current = state.items[id];
    if (!isLive(current)) return;
    const trimmed = note.trim() ? note : undefined;
    if (current.note === trimmed) return;
    commit(withPatches([{ ...current, note: trimmed }]), { coalesceKey: `note:${id}` });
  },

  setCompletionCriteria(id: string, value: string): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task') return;
    const completionCriteria = value.trim() ? value : undefined;
    if (current.completionCriteria === completionCriteria) return;
    commit(withPatches([{ ...current, completionCriteria }]), { coalesceKey: `criteria:${id}` });
  },

  setDeadline(id: string, dueDate: string | undefined, dueTime: string | undefined): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task') return;
    if (dueDate && !isDateString(dueDate)) return;
    if (dueTime && !isTimeString(dueTime)) return;
    const time = dueDate ? dueTime : undefined;
    if (current.dueDate === dueDate && current.dueTime === time) return;
    commit(withPatches([{ ...current, dueDate, dueTime: time }]));
  },

  toggleDone(id: string): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task') return;
    const done = !current.done;
    const patches = subtreeIds(state.items, id)
      .map((childId) => state.items[childId])
      .filter(isLive)
      .filter((item) => item.type === 'task' && (item.done !== done || (!done && item.filed)))
      // 完了を取り消したら棚から出す
      .map((item) => ({ ...item, done, filed: done ? item.filed : undefined,
        completedBy: done ? 'user' as const : undefined, completedByClient: undefined }));
    if (patches.length === 0) return;
    commit(withPatches(patches));
  },

  /**
   * 完了したタスクを、完了済みの棚へ送る。
   * 親が未完了のサブタスクも送る。棚では親の名前を添えて出し、
   * 完了を取り消せば元の親のところに戻る。
   */
  fileCompleted(): void {
    const items = state.items;
    const patches = Object.values(items)
      .filter(isLive)
      .filter((item) => item.type === 'task' && item.done && !item.filed)
      .map((item) => ({ ...item, filed: true }));
    if (patches.length === 0) return;
    commit(withPatches(patches));
  },

  toggleToday(id: string, todayDate: string): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task') return;
    const assignedDate = current.assignedDate === todayDate ? undefined : todayDate;
    commit(withPatches([{ ...current, assignedDate }]));
  },

  /**
   * コンテキストを添える。URL だけならリンク、それ以外は文章として添える。
   * 添えられたら true。空や上限超えなら何もしない。
   */
  addAttachment(id: string, input: { id?: string; url?: string; text?: string; title?: string; storageId?: string; mimeType?: string; size?: number }): boolean {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task') return false;
    if (liveAttachments(current.attachments).length >= MAX_ATTACHMENTS) return false;
    if (input.id && current.attachments?.some((att) => att.id === input.id)) return true;
    const attachment = attachmentFrom(input, 'human', input.id ?? newId(), Date.now());
    if (!attachment) return false;
    commit(withPatches([{ ...current, attachments: [...(current.attachments ?? []), attachment] }]));
    return true;
  },

  /** 添えたコンテキストを外す。同期で伝わるよう、消さずに外した印を付ける */
  removeAttachment(id: string, attachmentId: string): void {
    const current = state.items[id];
    if (!isLive(current) || !current.attachments) return;
    const now = Date.now();
    const attachments = current.attachments.map((att) =>
      att.id === attachmentId && att.deletedAt === undefined ? { ...att, deletedAt: now } : att
    );
    commit(withPatches([{ ...current, attachments }]));
  },

  setEstimate(id: string, estimate: number | undefined): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'task' || current.estimate === estimate) return;
    commit(withPatches([{ ...current, estimate }]));
  },

  /** タスクならクエスト種別、ラベルなら色を順に切り替える */
  cycleKind(id: string): void {
    const current = state.items[id];
    if (!isLive(current)) return;
    if (current.type === 'section') {
      commit(withPatches([{ ...current, color: nextLabelColor(current.color) }]));
      return;
    }
    commit(withPatches([{ ...current, kind: nextKind(current.kind) }]));
  },

  setLabelColor(id: string, color: LabelColor | undefined): void {
    const current = state.items[id];
    if (!isLive(current) || current.type !== 'section' || current.color === color) return;
    commit(withPatches([{ ...current, color }]));
  },

  setKind(id: string, kind: TaskKind | undefined): void {
    const current = state.items[id];
    if (!isLive(current)) return;
    commit(withPatches([{ ...current, kind }]));
  },

  remove(id: string): void {
    const current = state.items[id];
    if (!isLive(current)) return;
    const now = Date.now();
    const patches = subtreeIds(state.items, id)
      .map((childId) => state.items[childId])
      .filter(isLive)
      .map((item) => ({ ...item, deletedAt: now }));
    commit(withPatches(patches));
  },

  /** 完了したタスクを削除する */
  /**
   * 何も書かれていない行を片づける。
   * 打ち始められる行がなくならないよう、最後の1行だけは残す。
   * 取り消し履歴には積まない（ユーザーの編集を押し流さないため）。
   */
  removeEmpty(id: string): boolean {
    const items = state.items;
    const current = items[id];
    if (!isLive(current)) return false;
    if (current.text.trim() || current.note?.trim() || current.completionCriteria?.trim() || current.dueDate) return false;
    if (childrenOf(items, id).length > 0) return false;
    if (flattenAll(items).length <= 1) return false;

    commit(withPatches([{ ...current, deletedAt: Date.now() }]), { undoable: false });
    return true;
  },

  /**
   * 完了したタスクを削除する。
   * 消すのは完了しているものだけ。未完了のまま残る子は、宙に浮かないよう
   * ルートの末尾へ引き取る。
   */
  clearCompleted(): void {
    const items = state.items;
    const now = Date.now();

    const doomed = new Set(
      Object.values(items)
        .filter(isLive)
        .filter((item) => item.type === 'task' && item.done)
        .map((item) => item.id)
    );
    if (doomed.size === 0) return;

    const patches: Item[] = [];
    for (const id of doomed) patches.push({ ...items[id], deletedAt: now });

    let nextOrder = childrenOf(items, null).reduce((max, i) => Math.max(max, i.order), -1) + 1;
    for (const item of Object.values(items)) {
      if (!isLive(item) || doomed.has(item.id)) continue;
      if (!item.parentId || !doomed.has(item.parentId)) continue;
      patches.push({ ...item, parentId: null, order: nextOrder++ });
    }

    commit(withPatches(patches));
  },


  /** 1段下げてひとつ上の兄弟の子にする（サブタスク化） */
  indent(id: string): boolean {
    const items = state.items;
    const current = items[id];
    if (!isLive(current) || current.type === 'section') return false;

    const list = siblings(items, current.parentId);
    const index = list.findIndex((i) => i.id === id);
    if (index <= 0) return false;

    const newParent = list[index - 1];
    const newDepth = depthOf(items, newParent.id) + 1;
    if (newDepth + subtreeHeight(items, id) > MAX_DEPTH) return false;

    const balanced = withRebalanced(items, newParent.id);
    const childList = siblings(balanced.items, newParent.id);
    const order = orderBetween(childList[childList.length - 1]?.order, undefined);
    commit(withPatches([...balanced.patches, { ...current, parentId: newParent.id, order }]));
    return true;
  },

  /** 1段上げて親の次の兄弟になる */
  outdent(id: string): boolean {
    const items = state.items;
    const current = items[id];
    if (!isLive(current) || !current.parentId) return false;
    const parent = items[current.parentId];
    if (!isLive(parent)) return false;

    const balanced = withRebalanced(items, parent.parentId);
    const parentSiblings = siblings(balanced.items, parent.parentId);
    const parentIndex = parentSiblings.findIndex((i) => i.id === parent.id);
    const order = orderBetween(
      parentSiblings[parentIndex]?.order,
      parentSiblings[parentIndex + 1]?.order
    );

    commit(withPatches([...balanced.patches, { ...current, parentId: parent.parentId, order }]));
    return true;
  },

  /** 同じ階層の中で上下に動かす（子はついてくる） */
  move(id: string, direction: -1 | 1): boolean {
    const items = state.items;
    const current = items[id];
    if (!isLive(current)) return false;

    const list = siblings(items, current.parentId);
    const index = list.findIndex((i) => i.id === id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= list.length) return false;

    const reordered = [...list];
    reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, current);

    const patches = reordered.map((item, i) => ({ ...item, order: i }));
    commit(withPatches(patches));
    return true;
  },

  /**
   * 同期で受け取った変更をローカルに反映する。欄ごとに新しい方を採る。
   * clean は合わせた結果がリモートと同じになったもの（送り直し不要）、
   * ahead はこちらの方が新しい欄が残ったもの（送り直しが要る）。
   */
  mergeRemote(remoteItems: RemoteItem[]): { applied: number; clean: Item[]; ahead: string[] } {
    let applied = 0;
    const next: ItemMap = { ...state.items };
    const clean: Item[] = [];
    const ahead: string[] = [];
    /** こちらに無かった＝他の端末で作られたもの */
    const arrived: string[] = [];
    /** リモートが勝った欄。取り消し履歴にも写す */
    const won = new Map<string, FieldGroup[]>();

    for (const remote of remoteItems) {
      observeStamp(remote.updatedAt);

      let incoming: Item | null;
      try {
        incoming = coerceItem({
          ...(JSON.parse(remote.payload) as object),
          id: remote.itemId,
          updatedAt: remote.updatedAt,
          deletedAt: remote.deletedAt,
        });
      } catch {
        incoming = null; // 壊れた payload は捨てる
      }
      if (!incoming) continue;
      for (const stamp of Object.values(incoming.stamps ?? {})) observeStamp(stamp);

      const local = next[remote.itemId];
      if (!local) {
        // 消えたものは、こちらに無ければ持ってこない
        if (incoming.deletedAt) continue;
        arrived.push(remote.itemId);
        next[remote.itemId] = incoming;
        clean.push(incoming);
        applied += 1;
        continue;
      }

      const merged = mergeItems(local, incoming);
      if (sameStampedState(merged, incoming)) clean.push(merged);
      else ahead.push(merged.id);
      if (sameStampedState(merged, local)) continue;
      next[remote.itemId] = merged;
      won.set(remote.itemId, changedGroups(local, merged));
      applied += 1;
    }

    if (applied === 0) return { applied: 0, clean, ahead };

    /*
     * 他の端末から届いたものは、こちらの取り消し履歴の外にある。
     * 履歴のどの断面にも置いておかないと、undo が「スナップショットに無い＝
     * 取り消しで無かったことになるもの」と見なして消してしまう。
     */
    for (let i = 0; i < undoStack.length; i++) {
      let snapshot: ItemMap | null = null;
      for (const id of arrived) {
        if (undoStack[i][id] || !next[id]) continue;
        snapshot = snapshot ?? { ...undoStack[i] };
        snapshot[id] = next[id];
      }
      /*
       * 他で変わった欄も同じ。古い断面のまま取り消すと、AI が直した文言などを
       * 巻き戻してしまう。こちらで触っていない欄だけ入れ替えるので、
       * 自分の編集の取り消しはそのまま効く。
       */
      for (const [id, groups] of won) {
        const old = (snapshot ?? undoStack[i])[id];
        if (!old) continue;
        snapshot = snapshot ?? { ...undoStack[i] };
        snapshot[id] = withGroups(old, next[id], groups);
      }
      if (snapshot) undoStack[i] = snapshot;
    }

    commit(next, { undoable: false });
    return { applied, clean, ahead };
  },

  /** ローカルの全アイテム（削除済みも含む。同期用） */
  allItems(): Item[] {
    return Object.values(state.items);
  },

  /** 端末をまたいだ初回同期などで、既存データを丸ごと入れ替える */
  replaceAll(items: Item[]): void {
    const next: ItemMap = {};
    for (const item of items) next[item.id] = item;
    commit(next, { undoable: false });
  },
};

function rootAncestorId(items: ItemMap, id: string): string {
  let current = items[id];
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = items[current.parentId];
    if (!isLive(parent)) break;
    current = parent;
  }
  return current?.id ?? id;
}

export function useTaskState(): TaskState {
  return useSyncExternalStore(taskStore.subscribe, taskStore.getState, taskStore.getState);
}
