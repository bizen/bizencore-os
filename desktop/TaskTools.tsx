import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FolderOpen, ListChecks, Pause, Play, RefreshCw, Square, Workflow, X } from 'lucide-react';
import { taskStore, useTaskState } from '../src/lib/taskStore';
import { flattenAll, isLive } from '../src/lib/taskModel';
import { assignWork, labelForTask, matchesWorkSource, selectedRoots, workOutcome, type WorkAgent, type WorkEntry, type WorkRequest } from '../src/lib/taskTools';
import * as bridge from './bridge';
import { OrchestrationTerminal, type TerminalJob } from './OrchestrationTerminal';

export type ToolsIntent = { mode: WorkRequest['mode']; ids: string[]; serial: number };
const names = { codex: 'Codex', claude: 'Claude Code' };
const states: Record<WorkEntry['state'], string> = { queued: '未着手', running: '実行中', completed: '完了', waiting: '質問待ち', partial: '残作業あり', error: 'エラー', skipped: '対象外', interrupted: '中断' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function restoredSet(key: string): { mode: WorkRequest['mode']; entries: WorkEntry[] } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value?.version !== 1 || !['execute', 'decompose'].includes(value.mode) || !Array.isArray(value.entries) || value.entries.length > 100) throw Error('Invalid saved run');
    return { mode: value.mode, entries: value.entries.filter((entry: WorkEntry) => entry && typeof entry.taskId === 'string' && ['codex', 'claude'].includes(entry.agent) && Object.hasOwn(states, entry.state))
      .map((entry: WorkEntry) => ({ taskId: entry.taskId, agent: entry.agent, state: entry.state === 'running' || value.mode === 'decompose' ? 'interrupted' : entry.state,
        result: value.mode === 'execute' && entry.result && ['completed', 'waiting', 'partial'].includes(entry.result.status) && typeof entry.result.summary === 'string' && Array.isArray(entry.result.questions) && entry.result.questions.every(question => typeof question === 'string')
          ? { status: entry.result.status, summary: entry.result.summary.slice(0, 4000), questions: entry.result.questions.slice(0, 8).map(question => question.slice(0, 2000)), steps: [] } : undefined,
        error: entry.state === 'running' ? '終了前の実行状態を確認してから再開してください' : value.mode === 'decompose' ? '最新の内容で分担案を再作成してください' : undefined })) };
  } catch { return { mode: 'execute', entries: [] }; }
}

export function TaskTools({ storageKey, available, cwd: lastCwd, busy, intent, hidden, onClose, onCwd, onBusy, onOpenTask, fontSize = 13 }: {
  storageKey: string; available: bridge.AgentDiagnostic[]; cwd: string; busy: boolean; intent: ToolsIntent; hidden: boolean;
  onClose: () => void; onCwd: (cwd: string) => void; onBusy: (busy: boolean) => void; onOpenTask?: (id: string) => void;
  fontSize?: number;
}) {
  const { items } = useTaskState();
  const [restored] = useState(() => restoredSet(storageKey));
  const [mode, setMode] = useState(restored.mode);
  const modeRef = useRef(mode);
  const [selected, setSelected] = useState<string[]>(intent.ids);
  const [label, setLabel] = useState('');
  const [query, setQuery] = useState('');
  const [cwd, setCwd] = useState(lastCwd);
  const [overrides, setOverrides] = useState<Record<string, WorkAgent>>({});
  const [entries, setEntries] = useState<WorkEntry[]>(restored.entries);
  const entriesRef = useRef(entries);
  const [running, setRunning] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [terminalJob, setTerminalJob] = useState<TerminalJob | null>(null);
  const terminalJobRef = useRef<TerminalJob | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const halt = useRef<'pause' | 'stop' | null>(null);
  const requestId = useRef<string | null>(null);
  const sources = useRef(new Map<string, unknown>());
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const agents = available.filter(agent => agent.path && !agent.problem).map(agent => agent.id);
  const rows = flattenAll(items);
  const labels = rows.filter(row => row.item.type === 'section');
  const roots = selectedRoots(items, selected);
  const candidates = rows.filter(({ item }) => item.type === 'task' && !item.done && !item.filed && (!label || labelForTask(items, item) === label) && `${item.text}\n${item.note ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const commit = (next: WorkEntry[]) => { entriesRef.current = next; setEntries(next); };
  const update = (id: string, changes: Partial<WorkEntry>) => commit(entriesRef.current.map(entry => entry.taskId === id ? { ...entry, ...changes } : entry));
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    if (active.current || intent.serial === 0) return;
    if (modeRef.current !== intent.mode) { entriesRef.current = []; setEntries([]); }
    setMode(intent.mode); setSelected(intent.ids); setError('');
  }, [intent.serial, intent.mode, intent.ids]);
  useEffect(() => {
    let failed = false;
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, mode, entries: entries.map(({ taskId, agent, state, result }) => ({ taskId, agent, state,
      result: mode === 'execute' && result ? { ...result, steps: [], summary: result.summary.slice(0, 4000), questions: result.questions.map(question => question.slice(0, 2000)) } : undefined,
    })) })); }
    catch { failed = true; }
    void Promise.resolve().then(() => { if (mounted.current) setStorageError(failed); });
  }, [entries, mode, storageKey]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; halt.current = 'stop'; terminalJobRef.current?.controller.abort(); if (requestId.current && !terminalJobRef.current) void bridge.taskStop(requestId.current).catch(() => {}); };
  }, []);
  const drive = async (next: WorkEntry[]) => {
    if (active.current || busy) return;
    active.current = true; halt.current = null; setRunning(true); onBusy(true); setError(''); commit(next);
    try {
      for (const entry of next) {
        if (halt.current || !mounted.current) break;
        if (entry.state !== 'queued') continue;
        const current = taskStore.getState().items[entry.taskId];
        if (!isLive(current) || current.done || current.filed || !agents.includes(entry.agent)) { update(entry.taskId, { state: 'skipped' }); continue; }
        const id = crypto.randomUUID(); requestId.current = id;
        update(entry.taskId, { state: 'running', error: undefined });
        try {
          const request: WorkRequest = { id, mode, taskId: entry.taskId, agent: entry.agent, cwd,
            reply: `${entry.result?.summary ? `以前の途中経過: ${entry.result.summary}\n既に行った変更を確認し、繰り返さないでください。\n` : ''}${entry.reply ?? ''}` };
          const response = mode === 'decompose' ? await bridge.taskRun(request) : await new Promise<Awaited<ReturnType<typeof bridge.taskReview>>>((resolve, reject) => {
            if (!bridge.interactiveOrchestrationSupported) { reject(Error('通常CLIでのオーケストレーションにはデスクトップアプリの更新が必要です')); return; }
            let settled = false;
            const job: TerminalJob = { request, title: current.text || '（無題）', automatic, controller: new AbortController(),
              settle: (reply, failure) => {
                if (settled) return;
                settled = true;
                terminalJobRef.current = null;
                if (mounted.current) setTerminalJob(null);
                if (failure || !reply) reject(failure ?? Error('実行結果を確認できませんでした')); else resolve(reply);
              } };
            terminalJobRef.current = job; setTerminalJob(job);
          });
          if (!mounted.current) break;
          sources.current.set(entry.taskId, response.sourceTask);
          update(entry.taskId, { state: workOutcome(response, mode), result: response.result, updatedAt: current.updatedAt, reply: undefined });
        } catch (failure) {
          if (!mounted.current) break;
          update(entry.taskId, { state: halt.current === 'stop' ? 'interrupted' : 'error', error: message(failure) });
          // Infrastructure/permission errors do not silently launch another worker.
          halt.current = 'pause';
        } finally { requestId.current = null; }
      }
    } finally { active.current = false; if (mounted.current) { setRunning(false); onBusy(false); } }
  };
  const retry = (taskId?: string) => {
    if (!confirm('最新のタスクと変更済みの内容を確認してから再開します。続けますか？')) return;
    void drive(entriesRef.current.map(entry => (!taskId && ['queued', 'interrupted'].includes(entry.state)) || entry.taskId === taskId ? { ...entry, state: 'queued' } : entry));
  };
  return <section className="task-tools" hidden={hidden} aria-label="タスク作業ツール" onKeyDown={event => event.stopPropagation()}>
    <div className="task-tools-head"><h2>作業ツール</h2><button type="button" className="icon-btn" title="閉じる" aria-label="作業ツールを閉じる" onClick={onClose}><X size={16} /></button></div>
    <div className="inspector-handoff-mode" role="group" aria-label="作業ツールの種類">
      <button type="button" disabled={running} className={mode === 'execute' ? 'is-on' : ''} aria-pressed={mode === 'execute'} onClick={() => { setMode('execute'); commit([]); }}><Workflow size={15} />オーケストレーション</button>
      <button type="button" disabled={running} className={mode === 'decompose' ? 'is-on' : ''} aria-pressed={mode === 'decompose'} onClick={() => { setMode('decompose'); commit([]); }}><ListChecks size={15} />タスクベース分解</button>
    </div>
    {mode === 'execute' ? <label className="orchestration-advance-setting">次のタスクへ<select aria-label="次のタスクへの移行" disabled={running} value={automatic ? 'automatic' : 'manual'} onChange={event => setAutomatic(event.target.value === 'automatic')}><option value="manual">確認して次へ</option><option value="automatic">MCP完了後に自動移行</option></select></label> : null}
    <button type="button" className="ghost-btn task-tools-folder" disabled={running} title={cwd || '作業フォルダを選択'} onClick={() => void bridge.folder().then(value => { if (value) { setCwd(value); onCwd(value); } }).catch(failure => setError(message(failure)))}><FolderOpen size={15} /><span>{cwd.split('/').filter(Boolean).at(-1) || '作業フォルダを選択'}</span></button>
    {!running ? <>
      <div className="task-tools-filters"><select aria-label="作業対象のラベル" value={label} onChange={event => setLabel(event.target.value)}><option value="">すべてのラベル</option>{labels.map(({ item }) => <option key={item.id} value={item.id}>{item.text}</option>)}</select><input type="search" aria-label="作業対象を検索" placeholder="検索" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="task-tools-selection-actions"><button type="button" className="ghost-btn" onClick={() => { const ids = selectedRoots(items, [...selected, ...candidates.map(row => row.item.id)]); if (ids.length > 100) setError('一度に選択できるのは100件までです'); else setSelected(ids); }}>表示中を選択</button><button type="button" className="ghost-btn" onClick={() => setSelected([])}>選択解除</button><small>{roots.length}件選択</small></div>
      <div className="task-tools-candidates">{candidates.map(({ item }) => <label key={item.id}><input type="checkbox" checked={roots.includes(item.id)} onChange={event => { const ids = event.target.checked ? selectedRoots(items, [...roots, item.id]) : roots.filter(id => id !== item.id); if (ids.length > 100) setError('一度に選択できるのは100件までです'); else setSelected(ids); }} /><span>{item.text || '（無題）'}<small>{items[labelForTask(items, item)]?.text || 'ラベルなし'}{item.parentId && items[item.parentId]?.type === 'task' ? ` › ${items[item.parentId].text}` : ''}</small></span></label>)}</div>
      {roots.length ? <ol className="task-tools-order">{roots.map((id, index) => <li key={id}><span>{items[id]?.text || '（無題）'}</span><select aria-label={`${items[id]?.text}の担当`} value={overrides[id] ?? ''} onChange={event => setOverrides(value => { const next = { ...value }; if (event.target.value) next[id] = event.target.value as WorkAgent; else delete next[id]; return next; })}><option value="">交互配分</option>{agents.map(agent => <option key={agent} value={agent}>{names[agent]}</option>)}</select><button type="button" className="icon-btn" disabled={index === 0} aria-label={`${items[id]?.text}を前へ`} title="前へ" onClick={() => { const next = [...roots]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setSelected(next); }}><ArrowUp size={13} /></button><button type="button" className="icon-btn" disabled={index === roots.length - 1} aria-label={`${items[id]?.text}を後ろへ`} title="後ろへ" onClick={() => { const next = [...roots]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; setSelected(next); }}><ArrowDown size={13} /></button></li>)}</ol> : null}
      <button type="button" className="ghost-btn" disabled={!bridge.taskToolsSupported || (mode === 'execute' && !bridge.interactiveOrchestrationSupported) || !roots.length || !cwd || !agents.length || busy} onClick={() => {
        try {
          const next = assignWork(roots, agents, overrides);
          if (!confirm(`${mode === 'execute' ? `選択したタスクと配下の既存サブタスクを専用の通常CLIペインで順に実行します。公開・送信・削除は許可しません。\n${automatic ? 'MCP完了後に現在のCLIを終了して次へ移ります。ターミナルに入力すると自動移行を保留します。' : '次へ進むには完了確認ボタンを押します。現在のCLIを終了する前に確認します。'}` : '分担案を作成します。確認して反映するまでタスクは変更しません。'}\n作業フォルダ: ${cwd}\n${next.map((entry, index) => `${index + 1}. ${items[entry.taskId].text} → ${names[entry.agent]}`).join('\n')}`)) return;
          sources.current.clear(); void drive(next);
        } catch (failure) { setError(message(failure)); }
      }}><Play size={15} />{mode === 'execute' ? '確認して開始' : '分担案を作成'}</button>
    </> : <div className="task-tools-running" role="status"><span>{entries.filter(entry => entry.state === 'completed').length}/{entries.length}件{mode === 'execute' ? '完了' : '提案済み'}</span><button type="button" className="icon-btn" title="このタスク後に一時停止" aria-label="このタスク後に一時停止" onClick={() => { halt.current = 'pause'; }}><Pause size={16} /></button><button type="button" className="icon-btn" title="実行を停止" aria-label="実行を停止" onClick={() => { halt.current = 'stop'; if (terminalJobRef.current) terminalJobRef.current.controller.abort(); else if (requestId.current) void bridge.taskStop(requestId.current).catch(failure => setError(message(failure))); }}><Square size={15} /></button></div>}
    {mode === 'execute' ? <OrchestrationTerminal job={terminalJob} fontSize={fontSize} /> : null}
    {entries.length ? <div className="task-tools-results">{entries.map(entry => <article key={entry.taskId}>
      <button type="button" className="agent-assignment-title" onClick={() => onOpenTask?.(entry.taskId)}>{items[entry.taskId]?.text || entry.taskId}</button><small>{names[entry.agent]} · {mode === 'decompose' && entry.state === 'completed' ? '提案済み' : states[entry.state]}</small>
      {entry.result ? <p>{entry.result.summary}</p> : null}{entry.error ? <p className="agent-error" role="alert">{entry.error}</p> : null}
      {entry.result?.questions.map((question, index) => <p key={index}>{question}</p>)}
      {mode === 'decompose' && entry.result?.steps.length ? <>
        {entry.result.steps.map((step, index) => <div className="task-tools-step" key={index}><input aria-label={`分担案${index + 1}のタイトル`} disabled={running} value={step.text} onChange={event => update(entry.taskId, { result: { ...entry.result!, steps: entry.result!.steps.map((value, position) => position === index ? { ...value, text: event.target.value } : value) } })} /><select aria-label={`分担案${index + 1}の担当`} disabled={running} value={step.owner} onChange={event => update(entry.taskId, { result: { ...entry.result!, steps: entry.result!.steps.map((value, position) => position === index ? { ...value, owner: event.target.value as typeof step.owner } : value) } })}><option value="ai">AI</option><option value="human">人間</option><option value="joint">共同</option></select><small>{step.existingTaskId ? '既存サブタスクを利用' : '新しいサブタスク'}</small><textarea aria-label={`分担案${index + 1}のメモ`} disabled={running} value={step.note} onChange={event => update(entry.taskId, { result: { ...entry.result!, steps: entry.result!.steps.map((value, position) => position === index ? { ...value, note: event.target.value } : value) } })} /><textarea aria-label={`分担案${index + 1}の完了条件`} disabled={running} value={step.completionCriteria} onChange={event => update(entry.taskId, { result: { ...entry.result!, steps: entry.result!.steps.map((value, position) => position === index ? { ...value, completionCriteria: event.target.value } : value) } })} /></div>)}
        <button type="button" className="ghost-btn" disabled={running || entry.updatedAt === undefined || entry.result.status !== 'completed'} onClick={() => {
          try {
            if (!matchesWorkSource(taskStore.getState().items, entry.taskId, sources.current.get(entry.taskId))) throw Error('最新の内容の同期を待つか、分担案を再作成してください');
            if (!confirm('表示した分担案を反映します。既存サブタスクの変更と、新しいサブタスクの追加を行います。続けますか？')) return;
            taskStore.applyWorkPlan(entry.taskId, entry.updatedAt!, entry.result!, entry.agent);
            update(entry.taskId, { updatedAt: undefined });
          } catch (failure) { setError(message(failure)); }
        }}><Check size={15} />{entry.updatedAt === undefined ? '反映済み' : '確認して反映'}</button>
      </> : null}
      {!running && ['waiting', 'partial', 'error', 'interrupted'].includes(entry.state) ? <><textarea aria-label={`${items[entry.taskId]?.text}への回答`} placeholder="回答・補足" value={entry.reply ?? ''} onChange={event => update(entry.taskId, { reply: event.target.value })} /><button type="button" className="ghost-btn" disabled={!cwd || busy} onClick={() => retry(entry.taskId)}><RefreshCw size={14} />再確認して続ける</button></> : null}
    </article>)}{!running && entries.some(entry => ['queued', 'interrupted'].includes(entry.state)) ? <button type="button" className="ghost-btn" disabled={!cwd || busy} onClick={() => retry()}><Play size={15} />未着手・中断を再開</button> : null}</div> : null}
    {busy ? <p className="agent-error" role="status">手動ペインを停止してから開始してください。</p> : null}
    {!bridge.taskToolsSupported ? <p className="agent-error" role="status">この機能には更新済みのデスクトップアプリが必要です。</p> : null}
    {mode === 'execute' && !bridge.interactiveOrchestrationSupported ? <p className="agent-error" role="status">通常CLIでのオーケストレーションにはデスクトップアプリの更新が必要です。</p> : null}
    {storageError ? <p className="agent-error" role="alert">実行履歴を保存できませんでした。</p> : null}
    {error ? <p className="agent-error" role="alert">{error}</p> : null}
  </section>;
}
