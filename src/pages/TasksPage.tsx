import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { TaskRow } from '../components/task/TaskRow';
import { focusFirstMeta } from '../lib/metaCursor';
import { FOOTER_SHORTCUTS } from '../lib/shortcuts';
import { formatEstimate } from '../lib/taskEstimate';
import { localDateString } from '../lib/taskDates';
import {
  type Item,
  type ItemMap,
  type LabelColor,
  type Row,
  flattenAll,
  flattenToday,
} from '../lib/taskModel';
import { taskStore, useTaskState } from '../lib/taskStore';

type ViewMode = 'all' | 'today';

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
type Caret = number | 'start' | 'end';
type FocusTarget = 'title' | 'note';
type PendingFocus = { id: string; target: FocusTarget; caret: Caret; misses: number };

/** 日付が変わったら today 表示も追従させる */
function useTodayDate(): string {
  const [todayDate, setTodayDate] = useState(() => localDateString());
  useEffect(() => {
    const id = setInterval(() => {
      const next = localDateString();
      setTodayDate((current) => (current === next ? current : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  return todayDate;
}

/**
 * 「完了を整理」で棚へ送った行を、リストから切り分ける。
 *
 * 完了しただけの行はその場に残る。棚へ移るのは filed が立ったものとその部分木。
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
    const parent = item.parentId ? items[item.parentId] : undefined;
    const filed =
      item.type === 'task' &&
      item.done &&
      item.filed === true &&
      !bursting.has(item.id) &&
      (!parent || parent.type === 'section');

    if (filed) {
      baseDepth = row.depth;
      done.push({ item, depth: 0 });
    } else {
      active.push(row);
    }
  }

  return { active, done };
}

/** 検索語に当たった行と、その祖先だけを残す */
function filterRows(rows: Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;

  const matches = (item: Item) =>
    item.text.toLowerCase().includes(needle) ||
    (item.note ?? '').toLowerCase().includes(needle);

  const kept: Row[] = [];
  const ancestors: Row[] = [];
  const emitted = new Set<string>();

  for (const row of rows) {
    ancestors.length = row.depth;
    ancestors[row.depth] = row;

    if (!matches(row.item)) continue;
    for (let d = 0; d <= row.depth; d++) {
      const ancestor = ancestors[d];
      if (!ancestor || emitted.has(ancestor.item.id)) continue;
      emitted.add(ancestor.item.id);
      kept.push(ancestor);
    }
  }

  return kept;
}

export function TasksPage() {
  const { items } = useTaskState();
  const todayDate = useTodayDate();

  const [view, setView] = useState<ViewMode>('all');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const [estimateEditId, setEstimateEditId] = useState<string | null>(null);
  const [colorOpenId, setColorOpenId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(loadShelfOpen);
  /** 完了した瞬間だけ演出を出す行。値は上から数えた順番（点灯のずらし用） */
  const [burstOrder, setBurstOrder] = useState<ReadonlyMap<string, number>>(EMPTY_BURST);

  const titleRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  const allRows = useMemo(() => flattenAll(items), [items]);
  const todayRows = useMemo(() => flattenToday(items, todayDate), [items, todayDate]);
  const { activeRows, doneRows } = useMemo(() => {
    const source = view === 'today' ? todayRows : allRows;
    const split = partitionCompleted(source, items, burstOrder);
    return {
      activeRows: filterRows(split.active, query),
      doneRows: filterRows(split.done, query),
    };
  }, [view, todayRows, allRows, items, burstOrder, query]);

  const doneCount = useMemo(
    () => doneRows.filter((row) => row.item.type === 'task').length,
    [doneRows]
  );

  useEffect(() => {
    try {
      localStorage.setItem(SHELF_OPEN_KEY, completedOpen ? '1' : '0');
    } catch {
      // 保存できなくても表示には困らない
    }
  }, [completedOpen]);

  /** 検索中は、当たったものが隠れないよう棚を開けておく（この状態は覚えない） */
  const shelfOpen = completedOpen || (query.trim() !== '' && doneRows.length > 0);

  /** ↑↓ で行き来できる範囲。棚を開いているときはそこも含める */
  const rows = useMemo(
    () => (shelfOpen ? [...activeRows, ...doneRows] : activeRows),
    [shelfOpen, activeRows, doneRows]
  );

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
      const parent = item.parentId ? items[item.parentId] : undefined;
      if (!item.filed && (!parent || parent.type === 'section')) fileable += 1;
    }
    // 残りと合計時間は、いま見ている表示の分だけ数える（today なら today の合計）
    for (const row of view === 'today' ? todayRows : allRows) {
      const { item } = row;
      if (item.type !== 'task' || item.done) continue;
      remaining += 1;
      remainingMinutes += item.estimate ?? 0;
    }
    return { remaining, remainingMinutes, completed, fileable };
  }, [allRows, todayRows, view, items]);

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
      if (estimateEditId === id) setEstimateEditId(null);
      if (colorOpenId === id) setColorOpenId(null);
      requestFocus(fallback);
    },
    [rowIndexOf, rows, noteOpenId, estimateEditId, colorOpenId, requestFocus]
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

  const handleEstimateEditingChange = useCallback(
    (id: string, editing: boolean) => {
      if (editing) {
        rememberFocus();
        setEstimateEditId(id);
        return;
      }
      setEstimateEditId(null);
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
        if (active.closest('.color-popover') || active.closest('.estimate-input')) return;
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
      setEstimateEditId(null);
      setColorOpenId(null);
      requestFocus(taskStore.insertAfter(anchorId, { type: 'section' }));
    },
    [requestFocus]
  );

  const setViewMode = useCallback((next: ViewMode) => {
    setView(next);
    setEstimateEditId(null);
    setColorOpenId(null);
  }, []);

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

      if (event.key === 'Escape') {
        if (estimateEditId) {
          handleEstimateEditingChange(estimateEditId, false);
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
        if (query) {
          setQuery('');
          event.preventDefault();
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
        setViewMode('today');
        return;
      }
      if (mod && event.code === 'KeyF') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
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
    estimateEditId,
    colorOpenId,
    helpOpen,
    query,
    rows,
    activeId,
    requestFocus,
    handleEstimateEditingChange,
    handleColorOpenChange,
    setViewMode,
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
        handleEstimateEditingChange(item.id, true);
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
      todayDate={todayDate}
      todayNumber={view === 'today' ? todayNumbers.get(row.item.id) : undefined}
      burstIndex={burstOrder.get(row.item.id)}
      isActive={activeId === row.item.id}
      noteOpen={noteOpenId === row.item.id}
      estimateEditing={estimateEditId === row.item.id}
      colorOpen={colorOpenId === row.item.id}
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
      onSetEstimate={taskStore.setEstimate}
      onEstimateEditingChange={handleEstimateEditingChange}
      onColorOpenChange={handleColorOpenChange}
      onRemove={removeRow}
      onTitleBlur={handleTitleBlur}
      onSetLabelColor={setLabelColor}
    />
  );

  return (
    <section className="page">
      <div className="tasks-toolbar">
        <div className="view-switch" role="tablist" aria-label="表示">
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
            aria-selected={view === 'today'}
            className={`view-switch-btn${view === 'today' ? ' active' : ''}`}
            onClick={() => setViewMode('today')}
            title="⌥2"
          >
            today
            <span className="view-switch-count">{todayNumbers.size}</span>
          </button>
        </div>

        <input
          ref={searchRef}
          className="tasks-search"
          value={query}
          placeholder="検索（⌘F）"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setQuery('');
              e.currentTarget.blur();
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              requestFocus(rows[0]?.item.id);
            }
          }}
          aria-label="タスクを検索"
        />

        <button
          type="button"
          className="ghost-btn tasks-help-btn"
          onClick={() => setHelpOpen(true)}
          title="⌘/"
          aria-label="キーボードショートカット"
        >
          ?
        </button>
      </div>

      <ul className="row-list">{activeRows.map(renderRow)}</ul>

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
            {/* 位置が変わらないよう常に出しておき、対象がないときは押せなくする */}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => taskStore.fileCompleted()}
              disabled={stats.fileable === 0}
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

      {helpOpen ? <KeyboardHelp onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}
