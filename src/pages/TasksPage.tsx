import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { TaskInspector } from '../components/task/TaskInspector';
import { TaskRow } from '../components/task/TaskRow';
import { focusFirstMeta } from '../lib/metaCursor';
import { FOCUS_SHORTCUT_CODES, FOOTER_SHORTCUTS, focusShortcut } from '../lib/shortcuts';
import { formatEstimate } from '../lib/taskEstimate';
import { dateInTimeZone, localDateString, timeInTimeZone } from '../lib/taskDates';
import { useUserTimeZone } from '../lib/userTimeZone';
import {
  type Item,
  type ItemMap,
  type LabelColor,
  type Row,
  LABEL_COLORS,
  flattenAll,
  flattenToday,
  isLive,
  rowsForLabel,
} from '../lib/taskModel';
import { taskStore, useTaskState } from '../lib/taskStore';

type ViewMode = 'all' | 'today' | 'board' | `label:${string}`;

interface BoardColumn {
  key: string;
  /** その列のラベル。ラベルの下にないタスクの列は null */
  label: Row | null;
  rows: Row[];
}

/**
 * board 表示の列に分ける。ルート直下の祖先がラベルならその列、そうでなければ
 * 「ラベルなし」の列へ。並びはリストの順のままなので、↑↓ や並べ替えはそのまま効く。
 */
function toBoardColumns(rows: Row[]): BoardColumn[] {
  const unlabeled: BoardColumn = { key: 'unlabeled', label: null, rows: [] };
  const columns: BoardColumn[] = [];
  let current = unlabeled;
  for (const row of rows) {
    if (row.depth === 0) {
      if (row.item.type === 'section') {
        current = { key: row.item.id, label: row, rows: [] };
        columns.push(current);
        continue;
      }
      current = unlabeled;
    }
    // ラベルの直下のタスクが列の左端にそろうよう、1段浅くする
    current.rows.push(current.label ? { ...row, depth: row.depth - 1 } : row);
  }
  return unlabeled.rows.length > 0 ? [unlabeled, ...columns] : columns;
}

/** 完了の演出が終わるまでの時間。CSS のアニメーションと合わせている */
const BURST_MS = 620;
/** 子タスクを点けていくときのずらし幅。増えすぎないよう頭打ちにする */
const BURST_STAGGER_MS = 50;
const BURST_STAGGER_MAX = 6;
const EMPTY_BURST: ReadonlyMap<string, number> = new Map();

/** 完了済みの棚を畳んでいたかどうかを覚えておく */
const SHELF_OPEN_KEY = 'chrct.tasks.completedOpen';

function loadShelfOpen(): boolean {
  try {
    // 何も入っていなければ開いた状態を既定にする
    return localStorage.getItem(SHELF_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
const VIEW_KEY = 'chrct.tasks.view';
const FOCUSED_LABELS_KEY = 'chrct.tasks.focusedLabels';

function labelView(id: string): ViewMode {
  return `label:${id}`;
}

function loadFocusedLabels(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(FOCUSED_LABELS_KEY) ?? '[]') as unknown;
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
  } catch {
    return [];
  }
}

/** 最後に見ていた表示を開き直しても保つ */
function loadView(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === 'today' || saved === 'board' || (saved?.startsWith('label:') && saved.length > 6)
      ? saved as ViewMode
      : 'all';
  } catch {
    return 'all';
  }
}

type Caret = number | 'start' | 'end';
type FocusTarget = 'title' | 'note';
type PendingFocus = { id: string; target: FocusTarget; caret: Caret; misses: number };

/** 日付が変わったら today 表示も追従させる */
function useTodayClock(timeZone: string | null): { todayDate: string; todayTime: string } {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const localTime = new Date(now);
  return {
    todayDate: timeZone ? dateInTimeZone(timeZone, now) : localDateString(now),
    todayTime: timeZone ? timeInTimeZone(timeZone, now) : `${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}`,
  };
}

/**
 * 「完了を整理」で棚へ送った行を、リストから切り分ける。
 *
 * 完了しただけの行はその場に残る。棚へ移るのは filed が立ったものとその部分木。
 * 親が未完了のまま整理したサブタスクは単独で棚へ移り、親の名前を添える。
 * いま完了の演出が出ている行は、演出が終わるまで元の場所に置いたままにする。
 */
function partitionCompleted(
  rows: Row[],
  items: ItemMap,
  bursting: ReadonlyMap<string, number>
): { active: Row[]; done: Row[] } {
  const active: Row[] = [];
  const done: Row[] = [];
  let baseDepth: number | null = null;

  for (const row of rows) {
    if (baseDepth !== null && row.depth > baseDepth) {
      done.push({ item: row.item, depth: row.depth - baseDepth });
      continue;
    }
    baseDepth = null;

    const { item } = row;
    const filed = item.type === 'task' && item.done && item.filed === true && !bursting.has(item.id);

    if (filed) {
      baseDepth = row.depth;
      done.push({ item, depth: 0, context: parentPath(item, items) });
    } else {
      active.push(row);
    }
  }

  return { active, done };
}

/** 親のタスクを上へたどった名前（ラベルやルートで止まる）。親がタスクでなければ undefined */
function parentPath(item: Item, items: ItemMap): string | undefined {
  const names: string[] = [];
  let parent = item.parentId ? items[item.parentId] : undefined;
  while (parent && parent.type === 'task') {
    names.unshift(parent.text.trim() || '（無題）');
    parent = parent.parentId ? items[parent.parentId] : undefined;
  }
  return names.length > 0 ? names.join(' › ') : undefined;
}

/** 検索語に当たった行と、その祖先だけを残す */
function filterRows(rows: Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;

  const kept: Row[] = [];
  const ancestors: Row[] = [];
  const emitted = new Set<string>();

  for (const row of rows) {
    ancestors.length = row.depth;
    ancestors[row.depth] = row;

    if (!matchesQuery(row.item, needle)) continue;
    for (let d = 0; d <= row.depth; d++) {
      const ancestor = ancestors[d];
      if (!ancestor || emitted.has(ancestor.item.id)) continue;
      emitted.add(ancestor.item.id);
      kept.push(ancestor);
    }
  }

  return kept;
}

function matchesQuery(item: Item, needle: string): boolean {
  return item.text.toLowerCase().includes(needle) ||
    (item.note ?? '').toLowerCase().includes(needle);
}

export function TasksPage() {
  const { items } = useTaskState();
  const timeZone = useUserTimeZone();
  const { todayDate, todayTime } = useTodayClock(timeZone);

  const [selectedView, setView] = useState<ViewMode>(loadView);
  const [focusedLabelIds, setFocusedLabelIds] = useState(loadFocusedLabels);
  const selectedLabelId = selectedView.startsWith('label:') ? selectedView.slice(6) : null;
  const selectedLabel = selectedLabelId ? items[selectedLabelId] : undefined;
  const view: ViewMode = selectedLabelId && (
    !focusedLabelIds.includes(selectedLabelId) || !isLive(selectedLabel) || selectedLabel.type !== 'section'
  ) ? 'all' : selectedView;
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const [deadlineOpenId, setDeadlineOpenId] = useState<string | null>(null);
  const [colorOpenId, setColorOpenId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 詳細パネルで開いているタスク */
  const [inspector, setInspector] = useState<{ id: string; focus: 'title' | 'estimate' } | null>(null);
  const [completedOpen, setCompletedOpen] = useState(loadShelfOpen);
  /** 完了した瞬間だけ演出を出す行。値は上から数えた順番（点灯のずらし用） */
  const [burstOrder, setBurstOrder] = useState<ReadonlyMap<string, number>>(EMPTY_BURST);

  const titleRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchPanelRef = useRef<HTMLDivElement | null>(null);
  const viewSwitchRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  const allRows = useMemo(() => flattenAll(items), [items]);
  const todayRows = useMemo(() => flattenToday(items, todayDate), [items, todayDate]);
  const focusedLabelId = view.startsWith('label:') ? view.slice(6) : null;
  const focusedLabels = useMemo(
    () => focusedLabelIds.map((id) => items[id]).filter((item): item is Item => isLive(item) && item.type === 'section'),
    [focusedLabelIds, items]
  );
  const focusRows = useMemo(
    () => focusedLabelId ? rowsForLabel(allRows, focusedLabelId) : [],
    [allRows, focusedLabelId]
  );
  const { activeRows, doneRows } = useMemo(() => {
    const source = view === 'today' ? todayRows : focusedLabelId ? focusRows : allRows;
    const split = partitionCompleted(source, items, burstOrder);
    return {
      activeRows: filterRows(split.active, query),
      doneRows: filterRows(split.done, query),
    };
  }, [view, focusedLabelId, focusRows, todayRows, allRows, items, burstOrder, query]);

  const doneCount = useMemo(
    () => doneRows.filter((row) => row.item.type === 'task').length,
    [doneRows]
  );

  const boardColumns = useMemo(
    () => (view === 'board' ? toBoardColumns(activeRows) : []),
    [view, activeRows]
  );

  const indexLabels = useMemo(
    () => view === 'all'
      ? activeRows.filter((row) => row.depth === 0 && row.item.type === 'section')
      : [],
    [activeRows, view]
  );
  const [currentLabelId, setCurrentLabelId] = useState<string | null>(null);

  useEffect(() => {
    if (indexLabels.length === 0) return;
    const update = () => {
      const threshold = window.innerWidth <= 860 ? 150 : 112;
      let current = indexLabels[0].item.id;
      for (const row of indexLabels) {
        const anchor = document.getElementById(`label-${row.item.id}`);
        if (!anchor || anchor.getBoundingClientRect().top > threshold) break;
        current = row.item.id;
      }
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        current = indexLabels[indexLabels.length - 1].item.id;
      }
      setCurrentLabelId(current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [indexLabels]);

  useEffect(() => {
    try {
      localStorage.setItem(SHELF_OPEN_KEY, completedOpen ? '1' : '0');
    } catch {
      // 保存できなくても表示には困らない
    }
  }, [completedOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, selectedView);
    } catch {
      // 保存できなくても表示には困らない
    }
  }, [selectedView]);

  useEffect(() => {
    try {
      localStorage.setItem(FOCUSED_LABELS_KEY, JSON.stringify(focusedLabelIds));
    } catch {
      // 保存できなくても表示には困らない
    }
  }, [focusedLabelIds]);

  useEffect(() => {
    const nav = viewSwitchRef.current;
    const active = nav?.querySelector<HTMLElement>('.view-switch-btn.active');
    if (!nav || !active) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.right > navRect.right) nav.scrollLeft += activeRect.right - navRect.right + 4;
    else if (activeRect.left < navRect.left) nav.scrollLeft += activeRect.left - navRect.left - 4;
  }, [view, focusedLabels]);

  /** 検索中は、当たったものが隠れないよう棚を開けておく（この状態は覚えない） */
  const shelfOpen = completedOpen || (query.trim() !== '' && doneRows.length > 0);

  /** ↑↓ で行き来できる範囲。棚を開いているときはそこも含める */
  const rows = useMemo(
    () => (shelfOpen ? [...activeRows, ...doneRows] : activeRows),
    [shelfOpen, activeRows, doneRows]
  );
  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => matchesQuery(row.item, needle)) : [];
  }, [query, rows]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    searchButtonRef.current?.focus();
  };

  const chooseSearchResult = (row: Row) => {
    if (doneRows.some((doneRow) => doneRow.item.id === row.item.id)) setCompletedOpen(true);
    setSearchOpen(false);
    setQuery('');
    pendingFocus.current = { id: row.item.id, target: 'title', caret: 'end', misses: 0 };
  };

  const todayNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    todayRows
      .filter((row) => row.depth === 0)
      .forEach((row, index) => numbers.set(row.item.id, index + 1));
    return numbers;
  }, [todayRows]);

  const todayCleared = useMemo(
    () =>
      todayRows.length > 0 &&
      todayRows.every((row) => row.item.type !== 'task' || row.item.done),
    [todayRows]
  );

  const stats = useMemo(() => {
    let remaining = 0;
    let remainingMinutes = 0;
    let completed = 0;
    let fileable = 0;
    for (const row of allRows) {
      const { item } = row;
      if (item.type !== 'task') continue;
      if (!item.done) continue;
      completed += 1;
      if (!item.filed) fileable += 1;
    }
    // 残りと合計時間は、いま見ている表示の分だけ数える（today なら today の合計）
    for (const row of view === 'today' ? todayRows : focusedLabelId ? focusRows : allRows) {
      const { item } = row;
      if (item.type !== 'task' || item.done) continue;
      remaining += 1;
      remainingMinutes += item.estimate ?? 0;
    }
    return { remaining, remainingMinutes, completed, fileable };
  }, [allRows, todayRows, focusRows, focusedLabelId, view]);

  const applyFocus = useCallback((pending: PendingFocus): boolean => {
    const map = pending.target === 'note' ? noteRefs.current : titleRefs.current;
    const el = map.get(pending.id);
    if (!el) return false;
    el.focus();
    const position =
      pending.caret === 'start'
        ? 0
        : pending.caret === 'end'
          ? el.value.length
          : Math.min(pending.caret, el.value.length);
    el.setSelectionRange(position, position);
    return true;
  }, []);

  /**
   * その行へフォーカスを移す。
   * まだ DOM に無い行（今作ったばかりなど）は次のレンダーまで待つ。
   * activeId は実際に focus が当たったときに onFocusRow が更新する。
   */
  const requestFocus = useCallback(
    (id: string | null | undefined, target: FocusTarget = 'title', caret: Caret = 'end') => {
      if (!id) return;
      const pending: PendingFocus = { id, target, caret, misses: 0 };
      pendingFocus.current = applyFocus(pending) ? null : pending;
    },
    [applyFocus]
  );

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (applyFocus(pending)) {
      pendingFocus.current = null;
      return;
    }
    // 描かれない行を指したままだと、あとで思わぬところへフォーカスが飛ぶ
    pending.misses += 1;
    if (pending.misses > 1) pendingFocus.current = null;
  });

  // 空っぽのときは最初の1行を用意して、すぐ打ち始められるようにする
  const seeded = useRef(false);
  useEffect(() => {
    if (allRows.length > 0) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return; // StrictMode の二重実行で空行が増えないように
    seeded.current = true;
    requestFocus(taskStore.insertAfter(null));
  }, [allRows.length, requestFocus]);

  const rowIndexOf = useCallback(
    (id: string) => rows.findIndex((row) => row.item.id === id),
    [rows]
  );

  const moveFocus = useCallback(
    (fromId: string, direction: -1 | 1, caret: Caret = 'end') => {
      const index = rowIndexOf(fromId);
      const target = rows[index + direction];
      if (!target) return false;
      requestFocus(target.item.id, 'title', caret);
      return true;
    },
    [rowIndexOf, rows, requestFocus]
  );

  const removeRow = useCallback(
    (id: string) => {
      const index = rowIndexOf(id);
      const fallback = rows[index - 1]?.item.id ?? rows[index + 1]?.item.id ?? null;
      taskStore.remove(id);
      if (noteOpenId === id) setNoteOpenId(null);
      if (deadlineOpenId === id) setDeadlineOpenId(null);
      if (colorOpenId === id) setColorOpenId(null);
      requestFocus(fallback);
    },
    [rowIndexOf, rows, noteOpenId, deadlineOpenId, colorOpenId, requestFocus]
  );

  /** 開く前にフォーカスがあった場所。閉じたらそこへ返す */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const rememberFocus = useCallback(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const restoreFocus = useCallback(
    (id: string) => {
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back?.isConnected) back.focus();
      else requestFocus(id);
    },
    [requestFocus]
  );

  const handleDeadlineOpenChange = useCallback(
    (id: string, open: boolean) => {
      if (open) {
        rememberFocus();
        setDeadlineOpenId(id);
        return;
      }
      setDeadlineOpenId(null);
      restoreFocus(id);
    },
    [rememberFocus, restoreFocus]
  );

  const handleColorOpenChange = useCallback(
    (id: string, open: boolean) => {
      if (open) {
        rememberFocus();
        setColorOpenId(id);
        return;
      }
      setColorOpenId(null);
      restoreFocus(id);
    },
    [rememberFocus, restoreFocus]
  );

  /**
   * 何も書かずに離れた行は片づける。
   * ただし、同じ行のメタ欄や期限のポップオーバーへ移っただけのときは残す。
   */
  const handleTitleBlur = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        if (active.closest('.color-popover') || active.closest('.deadline-popover')) return;
        if (active.closest<HTMLElement>('.row')?.dataset.rowId === id) return;
      }
      taskStore.removeEmpty(id);
    });
  }, []);

  const setLabelColor = useCallback((id: string, color: LabelColor | undefined) => {
    taskStore.setLabelColor(id, color);
  }, []);

  /**
   * ラベルを足す。today 表示はタスクしか描かないので、作ったものが
   * 見えるように all へ戻してから足す。
   */
  const addLabel = useCallback(
    (anchorId: string | null) => {
      setView('all');
      setDeadlineOpenId(null);
      setColorOpenId(null);
      requestFocus(taskStore.insertAfter(anchorId, { type: 'section' }));
    },
    [requestFocus]
  );

  const setViewMode = useCallback((next: ViewMode) => {
    setView(next);
    setDeadlineOpenId(null);
    setColorOpenId(null);
  }, []);

  const toggleLabelFocus = useCallback((id: string) => {
    if (focusedLabelIds.includes(id)) {
      setFocusedLabelIds((current) => current.filter((focusedId) => focusedId !== id));
      if (view === labelView(id)) setViewMode('all');
    } else {
      setFocusedLabelIds((current) => [...current, id]);
    }
  }, [focusedLabelIds, setViewMode, view]);

  /** board の列の下から、そのラベルにタスクを足す（ラベルなしの列はルートの末尾へ） */
  const addTaskToColumn = useCallback(
    (labelId: string | null) => {
      setDeadlineOpenId(null);
      setColorOpenId(null);
      requestFocus(labelId ? taskStore.insertAfter(labelId, { asChild: true }) : taskStore.insertAfter(null));
    },
    [requestFocus]
  );

  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 完了にしたときだけ、その行に一度きりの演出を出す。戻すときは静かに。
   * 子タスクも一緒に完了するので、上から順にわずかにずらして点ける。
   */
  const toggleDone = useCallback((id: string) => {
    const items = taskStore.getState().items;
    // ラベルは done を持たないので、演出も出さない
    const becomesDone = items[id]?.type === 'task' && items[id]?.done === false;
    taskStore.toggleDone(id);
    if (!becomesDone) return;

    const visual = flattenAll(items);
    const start = visual.findIndex((row) => row.item.id === id);
    const order = new Map<string, number>([[id, 0]]);
    if (start >= 0) {
      const baseDepth = visual[start].depth;
      for (let i = start + 1; i < visual.length && visual[i].depth > baseDepth; i++) {
        const { item } = visual[i];
        if (item.type === 'task' && !item.done) order.set(item.id, order.size);
      }
    }

    if (burstTimer.current) clearTimeout(burstTimer.current);
    setBurstOrder(order);
    burstTimer.current = setTimeout(
      () => setBurstOrder(EMPTY_BURST),
      BURST_MS + Math.min(order.size, BURST_STAGGER_MAX) * BURST_STAGGER_MS
    );
  }, []);

  useEffect(() => () => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
  }, []);

  /** 画面のどこにいても効くショートカット */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;

      if (searchOpen) {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          closeSearch();
        } else if (mod && event.code === 'KeyF') {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
        return;
      }

      if (inspector) {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          setInspector(null);
          requestFocus(inspector.id);
        }
        return;
      }

      if (event.key === 'Escape') {
        if (deadlineOpenId) {
          handleDeadlineOpenChange(deadlineOpenId, false);
          event.preventDefault();
          return;
        }
        if (colorOpenId) {
          handleColorOpenChange(colorOpenId, false);
          event.preventDefault();
          return;
        }
        if (helpOpen) {
          setHelpOpen(false);
          event.preventDefault();
          return;
        }
        return;
      }

      // 完了の片づけ。同じ C で、⇧ を足すと消すほうになる
      // どこにフォーカスが無くても、矢印でリストに戻ってこられるようにする
      if (!mod && !event.altKey && event.key.startsWith('Arrow')) {
        if (helpOpen || document.querySelector('.color-popover')) return;

        const active = document.activeElement;
        if (active instanceof HTMLElement) {
          // 行の中や色の選択中は、そちらの処理に任せる
          if (active.closest('.row')) return;
          if (active === searchRef.current) {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            requestFocus(rows[0]?.item.id);
            return;
          }
        }

        event.preventDefault();
        const index = activeId ? rows.findIndex((row) => row.item.id === activeId) : -1;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const target =
            index >= 0
              ? (rows[index + step] ?? rows[index])
              : (event.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1]);
          requestFocus(target?.item.id);
          return;
        }
        // ← → は、いまいる行に戻るだけ
        requestFocus((index >= 0 ? rows[index] : rows[0])?.item.id);
        return;
      }

      if (event.altKey && event.code === 'KeyC') {
        event.preventDefault();
        if (event.shiftKey) taskStore.clearCompleted();
        else taskStore.fileCompleted();
        return;
      }

      if (event.altKey && event.code === 'Digit1') {
        event.preventDefault();
        setViewMode('all');
        return;
      }
      if (event.altKey && event.code === 'Digit2') {
        event.preventDefault();
        setViewMode('board');
        return;
      }

      if (event.altKey && event.code === 'Digit3') {
        event.preventDefault();
        setViewMode('today');
        return;
      }
      const focusIndex = FOCUS_SHORTCUT_CODES.findIndex((code) => code === event.code);
      if (event.altKey && !mod && !event.shiftKey && !event.isComposing && focusIndex >= 0 && focusedLabels[focusIndex]) {
        event.preventDefault();
        setViewMode(labelView(focusedLabels[focusIndex].id));
        return;
      }
      if (mod && event.code === 'KeyF') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && event.code === 'Slash') {
        event.preventDefault();
        setHelpOpen((open) => !open);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    deadlineOpenId,
    colorOpenId,
    helpOpen,
    searchOpen,
    rows,
    activeId,
    requestFocus,
    handleDeadlineOpenChange,
    handleColorOpenChange,
    setViewMode,
    focusedLabels,
    inspector,
  ]);

  const handleTitleKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    item: Item
  ) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const el = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const caret = el.selectionStart;

    // ---- 行を作る / 分ける ----
    if (event.key === 'Enter' && !event.shiftKey && !mod && !event.altKey) {
      event.preventDefault();
      const created = taskStore.insertAfter(item.id, {
        type: 'task',
        asChild: item.type === 'section',
        assignedDate: view === 'today' ? todayDate : undefined,
      });
      requestFocus(created);
      return;
    }

    if (event.key === 'Enter' && event.shiftKey && !mod) {
      event.preventDefault();
      setNoteOpenId(item.id);
      requestFocus(item.id, 'note');
      return;
    }

    // ---- 詳細パネル ----
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      if (item.type === 'task') setInspector({ id: item.id, focus: 'title' });
      return;
    }

    if (event.key === 'Enter' && mod) {
      event.preventDefault();
      toggleDone(item.id);
      return;
    }

    // ---- 階層 ----
    if (event.key === 'Tab' || (mod && (event.key === 'ArrowRight' || event.key === 'ArrowLeft'))) {
      event.preventDefault();
      const outdent = event.shiftKey || event.key === 'ArrowLeft';
      if (outdent) taskStore.outdent(item.id);
      else taskStore.indent(item.id);
      requestFocus(item.id, 'title', caret);
      return;
    }

    // ---- 並べ替え ----
    if (mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      taskStore.move(item.id, event.key === 'ArrowUp' ? -1 : 1);
      requestFocus(item.id, 'title', caret);
      return;
    }

    // ---- 行末から右へ抜けるとメタ欄（種別 / today / 期限 / 削除）へ ----
    if (event.key === 'ArrowRight' && !mod && !event.altKey && !event.shiftKey) {
      const atEnd = caret === el.value.length && el.selectionEnd === el.value.length;
      if (atEnd && focusFirstMeta(el.closest('.row'))) event.preventDefault();
      return;
    }

    // ---- 行間の移動 ----
    if (event.key === 'ArrowUp') {
      if (moveFocus(item.id, -1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown') {
      if (moveFocus(item.id, 1)) event.preventDefault();
      return;
    }

    // ---- 削除 ----
    if (event.key === 'Backspace') {
      const isEmptyLeaf =
        item.text.length === 0 &&
        !item.note &&
        !allRows.some((r) => r.item.parentId === item.id);
      if (mod || (isEmptyLeaf && caret === 0)) {
        event.preventDefault();
        removeRow(item.id);
      }
      return;
    }

    // ---- 属性（macOS のブラウザに取られない ⌥ 側に寄せている） ----
    if (event.altKey && !mod) {
      if (event.code === 'KeyT' && item.type === 'task') {
        event.preventDefault();
        taskStore.toggleToday(item.id, todayDate);
        return;
      }
      if (event.code === 'KeyE' && item.type === 'task') {
        event.preventDefault();
        setInspector({ id: item.id, focus: 'estimate' });
        return;
      }
      // タスクならクエスト種別、ラベルなら色を順に切り替える
      if (event.code === 'KeyM') {
        event.preventDefault();
        taskStore.cycleKind(item.id);
        return;
      }
      if (event.code === 'KeyS') {
        event.preventDefault();
        addLabel(item.id);
        return;
      }
    }

    if (mod && event.code === 'KeyZ') {
      event.preventDefault();
      taskStore.undo();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      // activeId は残しておく。矢印でここから再開できる
      el.blur();
    }
  };

  const handleNoteKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    item: Item
  ) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const el = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;

    if (event.key === 'Escape' || (event.key === 'Enter' && mod)) {
      event.preventDefault();
      if (!el.value.trim()) setNoteOpenId(null);
      requestFocus(item.id, 'title');
      return;
    }

    if (event.key === 'Backspace' && el.value.length === 0) {
      event.preventDefault();
      setNoteOpenId(null);
      requestFocus(item.id, 'title');
      return;
    }

    if (event.key === 'ArrowUp' && el.selectionStart === 0) {
      event.preventDefault();
      requestFocus(item.id, 'title');
    }
  };

  const registerTitle = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) titleRefs.current.set(id, el);
    else titleRefs.current.delete(id);
  }, []);

  const registerNote = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) noteRefs.current.set(id, el);
    else noteRefs.current.delete(id);
  }, []);

  const renderRow = (row: Row) => (
    <TaskRow
      key={row.item.id}
      item={row.item}
      depth={row.depth}
      context={row.context}
      todayDate={todayDate}
      todayTime={todayTime}
      todayNumber={view === 'today' ? todayNumbers.get(row.item.id) : undefined}
      burstIndex={burstOrder.get(row.item.id)}
      isActive={activeId === row.item.id}
      noteOpen={noteOpenId === row.item.id}
      deadlineOpen={deadlineOpenId === row.item.id}
      colorOpen={colorOpenId === row.item.id}
      isFocusedLabel={focusedLabelIds.includes(row.item.id)}
      registerTitle={registerTitle}
      registerNote={registerNote}
      onKeyDown={handleTitleKeyDown}
      onNoteKeyDown={handleNoteKeyDown}
      onFocusRow={setActiveId}
      onTextChange={taskStore.setText}
      onNoteChange={taskStore.setNote}
      onToggleDone={toggleDone}
      onToggleToday={(id) => taskStore.toggleToday(id, todayDate)}
      onCycleKind={taskStore.cycleKind}
      onSetDeadline={taskStore.setDeadline}
      onDeadlineOpenChange={handleDeadlineOpenChange}
      onColorOpenChange={handleColorOpenChange}
      onRemove={removeRow}
      onTitleBlur={handleTitleBlur}
      onSetLabelColor={setLabelColor}
      onToggleLabelFocus={toggleLabelFocus}
      onInspect={(id) => setInspector({ id, focus: 'title' })}
    />
  );

  const inspected = inspector ? items[inspector.id] : undefined;
  const closeInspector = () => {
    const id = inspector?.id;
    setInspector(null);
    if (id) requestFocus(id);
  };

  return (
    <section className={`page${view === 'board' ? ' page--board' : ''}${indexLabels.length > 0 ? ' page--indexed' : ''}`}>
      <div className="tasks-toolbar">
        <div ref={viewSwitchRef} className="view-switch" role="tablist" aria-label="表示">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'all'}
            className={`view-switch-btn${view === 'all' ? ' active' : ''}`}
            onClick={() => setViewMode('all')}
            title="⌥1"
          >
            all
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'board'}
            className={`view-switch-btn${view === 'board' ? ' active' : ''}`}
            onClick={() => setViewMode('board')}
            title="⌥2"
          >
            board
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'today'}
            className={`view-switch-btn${view === 'today' ? ' active' : ''}`}
            onClick={() => setViewMode('today')}
            title="⌥3"
          >
            today
            <span className="view-switch-count">{todayNumbers.size}</span>
          </button>
          {focusedLabels.map((label, index) => (
            <button
              key={label.id}
              type="button"
              role="tab"
              aria-selected={view === labelView(label.id)}
              aria-label={label.text.trim() || '無題のラベル'}
              aria-keyshortcuts={focusShortcut(index) ? `Alt+${index + 4}` : undefined}
              className={`view-switch-btn view-switch-btn--focus${view === labelView(label.id) ? ' active' : ''}`}
              onClick={() => setViewMode(labelView(label.id))}
              title={`${label.text.trim() || '無題のラベル'}${focusShortcut(index) ? ` (${focusShortcut(index)})` : ''}`}
              style={label.color ? { '--focus-label-color': LABEL_COLORS[label.color] } as CSSProperties : undefined}
            >
              <span className="view-switch-dot" aria-hidden />
              <span className="view-switch-label">{label.text.trim() || '無題のラベル'}</span>
            </button>
          ))}
        </div>

        <button
          ref={searchButtonRef}
          type="button"
          className="ghost-btn tasks-search-btn"
          onClick={() => setSearchOpen(true)}
          title="検索（⌘F）"
          aria-label="検索"
          aria-haspopup="dialog"
        >
          <Search size={16} aria-hidden />
        </button>

        <button
          type="button"
          className="ghost-btn tasks-help-btn"
          onClick={() => setHelpOpen(true)}
          title="⌘/"
          aria-label="ヘルプ"
        >
          ?
        </button>
      </div>
      <div className={`tasks-layout${indexLabels.length > 0 ? ' has-index' : ''}`}>
        {indexLabels.length > 0 ? (
          <nav className="label-index" aria-label="ラベルの目次">
            <ul className="label-index-list">
              {indexLabels.map(({ item }) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`label-index-link${currentLabelId === item.id ? ' is-current' : ''}`}
                    aria-current={currentLabelId === item.id ? 'location' : undefined}
                    title={item.text.trim() || '無題のラベル'}
                    onClick={() => {
                      setCurrentLabelId(item.id);
                      document.getElementById(`label-${item.id}`)?.scrollIntoView({
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                        block: 'start',
                      });
                    }}
                  >
                    <span
                      className="label-index-mark"
                      style={{ backgroundColor: item.color ? LABEL_COLORS[item.color] : undefined }}
                      aria-hidden
                    />
                    <span className="label-index-name">{item.text.trim() || '無題のラベル'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="tasks-content">
      {view === 'board' ? (
        <div className="board" role="list" aria-label="ラベルごとの列">
          {boardColumns.map((column) => (
            <section
              key={column.key}
              className="board-col"
              role="listitem"
              style={column.label?.item.color
                ? { '--board-color': LABEL_COLORS[column.label.item.color] } as CSSProperties
                : undefined}
            >
              <div className="board-col-head">
                {column.label ? (
                  <ul className="row-list">{renderRow(column.label)}</ul>
                ) : (
                  <p className="board-col-title">ラベルなし</p>
                )}
                <span className="board-col-count" title="残っているタスク">
                  {column.rows.filter((row) => row.item.type === 'task' && !row.item.done).length}
                </span>
              </div>
              <ul className="row-list board-col-list">{column.rows.map(renderRow)}</ul>
              <button
                type="button"
                className="board-add"
                onClick={() => addTaskToColumn(column.label?.item.id ?? null)}
              >
                + タスク
              </button>
            </section>
          ))}
        </div>
      ) : (
        <ul className="row-list">{activeRows.map(renderRow)}</ul>
      )}

      {activeRows.length === 0 ? (
        <p className="muted row-list-empty">
          {query
            ? '一致するタスクはありません。'
            : view === 'today'
              ? '⌥T で today に入れると、ここに並びます。'
              : 'Enter で新しい行を作れます。'}
        </p>
      ) : null}

      {view === 'today' && todayCleared ? (
        <p className="today-cleared">today は全部完了</p>
      ) : null}

      <div className="tasks-footer">
        <div className="tasks-footer-top">
          <span className="muted tasks-count">
            <b>{stats.remaining}</b> 残り
            {stats.remainingMinutes > 0 ? (
              <>
                {' · '}
                <b title={view === 'today' ? 'today に残っているタスクの作業想定時間の合計' : '残っているタスクの作業想定時間の合計'}>
                  {formatEstimate(stats.remainingMinutes)}
                </b>
              </>
            ) : null}
          </span>
          <div className="tasks-footer-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => addLabel(activeRows[activeRows.length - 1]?.item.id ?? null)}
            >
              + ラベル（⌥S）
            </button>
            {/* 位置が変わらないよう常に出しておく。整理は何度押しても害がないので、いつでも押せる */}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => taskStore.fileCompleted()}
              title="完了したタスクを完了済みへ移す（⌥C）"
            >
              完了を整理（⌥C）
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => taskStore.clearCompleted()}
              disabled={stats.completed === 0}
              title="完了したタスクを削除（⌥⇧C）"
            >
              完了を削除（⌥⇧C）
            </button>
          </div>
        </div>

        <ul className="tasks-legend" aria-label="キーボードの手引き">
          {FOOTER_SHORTCUTS.map((shortcut) => (
            <li key={`${shortcut.keys}-${shortcut.label}`} className="tasks-legend-item">
              <kbd>{shortcut.keys}</kbd>
              <span>{shortcut.label}</span>
            </li>
          ))}
        </ul>
      </div>

      {doneCount > 0 ? (
        <section className={`done-shelf${shelfOpen ? ' is-open' : ''}`}>
          <div className="done-shelf-head">
            <button
              type="button"
              className="done-shelf-toggle"
              onClick={() => setCompletedOpen((open) => !open)}
              aria-expanded={shelfOpen}
            >
              <ChevronRight size={14} className="done-shelf-caret" aria-hidden />
              <span>完了済み</span>
              <span className="done-shelf-count">{doneCount}</span>
            </button>
          </div>
          {shelfOpen ? (
            <ul className="row-list done-shelf-list">{doneRows.map(renderRow)}</ul>
          ) : null}
        </section>
      ) : null}
        </div>
      </div>

      {helpOpen ? <KeyboardHelp onClose={() => setHelpOpen(false)} /> : null}

      {searchOpen ? (
        <div className="task-search-backdrop" role="dialog" aria-modal="true" aria-label="検索" onClick={closeSearch}>
          <div
            ref={searchPanelRef}
            className="task-search-panel"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const focusable = searchPanelRef.current?.querySelectorAll<HTMLElement>('input, button');
              if (!focusable?.length) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="task-search-field">
              <Search size={18} aria-hidden />
              <input
                ref={searchRef}
                autoFocus
                value={query}
                placeholder="検索"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === 'Enter' && searchResults[0]) {
                    event.preventDefault();
                    chooseSearchResult(searchResults[0]);
                  } else if (event.key === 'ArrowDown' && searchResults.length > 0) {
                    event.preventDefault();
                    searchPanelRef.current?.querySelector<HTMLButtonElement>('.task-search-result')?.focus();
                  }
                }}
                aria-label="タスクを検索"
              />
              <button type="button" className="task-search-close" onClick={closeSearch} aria-label="検索を閉じる" title="閉じる">
                <X size={17} aria-hidden />
              </button>
            </div>
            {query.trim() ? (
              <div className="task-search-matches">
                {searchResults.length > 0 ? (
                  <>
                    <p className="task-search-count">{searchResults.length} 件</p>
                    <ul className="task-search-results">
                      {searchResults.map((row) => (
                        <li key={row.item.id}>
                          <button
                            type="button"
                            className="task-search-result"
                            onClick={() => chooseSearchResult(row)}
                            onKeyDown={(event) => {
                              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                              event.preventDefault();
                              const buttons = Array.from(searchPanelRef.current?.querySelectorAll<HTMLButtonElement>('.task-search-result') ?? []);
                              const index = buttons.indexOf(event.currentTarget);
                              const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
                              (next ?? (event.key === 'ArrowUp' ? searchRef.current : event.currentTarget))?.focus();
                            }}
                          >
                            <span className="task-search-result-title">{row.item.text.trim() || '無題'}</span>
                            <span className="task-search-result-meta">
                              {row.item.type === 'section' ? 'ラベル' : row.item.filed ? '完了済み' : parentPath(row.item, items) || 'タスク'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : <p className="task-search-empty">一致するタスクはありません。</p>}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {inspected && !inspected.deletedAt && inspected.type === 'task' ? (
        <TaskInspector
          key={inspected.id}
          item={inspected}
          items={items}
          initialFocus={inspector?.focus ?? 'title'}
          todayDate={todayDate}
          onClose={closeInspector}
          onTextChange={taskStore.setText}
          onNoteChange={taskStore.setNote}
          onCompletionCriteriaChange={taskStore.setCompletionCriteria}
          onSetDeadline={taskStore.setDeadline}
          onToggleToday={(id) => taskStore.toggleToday(id, todayDate)}
          onSetEstimate={taskStore.setEstimate}
          onSetKind={taskStore.setKind}
          onRemove={(id) => {
            setInspector(null);
            removeRow(id);
          }}
          onAddAttachment={taskStore.addAttachment}
          onRemoveAttachment={taskStore.removeAttachment}
        />
      ) : null}
    </section>
  );
}
