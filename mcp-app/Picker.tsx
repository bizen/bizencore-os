import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, Filter, LoaderCircle, LockKeyhole, Minus, PanelRight, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { Brand } from '../src/components/Brand';
import { HandoffIntentControl } from '../src/components/task/HandoffIntentControl';
import type { HandoffIntent } from '../src/lib/taskWorkPrompt';
import { LABEL_COLORS, childrenOf, type Item, type ItemMap, type Row } from '../src/lib/taskModel';
import { applyTheme, readTheme, saveTheme, type Theme } from '../src/lib/theme';
import { boardGroups, filterDue, handoffMessage, pickerRows, taskPath, type DueFilter, type View } from './model';

export type Page = { items: Item[]; today_date: string; next_offset?: number };
type Attachment = { id: string; title: string; kind: string; text?: string; url?: string };
export type Detail = { id: string; text: string; note?: string; done: boolean; locked?: boolean; due_date?: string; due_time?: string; estimate_minutes?: number; completion_criteria?: string; attachments?: Attachment[]; subtasks?: Detail[] };
export interface PickerClient {
  connect(): Promise<void>;
  page(offset: number): Promise<Page>;
  detail(id: string): Promise<Detail>;
  send(text: string): Promise<void>;
  open(url: string): Promise<void>;
}

function Dialog({ name, className, onClose, children }: { name: string; className: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref.current!;
    const buttons = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href]')];
    (panel.querySelector<HTMLElement>('[data-autofocus]') ?? buttons()[0] ?? panel).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const focusable = buttons();
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); panel.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    panel.addEventListener('keydown', keydown);
    return () => { panel.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  return <div className="picker-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>{children}</div>
  </div>;
}

function TaskLine({ row, selected, today, onSelect, onFocusLabel, focused }: {
  row: Row; selected?: string; today: string; onSelect: (id: string) => void;
  onFocusLabel: (id: string) => void; focused: string[];
}) {
  const { item, depth } = row;
  const label = item.type === 'section';
  const color = item.color ? LABEL_COLORS[item.color] : undefined;
  return <li id={`item-${item.id}`} className={`row ${label ? 'row--section' : 'row--task'}${item.locked ? ' row--locked' : ''}${depth === 0 ? ' row--root' : ''}${item.done ? ' is-done' : ''}${selected === item.id ? ' is-active' : ''}`}
    style={{ '--depth': depth, '--label-color': color } as CSSProperties}>
    <div className="row-main">
      <div className="row-mark">
        {label ? <span className="row-section-mark" /> : item.locked ? <span className="row-lock-mark" role="img" aria-label="ロック中・完了不可" title="ロック中"><LockKeyhole size={14} aria-hidden /></span> : <span role="img" aria-label={item.done ? '完了' : '未完了'} className={`check${item.done ? ' is-checked' : ''}${item.completedBy === 'ai' ? ' is-ai-checked' : ''}`}>
          <span className="check-fill" />{item.done ? <Check className="picker-check" size={14} /> : null}
        </span>}
      </div>
      <div className="row-text">
        {label ? <span className="row-title row-title--section">{item.text || '（無題）'}</span>
          : <button className="row-title picker-title" onClick={() => onSelect(item.id)}>{item.text || '（無題）'}</button>}
        {item.note ? <p className="row-note">{item.note}</p> : null}
        {!label && (item.completionCriteria || item.dueDate || item.assignedDate === today) ? <div className="row-details">
          {item.assignedDate === today ? <span>Today</span> : null}
          {item.dueDate ? <time className={item.dueDate < today && !item.done ? 'is-overdue' : ''}>{item.dueDate.slice(5).replace('-', '/')} {item.dueTime}</time> : null}
          {item.completionCriteria ? <span className="row-criteria">完了条件: {item.completionCriteria}</span> : null}
        </div> : null}
      </div>
      <button className="app-settings-btn picker-row-action" title={label ? (focused.includes(item.id) ? 'フォーカスから外す' : 'フォーカスに追加') : '詳細を開く'}
        aria-label={label ? `${item.text}を${focused.includes(item.id) ? 'フォーカスから外す' : 'フォーカスに追加'}` : `${item.text}の詳細を開く`}
        onClick={() => label ? onFocusLabel(item.id) : onSelect(item.id)}>
        {label ? (focused.includes(item.id) ? <Minus size={14} /> : <Plus size={14} />) : <PanelRight size={15} />}
      </button>
    </div>
  </li>;
}

export function Picker({ client }: { client: PickerClient }) {
  const [items, setItems] = useState<ItemMap>({});
  const [today, setToday] = useState('');
  const [view, setView] = useState<View>('all');
  const [focus, setFocus] = useState<string[]>([]);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [dueFilter, setDueFilter] = useState<DueFilter>('all');
  const [filters, setFilters] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [detailVersion, setDetailVersion] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [intent, setIntent] = useState<HandoffIntent>('consult');
  const [status, setStatus] = useState('読み込み中…');
  const [error, setError] = useState('');
  const loadVersion = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeSearch = useCallback(() => setSearch(false), []);
  const closeSettings = useCallback(() => setSettings(false), []);
  const closeFilters = useCallback(() => setFilters(false), []);
  const closeDetail = useCallback(() => { setSelected(undefined); setDetail(undefined); setDetailError(''); }, []);

  useEffect(() => { applyTheme(theme); }, [theme]);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setBusy(true); setError(''); setStatus('読み込み中…');
    try {
      const result: ItemMap = {};
      let offset: number | undefined = 0, date = '';
      while (offset !== undefined) {
        const page = await client.page(offset);
        if (version !== loadVersion.current) return;
        for (const item of page.items) result[item.id] = item;
        date = page.today_date;
        if (page.next_offset !== undefined && page.next_offset <= offset) throw new Error('一覧の続きが読み込めませんでした。');
        offset = page.next_offset;
      }
      setItems(result); setToday(date); setStatus('');
    } catch (e) {
      if (version === loadVersion.current) { setError(e instanceof Error ? e.message : '一覧を読み込めませんでした。'); setStatus(''); }
    } finally { if (version === loadVersion.current) setBusy(false); }
  }, [client]);
  useEffect(() => {
    let alive = true;
    client.connect().then(() => { if (alive) void load(); }).catch(() => {
      if (alive) { setBusy(false); setStatus(''); setError('ホストに接続できませんでした。画面を開き直してください。'); }
    });
    return () => { alive = false; };
  }, [client, load]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    client.detail(selected).then((task) => { if (alive) setDetail(task); }).catch((e) => {
      if (alive) setDetailError(e instanceof Error ? e.message : '詳細を読み込めませんでした。');
    });
    return () => { alive = false; };
  }, [client, selected, detailVersion]);

  const rows = useMemo(() => {
    const source = pickerRows(items, view, today);
    if (!today) return source;
    return { active: filterDue(source.active, dueFilter, today), done: dueFilter === 'all' ? source.done : [] };
  }, [items, view, today, dueFilter]);
  const labels = useMemo(() => childrenOf(items, null).filter((item) => item.type === 'section'), [items]);
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return pickerRows(items, 'all', today).active.map((row) => row.item).filter((item) => item.type === 'task' && (!term || `${item.text}\n${item.note ?? ''}`.toLocaleLowerCase().includes(term)));
  }, [items, today, query]);
  const selectedItem = selected ? items[selected] : undefined;
  const note = detail ? detail.note : selectedItem?.note;
  const criteria = detail ? detail.completion_criteria : selectedItem?.completionCriteria;
  const dueDate = detail ? detail.due_date : selectedItem?.dueDate;
  const dueTime = detail ? detail.due_time : selectedItem?.dueTime;
  const estimate = detail ? detail.estimate_minutes : selectedItem?.estimate;
  const detailChildren = detail ? detail.subtasks ?? [] : selected ? childrenOf(items, selected) : [];
  const visibleLabels = labels.filter((label) => rows.active.some((row) => row.item.id === label.id));
  const select = (id: string) => { setIntent('consult'); setDetail(undefined); setDetailError(''); setSelected(id); setDetailVersion((version) => version + 1); setSearch(false); };
  const toggleFocus = (id: string) => {
    setFocus((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    if (view === `label:${id}`) setView('all');
  };
  const changeView = (next: View) => { setView(next); scrollRef.current?.scrollTo({ top: 0 }); };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || settings || filters || selected) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearch((value) => !value); return; }
      if (search || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName)) return;
      if (event.altKey && /^Digit[1-9]$/.test(event.code)) {
        const index = Number(event.code.slice(5)) - 1;
        const next = (['all', 'board', 'today', ...focus.map((id) => `label:${id}`)] as View[])[index];
        if (next) { event.preventDefault(); setView(next); scrollRef.current?.scrollTo({ top: 0 }); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [focus, search, settings, filters, selected]);
  const send = async () => {
    if (!selected || !detail || detail.done || sending) return;
    setSending(true); setDetailError('');
    try {
      await client.send(handoffMessage(selected, intent));
      setStatus('選んだタスクを会話に送りました。'); closeDetail();
    } catch (e) { setDetailError(`${e instanceof Error ? e.message : '会話へ送信できませんでした。'} タスクID: ${selected}`); }
    finally { setSending(false); }
  };
  const taskList = (list: Row[]) => <ul className="row-list">{list.map((row) => <TaskLine key={row.item.id} row={row} selected={selected} today={today} onSelect={select} onFocusLabel={toggleFocus} focused={focus} />)}</ul>;
  const todayCount = pickerRows(items, 'today', today).active.filter((row) => row.item.type === 'task' && !row.item.done).length;
  const openLink = (url: string) => { void client.open(url).catch(() => {
    if (selected) setDetailError('リンクを開けませんでした。');
    else setStatus('リンクを開けませんでした。');
  }); };

  return <main className="picker-shell">
    <header className="app-header"><Brand /><div className="picker-header-actions">
      <button className="app-settings-btn" title="一覧を更新" aria-label="一覧を更新" disabled={busy} onClick={() => void load()}><RefreshCw size={16} className={busy ? 'picker-spin' : ''} /></button>
      <button className="app-settings-btn" title="設定" aria-label="設定" aria-expanded={settings} onClick={() => setSettings(true)}><Settings2 size={17} /></button>
    </div></header>
    <div className="picker-scroll" ref={scrollRef}><div className="picker-page">
      <div className="tasks-toolbar"><div className="view-switch" role="tablist" aria-label="表示">
        {(['all', 'board', 'today'] as const).map((tab) => <button key={tab} className={`view-switch-btn${view === tab ? ' active' : ''}`} role="tab" aria-selected={view === tab} onClick={() => changeView(tab)}>
          {tab}{tab === 'today' && todayCount > 0 ? <span className="view-switch-count">{todayCount}</span> : null}
        </button>)}
        {focus.map((id) => items[id] ? <button key={id} role="tab" aria-selected={view === `label:${id}`} className={`view-switch-btn view-switch-btn--focus${view === `label:${id}` ? ' active' : ''}`} onClick={() => changeView(`label:${id}`)}>
          <span className="view-switch-dot" style={{ background: items[id].color ? LABEL_COLORS[items[id].color] : undefined }} /><span className="view-switch-label">{items[id].text}</span>
        </button> : null)}
      </div><button className="ghost-btn tasks-search-btn" title="検索" aria-label="検索" onClick={() => setSearch(true)}><Search size={17} /></button>
      <button className="app-settings-btn" title="締切で絞り込む" aria-label="締切で絞り込む" aria-pressed={dueFilter !== 'all'} onClick={() => setFilters(true)}><Filter size={16} /></button></div>
      {status ? <p className="picker-status" role="status">{status}</p> : null}
      {error ? <div className="picker-error" role="alert"><p>{error}</p><button className="ghost-btn" onClick={() => void load()}>再読み込み</button></div> : null}
      {!busy && !error ? <div className={`tasks-layout${view === 'all' && labels.length ? ' has-index' : ''}`}>
        {view === 'all' && labels.length ? <nav className="label-index" aria-label="ラベル目次"><ul className="label-index-list">{visibleLabels.map((label) => <li key={label.id}>
          <button className="label-index-link" onClick={() => document.getElementById(`item-${label.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
            <span className="label-index-mark" style={{ background: label.color ? LABEL_COLORS[label.color] : undefined }} /><span className="label-index-name">{label.text || '（無題）'}</span>
          </button>
        </li>)}</ul></nav> : null}
        <div className="picker-lists">
          {view === 'board' ? <div className="board">{boardGroups(rows.active).map(({ label, rows: group }) => {
            return <section key={label?.id ?? 'unlabelled'} className="board-col" style={{ '--board-color': label?.color ? LABEL_COLORS[label.color] : undefined } as CSSProperties}>
              <div className="board-col-head"><h2 className="board-col-title">{label?.text ?? 'ラベルなし'}</h2><span className="board-col-count">{group.filter((row) => row.item.type === 'task' && !row.item.done).length}</span></div>
              {label?.note ? <p className="row-note">{label.note}</p> : null}{taskList(group)}
            </section>;
          })}</div> : taskList(rows.active)}
          {!rows.active.some((row) => row.item.type === 'task') ? <p className="picker-empty">{dueFilter !== 'all' ? 'この締切条件に合うタスクはありません。' : view === 'today' ? 'Today のタスクはありません。' : 'タスクはありません。'}</p> : null}
          {rows.done.length ? <details className="picker-completed"><summary>完了済み <span>{rows.done.filter((row) => row.item.type === 'task').length}</span></summary>{taskList(rows.done)}</details> : null}
        </div>
      </div> : null}
    </div></div>
    <footer className="picker-footer"><span>{Object.values(items).filter((item) => item.type === 'task' && !item.done).length} tasks</span><a href="https://app.bizencore.com" onClick={(e) => { e.preventDefault(); openLink('https://app.bizencore.com'); }}>bizencore OS <ArrowUpRight size={12} /></a></footer>
    {filters ? <Dialog name="締切で絞り込む" className="picker-settings" onClose={closeFilters}>
      <div className="inspector-head"><h2>締切</h2><button className="app-settings-btn" aria-label="絞り込みを閉じる" onClick={closeFilters}><X size={18} /></button></div>
      {([{ id: 'all', name: 'すべて' }, { id: 'overdue', name: '期限切れ' }, { id: 'week', name: '7日以内' }, { id: 'dated', name: '期限あり' }] as const).map((option) => <label key={option.id} className="picker-filter-option">
        <input type="radio" name="due-filter" value={option.id} checked={dueFilter === option.id} onChange={() => { setDueFilter(option.id); closeFilters(); }} />{option.name}
      </label>)}
    </Dialog> : null}
    {settings ? <Dialog name="設定" className="picker-settings" onClose={closeSettings}>
      <div className="inspector-head"><h2>設定</h2><button className="app-settings-btn" aria-label="設定を閉じる" onClick={closeSettings}><X size={18} /></button></div><h3 className="inspector-label">外観</h3>
      <div className="theme-switch" role="group" aria-label="外観">{([{ id: 'original', name: 'オリジナル' }, { id: 'black', name: 'ミッドナイトブラック' }, { id: 'white', name: 'フロストホワイト' }] as const).map((option) =>
        <button key={option.id} className={`theme-option${theme === option.id ? ' is-selected' : ''}`} aria-pressed={theme === option.id} onClick={() => { setTheme(option.id); saveTheme(option.id); }}><span className={`theme-swatch theme-swatch--${option.id}`} /><span className="theme-option-name">{option.name}</span></button>)}</div>
    </Dialog> : null}
    {search ? <Dialog name="タスクを検索" className="task-search-panel" onClose={closeSearch}>
      <div className="task-search-field"><Search size={19} /><input data-autofocus aria-label="タスク名やメモを検索" placeholder="タスク名やメモを検索" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && results[0]) { e.preventDefault(); select(results[0].id); } }} />
        <button className="task-search-close" aria-label="検索を閉じる" onClick={closeSearch}><X size={17} /></button></div>
      <div className="task-search-matches"><p className="task-search-count">{results.length}件</p><ul className="task-search-results">{results.map((item) => <li key={item.id}>
        <button className="task-search-result" onClick={() => select(item.id)}><span className="task-search-result-title">{item.text}</span><span className="task-search-result-meta">{taskPath(items, item.id)}</span></button>
      </li>)}</ul>{!results.length ? <p className="task-search-empty">該当するタスクはありません。</p> : null}</div>
    </Dialog> : null}
    {selected && (selectedItem || detail) ? <Dialog name="タスク詳細" className="inspector picker-inspector" onClose={closeDetail}>
      <div className="inspector-head"><span className="inspector-kicker">タスク詳細</span><button className="app-settings-btn" aria-label="詳細を閉じる" onClick={closeDetail}><X size={18} /></button></div>
      <p className="picker-path">{taskPath(items, selected)}</p><h2 className="inspector-title">{detail?.text ?? selectedItem?.text}</h2>
      {note ? <section className="inspector-section"><h3 className="inspector-label">メモ</h3><p className="picker-detail-text">{note}</p></section> : null}
      <div className="inspector-section inspector-props">
        <div className="inspector-prop"><span className="inspector-label">締切</span><span>{dueDate ? `${dueDate} ${dueTime ?? ''}` : 'なし'}</span></div>
        {estimate !== undefined ? <div className="inspector-prop"><span className="inspector-label">作業時間</span><span>{estimate} min</span></div> : null}
        <div className="inspector-prop"><span className="inspector-label">状態</span><span>{(detail?.done ?? selectedItem?.done) ? '完了' : '未完了'}</span></div>
      </div>
      {criteria ? <section className="inspector-section"><h3 className="inspector-label">完了条件</h3><p className="picker-detail-text">{criteria}</p></section> : null}
      {detail?.attachments?.length ? <section className="inspector-section"><h3 className="inspector-label">コンテキスト</h3>{detail.attachments.map((attachment) => <div className="picker-context" key={attachment.id}>
        <span>{attachment.title}</span>{attachment.text ? <p className="picker-detail-text">{attachment.text}</p> : null}
        {attachment.url && /^https?:\/\//i.test(attachment.url) ? <a href={attachment.url} onClick={(e) => { e.preventDefault(); openLink(attachment.url!); }}>{attachment.kind === 'file' ? 'ファイルを開く' : 'リンクを開く'} <ArrowUpRight size={12} /></a> : null}
      </div>)}</section> : null}
      {detailChildren.length ? <section className="inspector-section"><h3 className="inspector-label">サブタスク</h3>{detailChildren.map((item) => <button key={item.id} className="picker-subtask" onClick={() => select(item.id)}><span>{item.text}</span><ChevronRight size={14} /></button>)}</section> : null}
      {detailError ? <div className="picker-error" role="alert"><p>{detailError}</p>{!detail ? <button className="ghost-btn" onClick={() => { setDetailError(''); setDetailVersion((version) => version + 1); }}>再読み込み</button> : null}</div> : null}
      <section className="inspector-section picker-handoff-section">
        <h3 className="inspector-label">AI ハンドオフ</h3>
        <HandoffIntentControl intent={intent} onChange={setIntent} disabled={sending} />
        <button className="primary-btn picker-handoff" disabled={!detail || detail.done || sending} onClick={() => void send()}>{sending || (!detail && !detailError) ? <LoaderCircle size={16} className="picker-spin" /> : <ArrowUpRight size={16} />}{intent === 'consult' ? '検討を始める' : '実行を始める'}</button>
      </section>
    </Dialog> : null}
  </main>;
}
