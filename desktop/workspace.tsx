import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Columns2, ExternalLink, FolderOpen, Link2, ListTodo, Maximize2, Minimize2, Minus, PanelsTopLeft, Play, Plus, RotateCcw, Rows2, Search, Settings2, Square, Tag, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useLocation } from 'react-router-dom';
import '@xterm/xterm/css/xterm.css';
import * as bridge from './bridge';
import { DesktopHandoffContext, type PaneAssignment } from '../src/lib/desktopHandoff';
import { DesktopInspectorContext } from '../src/lib/desktopInspector';
import { DesktopHeaderContext } from '../src/lib/desktopHeader';
import { useTaskState } from '../src/lib/taskStore';
import { buildTaskHandoff } from '../src/lib/aiHandoff';
import { compareItems, isLive, type Item, type ItemMap } from '../src/lib/taskModel';
import { HandoffIntentControl } from '../src/components/task/HandoffIntentControl';
import { DesktopWorkspaceAccount } from './workspace-account';
import { readWorkspace, workspaceKey, writeWorkspace, type WorkspaceState } from './workspace-state';
import { validateTerminalInput } from './validation';
import { readTerminalTheme } from './terminal-theme';
import { TaskScrollRail } from '../src/components/TaskScrollRail';
import { defaultUiPrefs, readUiPrefs, uiPrefsKey, writeUiPrefs, type UiPrefs } from './ui-prefs';
import { completedAssignments } from './task-notifications';
import { TaskTools, type ToolsIntent } from './TaskTools';
import { AgentTaskAssignment } from './AgentTaskAssignment';
import { AgentLogo } from './AgentLogo';

type Pane = { id: string; agent: bridge.AgentId; cwd: string; assignment?: PaneAssignment; labelId?: string; resumeSessionId?: string; busy?: boolean; sentAt?: number; launchRequested?: boolean };
const newPane = (cwd = ''): Pane => ({ id: crypto.randomUUID(), agent: 'claude', cwd });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function labelOf(item: Item, items: ItemMap): string {
  const visited = new Set<string>();
  let parent = item.parentId ? items[item.parentId] : undefined;
  while (isLive(parent) && !visited.has(parent.id)) {
    if (parent.type === 'section') return parent.id;
    visited.add(parent.id);
    parent = parent.parentId ? items[parent.parentId] : undefined;
  }
  return '';
}

const mcpAvailable = bridge.mcpSupported;
function AgentSetup({ diagnostic }: { diagnostic: bridge.AgentDiagnostic }) {
  const [error, setError] = useState('');
  const claude = diagnostic.id === 'claude';
  const link = (title: string, url: string) => <a href={url} onClick={event => {
    event.preventDefault(); void bridge.openExternal(url).catch(failure => setError(message(failure)));
  }}>{title}<ExternalLink size={12} aria-hidden /></a>;
  return <div className="agent-setup-diagnostic">
    <strong className="agent-identity"><AgentLogo agent={diagnostic.id} />{diagnostic.name}</strong><small title={diagnostic.path ?? ''}>{diagnostic.path ?? '見つかりません'}{diagnostic.version ? ` · ${diagnostic.version}` : ''}</small>
    {!diagnostic.path ? <p role="alert">{diagnostic.name}が見つかりません。インストール後に診断を更新してください。</p> : diagnostic.problem ? <p role="alert">{diagnostic.problem}。インストール先を確認し、診断を更新してください。</p> : null}
    <div>{link('インストール', claude ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex/cli')}{link('認証', claude ? 'https://code.claude.com/docs/en/authentication' : 'https://developers.openai.com/codex/auth')}</div>
    <code>{claude ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'npm install -g @openai/codex'}</code>
    {claude ? <div className="agent-auth-commands"><code>claude</code><code>/login</code></div> : <code>codex login</code>}
    {error ? <p className="agent-error" role="alert">{error}</p> : null}
  </div>;
}

function ResumePicker({ pane, update, onReady }: { pane: Pane; update: (pane: Pane) => void; onReady: (ready: boolean) => void }) {
  const [sessions, setSessions] = useState<bridge.Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(async () => {
      if (!current) return;
      setSessions([]); setError(''); setLoading(false); onReady(false);
      if (!pane.cwd || !bridge.conversationsSupported) return;
      setLoading(true);
      const values = await bridge.conversations(pane.agent, pane.cwd);
      if (!current) return;
      const valid = values.filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id));
      setSessions(valid); onReady(valid.some(value => value.id === pane.resumeSessionId));
    }).catch(failure => { if (current) setError(message(failure)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [pane.agent, pane.cwd, pane.resumeSessionId, refresh, onReady]);
  return <div className="agent-resume-picker">
    <select aria-label="CLIセッション" value={pane.resumeSessionId ?? ''} onChange={event => update({ ...pane, resumeSessionId: event.target.value || undefined })}>
      <option value="">新しいセッション</option>
      {pane.resumeSessionId && !sessions.some(value => value.id === pane.resumeSessionId) ? <option value={pane.resumeSessionId} disabled>{loading ? '会話を確認中…' : '会話を利用できません'}</option> : null}
      {sessions.map(value => <option key={value.id} value={value.id}>{value.title || value.id}{Number.isFinite(value.updatedAt) ? ` · ${new Date(value.updatedAt).toLocaleDateString()}` : ''}</option>)}
    </select>
    <button type="button" className="icon-btn" title="会話履歴を更新" aria-label="会話履歴を更新" disabled={loading || !pane.cwd || !bridge.conversationsSupported} onClick={() => setRefresh(value => value + 1)}><RotateCcw size={14} /></button>
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
  </div>;
}
function AgentLauncher({ draft, items, available, checking, onRefresh, onLaunch, onClose }: {
  draft: Pane; items: ItemMap; available: bridge.AgentDiagnostic[]; checking: boolean; onRefresh: () => void; onLaunch: (pane: Pane) => string | null; onClose: () => void;
}) {
  const [agent, setAgent] = useState(draft.agent);
  const [cwd, setCwd] = useState(draft.cwd);
  const [label, setLabel] = useState(draft.assignment && items[draft.assignment.taskId] ? labelOf(items[draft.assignment.taskId], items) : draft.labelId ?? '');
  const [taskId, setTaskId] = useState(draft.assignment?.taskId ?? '');
  const [intent, setIntent] = useState<PaneAssignment['intent']>(draft.assignment?.intent ?? 'consult');
  const [error, setError] = useState('');
  const [choosingFolder, setChoosingFolder] = useState(false);
  const selectedAgent = available.find(value => value.id === agent);
  const agentUnavailable = !selectedAgent?.path || Boolean(selectedAgent.problem);
  const labels = Object.values(items).filter(item => isLive(item) && item.type === 'section').sort(compareItems);
  const tasks = Object.values(items).filter(item => isLive(item) && item.type === 'task' && !item.done && !item.filed && labelOf(item, items) === label).sort(compareItems);
  return <form className="agent-launcher" aria-label="エージェントを起動する" onSubmit={event => {
    event.preventDefault();
    const assignment = taskId ? { taskId, intent, mode: draft.assignment?.mode ?? (mcpAvailable ? 'mcp' : 'text') } as PaneAssignment : undefined;
    const failure = onLaunch({ ...draft, agent, cwd, labelId: label || undefined, assignment, resumeSessionId: undefined, launchRequested: true });
    if (failure) setError(failure);
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  }}>
    <div className="agent-launcher-head"><h2>エージェントを起動</h2><button type="button" className="icon-btn" title="閉じる" aria-label="起動設定を閉じる" onClick={onClose}><X size={15} /></button></div>
    <div className="agent-launcher-grid">
    <label className="agent-launcher-field" title={agent === 'claude' ? 'Claude Code' : 'Codex'}>
      <AgentLogo agent={agent} size={18} /><span className="agent-launcher-field-name">エージェント</span>
      <small>{agent === 'claude' ? 'Claude Code' : 'Codex'}</small>
      <select autoFocus aria-label="起動するエージェント" value={agent} onChange={event => setAgent(event.target.value as bridge.AgentId)}>
      <option value="claude">Claude Code</option><option value="codex">Codex</option>
    </select></label>
    <button type="button" className="agent-launcher-field agent-launcher-folder agent-folder-select" aria-label="作業フォルダを選択" title={cwd || 'フォルダを選択'} disabled={choosingFolder} onClick={async () => {
      setChoosingFolder(true);
      try { const value = await bridge.folder(); if (value) { setCwd(value); setError(''); } }
      catch (failure) { setError(message(failure)); }
      finally { setChoosingFolder(false); }
    }}><FolderOpen size={20} aria-hidden /><span className="agent-launcher-field-name">作業フォルダ</span><small>{choosingFolder ? '選択中…' : cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '未選択'}</small></button>
    {bridge.taskHandoffSupported ? <>
      <label className="agent-launcher-field" title={items[label]?.text || 'ラベルなし'}>
        <Tag size={20} aria-hidden /><span className="agent-launcher-field-name">ラベル</span>
        <small>{items[label]?.text || 'ラベルなし'}</small>
        <select aria-label="ラベル" value={label} onChange={event => { setLabel(event.target.value); setTaskId(''); }}>
        <option value="">ラベルなし</option>{labels.map(item => <option key={item.id} value={item.id}>{item.text || '（無題）'}</option>)}
      </select></label>
      <label className="agent-launcher-field" title={items[taskId]?.text || '担当なし'}>
        <ListTodo size={20} aria-hidden /><span className="agent-launcher-field-name">タスク<span className="agent-launcher-optional">（任意）</span></span>
        <small>{items[taskId]?.text || '担当なし'}</small>
        <select aria-label="担当タスク" value={taskId} onChange={event => setTaskId(event.target.value)}>
        <option value="">担当なし</option>{tasks.map(item => <option key={item.id} value={item.id}>{item.parentId && items[item.parentId]?.type === 'task' ? `${items[item.parentId].text} › ` : ''}{item.text || '（無題）'}</option>)}
      </select></label>
    </> : null}
    </div>
    {taskId && bridge.taskHandoffSupported ? <HandoffIntentControl intent={intent} onChange={setIntent} /> : null}
    {selectedAgent && agentUnavailable ? <><AgentSetup diagnostic={selectedAgent} /><button type="button" className="ghost-btn" disabled={checking} onClick={onRefresh}><RotateCcw size={14} />診断を更新</button></> : null}
    {error ? <p className="agent-error" role="alert">{error}</p> : null}
    <button type="submit" className="ghost-btn agent-launch-submit" disabled={!cwd || choosingFolder || checking || agentUnavailable || Boolean(taskId && !tasks.some(task => task.id === taskId))}><Play size={15} />起動する</button>
  </form>;
}
function TaskAssignmentPicker({ pane, items, onAssign, onClose }: { pane: Pane; items: ItemMap; onAssign: (value: PaneAssignment) => string | null; onClose: () => void }) {
  const [label, setLabel] = useState(pane.assignment && items[pane.assignment.taskId] ? labelOf(items[pane.assignment.taskId], items) : pane.labelId ?? '');
  const [taskId, setTaskId] = useState(pane.assignment?.taskId ?? '');
  const [intent, setIntent] = useState<PaneAssignment['intent']>(pane.assignment?.intent ?? 'consult');
  const [error, setError] = useState('');
  const labels = Object.values(items).filter(item => isLive(item) && item.type === 'section').sort(compareItems);
  const tasks = Object.values(items).filter(item => isLive(item) && item.type === 'task' && !item.done && !item.filed && labelOf(item, items) === label).sort(compareItems);
  return <div className="agent-task-picker" role="region" aria-label="担当タスクを選択">
    <select autoFocus aria-label="ラベル" value={label} onChange={event => { setLabel(event.target.value); setTaskId(''); setError(''); }}>
      <option value="">ラベルなし</option>{labels.map(item => <option key={item.id} value={item.id}>{item.text || '（無題）'}</option>)}
    </select>
    <select aria-label="担当タスク" value={taskId} onChange={event => { setTaskId(event.target.value); setError(''); }}>
      <option value="">タスクを選択</option>{tasks.map(item => <option key={item.id} value={item.id}>{item.parentId && items[item.parentId]?.type === 'task' ? `${items[item.parentId].text} › ` : ''}{item.text || '（無題）'}</option>)}
    </select>
    <HandoffIntentControl intent={intent} onChange={setIntent} />
    <div className="agent-assignment-actions"><button type="button" className="ghost-btn" disabled={!tasks.some(item => item.id === taskId)} onClick={() => {
      const failure = onAssign({ taskId, intent, mode: pane.assignment?.mode ?? (mcpAvailable ? 'mcp' : 'text') });
      if (failure) setError(failure); else onClose();
    }}><Link2 size={14} />割り当て</button><button type="button" className="icon-btn" title="閉じる" aria-label="タスク選択を閉じる" onClick={onClose}><X size={14} /></button></div>
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
  </div>;
}

function AgentPane({ pane, items, available, update, reportBusy, assign, close, hidden, zoomed, onZoom, onSelect, onStarted, fontSize }: {
  pane: Pane; items: ItemMap; available: bridge.AgentDiagnostic[]; update: (next: Pane) => void;
  reportBusy: (id: string, busy: boolean) => void; assign: (id: string | null, assignment: PaneAssignment) => string | null; close: () => void;
  hidden: boolean; zoomed: boolean; onZoom: () => void; onSelect: () => void; onStarted: (cwd: string) => void; fontSize: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const gpu = useRef<{ addon: WebglAddon; contextLoss: { dispose: () => void } } | null>(null);
  const alive = useRef(false);
  const mounted = useRef(true);
  const autoLaunched = useRef(false);
  const inspector = useContext(DesktopInspectorContext);
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'stopping' | 'exited'>('idle');
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [resumeReady, setResumeReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const busy = status === 'starting' || status === 'running' || status === 'stopping';
  const executable = available.find(agent => agent.id === pane.agent);
  const assigned = pane.assignment ? items[pane.assignment.taskId] : undefined;
  const task = isLive(assigned) && assigned.type === 'task' ? assigned : undefined;
  const canLaunch = pane.resumeSessionId ? resumeReady : !pane.assignment || Boolean(task && task.type === 'task' && !task.done && !task.filed);
  const children = task ? Object.values(items).filter(item => isLive(item) && item.type === 'task' && item.parentId === task.id) : [];
  const releaseGpu = () => {
    const renderer = gpu.current;
    gpu.current = null;
    if (renderer) { renderer.contextLoss.dispose(); renderer.addon.dispose(); }
  };
  const enableGpu = () => {
    releaseGpu();
    try {
      const addon = new WebglAddon();
      gpu.current = { addon, contextLoss: addon.onContextLoss(releaseGpu) };
      terminal.current!.loadAddon(addon);
    } catch { releaseGpu(); } // Keep DOM rendering when GPU rendering is unavailable.
  };
  useEffect(() => { reportBusy(pane.id, busy); }, [pane.id, busy, reportBusy]);

  useEffect(() => {
    mounted.current = true;
    const term = new Terminal({
      fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 3000, cursorBlink: false,
      theme: readTerminalTheme(), minimumContrastRatio: 4.5, allowProposedApi: true,
    });
    const addon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(addon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      void bridge.openExternal(uri).catch(failure => { if (mounted.current) setError(message(failure)); });
    }));
    term.open(host.current!);
    terminal.current = term;
    fit.current = addon;
    search.current = searchAddon;
    const results = searchAddon.onDidChangeResults(result => { if (mounted.current) setSearchResult(result); });
    term.attachCustomKeyEventHandler(event => {
      if (!event.isComposing && event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.type === 'keydown') { event.preventDefault(); setSearchOpen(true); }
        return false;
      }
      return true;
    });
    // Update the renderer palette without replacing the terminal or its PTY.
    const themeObserver = new MutationObserver(() => { term.options.theme = readTerminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let frame = 0;
    const resize = term.onResize(({ cols, rows }) => {
      if (alive.current) void bridge.resize(pane.id, cols, rows).catch(e => {
        if (mounted.current && alive.current) setError(message(e));
      });
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        addon.fit();
      });
    });
    observer.observe(host.current!);
    const validation = validateTerminalInput(term, host.current!);
    const input = term.onData(data => {
      if (alive.current) validation.input(data);
      if (alive.current) void bridge.write(pane.id, data).catch(e => {
        if (mounted.current && alive.current) setError(message(e));
      });
    });
    return () => {
      mounted.current = false;
      alive.current = false;
      void bridge.stop(pane.id).catch(() => {});
      themeObserver.disconnect(); observer.disconnect(); cancelAnimationFrame(frame); resize.dispose(); input.dispose(); results.dispose(); validation.dispose(); releaseGpu(); term.dispose();
      terminal.current = null; fit.current = null; search.current = null;
    };
  }, [pane.id]);

  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.fontSize = fontSize;
    if (!hidden) fit.current?.fit();
  }, [fontSize, hidden]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const find = (value: string, previous = false) => {
    if (!value) { search.current?.clearDecorations(); terminal.current?.clearSelection(); setSearchResult(null); return; }
    const options = { decorations: { matchBackground: '#ffe07a', matchOverviewRuler: '#d99c00', activeMatchBackground: '#ffad66', activeMatchColorOverviewRuler: '#d96600' } };
    if (previous) search.current?.findPrevious(value, options);
    else search.current?.findNext(value, options);
  };
  const closeSearch = () => { setSearchOpen(false); search.current?.clearDecorations(); terminal.current?.focus(); };

  const launch = async () => {
    if (busy || !canLaunch || !pane.cwd || !executable?.path || executable.problem) return;
    const handoff = !pane.resumeSessionId && pane.assignment && task ? { ...pane.assignment, prompt: buildTaskHandoff(task, items, pane.assignment.mode, pane.assignment.intent) } : undefined;
    if (handoff && !confirm(`「${task!.text || '（無題）'}」を${executable.name}へ渡して${handoff.intent === 'consult' ? '検討' : '実行'}を開始しますか？\n${handoff.mode === 'mcp' ? '同じアカウント・環境のbizencore MCP接続が必要です。' : '現在の内容を送信します。進捗は自動反映できません。'}`)) return;
    setError(''); setStatus('starting');
    fit.current?.fit();
    const term = terminal.current!;
    term.reset();
    enableGpu();
    let exited = false;
    try {
      await bridge.start(pane.id, pane.agent, pane.cwd, term.cols, term.rows, event => {
        if (!mounted.current) return;
        if (event.kind === 'data') term.write(new Uint8Array(event.bytes), () => {
          if (mounted.current && event.sequence !== undefined && event.streamId) {
            void bridge.acknowledgeOutput(pane.id, event.streamId, event.sequence).catch(e => {
              if (mounted.current && alive.current) setError(message(e));
            });
          }
        });
        else {
          exited = true;
          alive.current = false;
          setStatus('exited');
          releaseGpu();
          term.writeln(`\r\n[終了: ${event.code ?? '停止'}]`);
        }
      }, handoff, pane.resumeSessionId);
      if (!mounted.current) { await bridge.stop(pane.id); return; }
      onStarted(pane.cwd);
      if (handoff) update({ ...pane, busy: !exited, sentAt: Date.now() });
      if (!exited) { alive.current = true; setStatus('running'); term.focus(); }
    } catch (e) {
      if (mounted.current) { releaseGpu(); setError(message(e)); setStatus('idle'); }
    }
  };
  const halt = async () => {
    if (!confirm('このエージェントを停止しますか？実行中の処理も終了します。')) return;
    setStatus('stopping');
    try { await bridge.stop(pane.id); }
    catch (e) { setError(message(e)); setStatus('running'); }
  };

  useEffect(() => {
    if (pane.launchRequested && !autoLaunched.current) { autoLaunched.current = true; void launch(); }
  }, [pane.launchRequested, launch]);

  return <section id={`pane-${pane.id}`} tabIndex={-1} className={`agent-pane${status === 'idle' ? ' is-idle' : ''}`} hidden={hidden} onFocusCapture={onSelect} onPointerDown={onSelect} aria-label={`${executable?.name ?? pane.agent}ペイン`}>
    <header className="agent-pane-head">
      <div className="agent-identity"><AgentLogo agent={pane.agent} />
      <select aria-label="エージェント" value={pane.agent} disabled={busy} onChange={e => { setResumeReady(false); update({ ...pane, agent: e.target.value as bridge.AgentId, resumeSessionId: undefined }); }}>
        <option value="claude">Claude Code</option><option value="codex">Codex</option>
      </select></div>
      <span className={`agent-status agent-status-${status}`} title={{ idle: '未起動', starting: '起動中', running: '実行中', stopping: '停止中', exited: '終了' }[status]} />
      <button type="button" className="icon-btn" disabled={busy} title={pane.cwd || '作業フォルダを選択'} aria-label="作業フォルダを選択" onClick={async () => {
        try { const cwd = await bridge.folder(); if (cwd && typeof cwd === 'string' && cwd !== pane.cwd) { setResumeReady(false); update({ ...pane, cwd, resumeSessionId: undefined }); } }
        catch (e) { setError(message(e)); }
      }}><FolderOpen size={15} /></button>
      <span className="agent-cwd" title={pane.cwd}>{pane.cwd.split('/').filter(Boolean).at(-1) || 'フォルダ未選択'}</span>
      {bridge.taskHandoffSupported ? <button type="button" className="icon-btn" disabled={busy} title="担当タスクを選択" aria-label="担当タスクを選択" aria-expanded={pickerOpen} onClick={() => setPickerOpen(value => !value)}><Link2 size={14} /></button> : null}
      <button type="button" className="icon-btn" disabled={busy ? status !== 'running' : !canLaunch || !pane.cwd || !executable?.path || Boolean(executable.problem)} title={busy ? '停止' : pane.resumeSessionId ? '会話を再開' : pane.assignment ? 'タスクを渡して起動' : '新しいセッションを起動'} aria-label={busy ? 'エージェントを停止' : 'エージェントを起動'} onClick={() => void (busy ? halt() : launch())}>
        {busy ? <Square size={14} /> : status === 'exited' ? <RotateCcw size={15} /> : <Play size={15} />}
      </button>
      <button type="button" className="icon-btn" title={zoomed ? '全ペインを表示' : 'このペインを拡大'} aria-label="ペインを拡大・縮小" aria-pressed={zoomed} onClick={onZoom}>{zoomed ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button type="button" className="icon-btn" disabled={status === 'starting' || status === 'stopping'} title="ペインを閉じる" aria-label="ペインを閉じる" onClick={() => {
        if (!alive.current || confirm('実行中のエージェントを停止してペインを閉じますか？')) close();
      }}><X size={15} /></button>
    </header>
    {!busy ? <ResumePicker pane={pane} update={update} onReady={setResumeReady} /> : null}
    {pickerOpen && !busy ? <TaskAssignmentPicker pane={pane} items={items} onAssign={value => assign(pane.id, value)} onClose={() => setPickerOpen(false)} /> : null}
    {pane.assignment ? <AgentTaskAssignment taskId={pane.assignment.taskId} items={items} onOpenTask={inspector?.openTask}
      onRemove={() => update({ ...pane, assignment: undefined, sentAt: undefined })} removeDisabled={busy}
      summary={`${pane.assignment.intent === 'consult' ? '検討' : '実行'} · ${pane.assignment.mode === 'mcp' ? 'MCP' : '内容のみ'} · ${task?.done ? '完了' : task?.locked ? '常設' : pane.sentAt ? '送信済み' : '未送信'}${children.length ? ` · サブタスク ${children.filter(item => item.done).length}/${children.length}` : ''}`} /> : null}
    {executable && (!executable.path || executable.problem) ? <AgentSetup diagnostic={executable} /> : null}
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
    {status !== 'idle' ? <div className="agent-terminal-tools"><button type="button" className="icon-btn" title="ターミナルを検索" aria-label="ターミナルを検索" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Search size={14} /></button></div> : null}
    {searchOpen ? <form className="agent-terminal-search" role="search" onSubmit={event => { event.preventDefault(); find(query); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
      if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); find(query, true); }
    }}>
      <input ref={searchInput} aria-label="ターミナル出力を検索" value={query} onChange={event => { setQuery(event.target.value); find(event.target.value); }} />
      <small role="status">{searchResult ? `${Math.max(0, searchResult.resultIndex + 1)}/${searchResult.resultCount}` : ''}</small>
      <button type="button" className="icon-btn" title="前の一致" aria-label="前の一致" disabled={!query} onClick={() => find(query, true)}><ArrowUp size={14} /></button>
      <button type="submit" className="icon-btn" title="次の一致" aria-label="次の一致" disabled={!query}><ArrowDown size={14} /></button>
      <button type="button" className="icon-btn" title="検索を閉じる" aria-label="検索を閉じる" onClick={closeSearch}><X size={14} /></button>
    </form> : null}
    <div className="agent-terminal" ref={host} />
  </section>;
}

export function AgentWorkspace({ children }: { children: ReactNode }) {
  const location = useLocation();
  const taskScroll = location.pathname === '/';
  const { items } = useTaskState();
  const account = useContext(DesktopWorkspaceAccount);
  const storageKey = account ? workspaceKey(account, import.meta.env.VITE_CONVEX_URL ?? 'unconfigured') : null;
  const preferenceKey = account ? uiPrefsKey(account, import.meta.env.VITE_CONVEX_URL ?? 'unconfigured') : null;
  const [prefs, setPrefs] = useState<UiPrefs>(() => preferenceKey ? readUiPrefs(preferenceKey) : { ...defaultUiPrefs });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const layoutPopover = useRef<HTMLDivElement>(null);
  const [prefsError, setPrefsError] = useState(false);
  const changePrefs = (next: UiPrefs) => {
    setPrefs(next);
    if (preferenceKey) setPrefsError(!writeUiPrefs(preferenceKey, next));
  };
  const [restored] = useState(() => storageKey ? readWorkspace(storageKey) : null);
  const [lastCwd, setLastCwd] = useState(restored?.lastCwd ?? '');
  const [panes, setPanes] = useState<Pane[]>(() => restored?.panes ?? []);
  const [draft, setDraft] = useState<Pane | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsIntent, setToolsIntent] = useState<ToolsIntent>({ mode: 'execute', ids: [], serial: 0 });
  const openTools = (mode: ToolsIntent['mode'], ids: string[]) => {
    if (!toolsBusy) setToolsIntent(value => ({ mode, ids, serial: value.serial + 1 }));
    setToolsOpen(true); setDraft(null); setExpanded(false);
  };
  const [layout, setLayout] = useState<'grid' | 'tabs'>(restored?.layout ?? 'grid');
  const [activeId, setActiveId] = useState<string | null>(restored?.panes[0]?.id ?? null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const selectedId = panes.some(pane => pane.id === activeId) ? activeId : panes[0]?.id ?? null;
  const collapsed = panes.length === 0 && !draft && !toolsOpen;
  const [available, setAvailable] = useState<bridge.AgentDiagnostic[]>([]);
  const [checkingAgents, setCheckingAgents] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(restored?.expanded ?? false);
  const showTasks = useCallback(() => setExpanded(false), []);
  const [width, setWidth] = useState(restored?.width ?? 46);
  const [height, setHeight] = useState(restored?.height ?? 50);
  const [orientation, setOrientation] = useState<WorkspaceState['orientation']>(restored?.orientation ?? 'columns');
  const stacked = orientation === 'rows';
  const [setupWidth, setSetupWidth] = useState(400);
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(restored?.inspectorWidth ?? 340);
  const [storageError, setStorageError] = useState(false);
  const snapshot = useRef<WorkspaceState>({ version: 1, panes, width, height, orientation, inspectorWidth, expanded, layout, lastCwd });
  useEffect(() => { snapshot.current = { version: 1, panes, width, height, orientation, inspectorWidth, expanded, layout, lastCwd }; }, [panes, width, height, orientation, inspectorWidth, expanded, layout, lastCwd]);
  useEffect(() => {
    if (!storageKey) return;
    const timer = setTimeout(() => setStorageError(!writeWorkspace(storageKey, snapshot.current)), 150);
    return () => clearTimeout(timer);
  }, [storageKey, panes, width, height, orientation, inspectorWidth, expanded, layout, lastCwd]);
  useEffect(() => {
    if (!storageKey) return;
    const flush = () => { writeWorkspace(storageKey, snapshot.current); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [storageKey]);
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [compactTasks, setCompactTasks] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const taskContainer = useRef<HTMLDivElement>(null);
  const taskScroller = useRef<HTMLDivElement>(null);
  const maxInspectorWidth = Math.min(460, Math.max(280, workspaceWidth - (stacked ? 270 : collapsed ? 326 : 556)));
  const visibleInspectorWidth = Math.min(inspectorWidth, maxInspectorWidth);
  const resizingSetup = Boolean(!stacked && draft && !panes.length && !inspectorOpen);
  const maxSetupWidth = Math.max(280, workspaceWidth - 356);
  const visibleSetupWidth = Math.min(setupWidth, maxSetupWidth);
  const showInspector = useCallback((open: boolean) => {
    setInspectorOpen(open);
    if (open) setExpanded(false);
  }, []);
  const [taskOpener, setTaskOpener] = useState<((id: string) => void) | null>(null);
  const registerTaskOpener = useCallback((opener: ((id: string) => void) | null) => setTaskOpener(() => opener), []);
  const panesRef = useRef(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);
  const previousAssigned = useRef<Parameters<typeof completedAssignments>[0]>([]);
  useEffect(() => {
    const current = panes.flatMap(pane => {
      const task = pane.assignment ? items[pane.assignment.taskId] : undefined;
      return isLive(task) && task.type === 'task' ? [{ paneId: pane.id, taskId: task.id, title: task.text || '（無題）', done: task.done === true }] : [];
    });
    const completed = completedAssignments(previousAssigned.current, current);
    previousAssigned.current = current;
    if (!account || !prefs.completionNotifications || !bridge.notificationsSupported) return;
    for (const task of completed) void bridge.notify({ paneId: task.paneId, title: 'タスク完了', body: task.title }).catch(failure => setError(message(failure)));
  }, [items, panes, account, prefs.completionNotifications]);
  useEffect(() => bridge.onFocusPane(id => {
    if (!panesRef.current.some(pane => pane.id === id)) return;
    setDraft(null); setActiveId(id); setZoomId(value => value ? id : null);
    setFocusRequest(id);
  }), []);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const pane = document.getElementById(`pane-${focusRequest}`);
      (pane?.classList.contains('is-idle') ? pane : pane?.querySelector<HTMLElement>('.xterm-helper-textarea') ?? pane)?.focus();
      setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, selectedId]);
  const reportBusy = useCallback((id: string, busy: boolean) => setPanes(values => values.map(pane => pane.id === id && pane.busy !== busy ? { ...pane, busy } : pane)), []);
  const assign = (id: string | null, assignment: PaneAssignment) => {
    if (toolsBusy) return 'オーケストレーション・分解を停止してから割り当ててください';
    const current = panesRef.current;
    const task = items[assignment.taskId];
    if (!isLive(task) || task.type !== 'task' || task.done || task.filed) return '未完了のタスクを選択してください';
    if (assignment.mode === 'mcp' && !mcpAvailable) return 'このデスクトップではMCP接続を利用できません';
    if (current.some(pane => pane.id !== id && pane.assignment?.taskId === task.id)) return 'このタスクは別のペインに割り当て済みです';
    const target = id === null ? newPane(lastCwd) : current.find(pane => pane.id === id);
    if (!target || target.busy || (id === null && current.length >= 8)) return '停止中のペインを選択してください';
    const next = { ...target, assignment, labelId: labelOf(task, items) || undefined, sentAt: undefined, resumeSessionId: undefined };
    if (id === null) { setDraft(next); setExpanded(false); return null; }
    const values = current.map(pane => pane.id === id ? next : pane);
    panesRef.current = values;
    setPanes(values); setActiveId(id); if (zoomId) setZoomId(id); setExpanded(false);
    return null;
  };
  const createAgent = (next: Pane) => {
    if (toolsBusy) return 'オーケストレーション・分解を停止してから起動してください';
    const current = panesRef.current;
    if (current.length >= 8) return 'エージェントは8件まで起動できます';
    const executable = available.find(agent => agent.id === next.agent);
    if (!next.cwd || !executable?.path || executable.problem) return 'エージェント診断と作業フォルダを確認してください';
    if (next.assignment) {
      const task = items[next.assignment.taskId];
      if (!isLive(task) || task.type !== 'task' || task.done || task.filed) return '未完了のタスクを選択してください';
      if (current.some(pane => pane.assignment?.taskId === task.id)) return 'このタスクは別のペインに割り当て済みです';
    }
    panesRef.current = [...current, next];
    setPanes(panesRef.current); setActiveId(next.id); setZoomId(null); setDraft(null); setExpanded(false);
    return null;
  };
  const moveSelected = (direction: -1 | 1) => setPanes(values => {
    const index = values.findIndex(pane => pane.id === selectedId), target = index + direction;
    if (index < 0 || target < 0 || target >= values.length) return values;
    const next = [...values]; [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const checkAgents = useCallback(async () => {
    setCheckingAgents(true);
    try { setAvailable(await bridge.agentDiagnostics()); setError(''); }
    catch (failure) { setError(message(failure)); }
    finally { setCheckingAgents(false); }
  }, [setCheckingAgents, setAvailable, setError]);
  useEffect(() => {
    if (bridge.nativeDesktop) void bridge.agentDiagnostics().then(setAvailable).catch(failure => setError(message(failure)));
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === container.current) setWorkspaceWidth(entry.contentRect.width);
        else setCompactTasks(entry.contentRect.width < 440);
      }
    });
    observer.observe(container.current!);
    observer.observe(taskContainer.current!);
    return () => observer.disconnect();
  }, []);

  return <DesktopHandoffContext.Provider value={bridge.taskHandoffSupported ? {
    mcpAvailable,
    openTools: bridge.taskToolsSupported ? openTools : undefined,
    panes: panes.map((pane, index) => ({ id: pane.id, name: `${index + 1}: ${pane.agent === 'claude' ? 'Claude Code' : 'Codex'}${pane.assignment ? ` · ${items[pane.assignment.taskId]?.text || '（不明）'}` : ''}`, busy: Boolean(pane.busy), taskId: pane.assignment?.taskId })), assign,
  } : null}><DesktopInspectorContext.Provider value={{ host: inspectorHost, open: inspectorOpen, setOpen: showInspector, registerTaskOpener, openTask: taskOpener ?? undefined }}><DesktopHeaderContext.Provider value={{ host: headerHost, showTasks }}>
  <div className="desktop-shell">
  <div className="desktop-header" ref={setHeaderHost} />
  <div ref={container} data-orientation={orientation} className={`desktop-workspace${expanded && (panes.length || toolsOpen) ? ' is-expanded' : ''}${inspectorOpen ? ' has-inspector' : ''}${collapsed ? ' agents-collapsed' : ''}${draft && !panes.length ? ' agents-setup' : ''}`} style={{
    '--task-fraction': `${width}fr`, '--agent-fraction': `${100 - width}fr`, '--inspector-width': `${visibleInspectorWidth}px`,
    '--task-height-fraction': `${height}fr`, '--agent-height-fraction': `${100 - height}fr`,
    '--setup-width': `${visibleSetupWidth}px`,
  } as React.CSSProperties}>
    <div ref={taskContainer} className={`desktop-task-column${taskScroll ? ' has-scroll-rail' : ''}`}>
      <div ref={taskScroller} id="desktop-task-scroll-content" className={`desktop-tasks${compactTasks ? ' is-compact' : ''}`}>{children}</div>
      {taskScroll ? <TaskScrollRail container={taskScroller} controls="desktop-task-scroll-content" /> : null}
    </div>
    <div role="separator" aria-label={stacked ? 'タスク画面の高さ' : resizingSetup ? 'エージェント選択画面の幅' : 'タスク画面の幅'} aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={resizingSetup ? 280 : 30} aria-valuemax={stacked ? 70 : resizingSetup ? maxSetupWidth : 65} aria-valuenow={stacked ? height : resizingSetup ? visibleSetupWidth : width} tabIndex={0}
      className="desktop-divider desktop-task-divider" onKeyDown={e => {
        if (stacked && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault(); setHeight(value => Math.max(30, Math.min(70, value + (e.key === 'ArrowUp' ? -2 : 2))));
        } else if (!stacked && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          if (resizingSetup) setSetupWidth(Math.max(280, Math.min(maxSetupWidth, visibleSetupWidth + (e.key === 'ArrowLeft' ? 16 : -16))));
          else setWidth(value => Math.max(30, Math.min(65, value + (e.key === 'ArrowLeft' ? -2 : 2))));
        }
      }} onPointerDown={e => {
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const rect = container.current!.getBoundingClientRect();
        if (stacked) {
          setHeight(Math.max(30, Math.min(70, (e.clientY - rect.top) / Math.max(1, rect.height - 6) * 100)));
          return;
        }
        if (resizingSetup) {
          setSetupWidth(Math.max(280, Math.min(maxSetupWidth, rect.right - e.clientX - 6)));
          return;
        }
        const availableWidth = Math.max(1, rect.width - (inspectorOpen ? visibleInspectorWidth + 12 : 6));
        setWidth(Math.max(30, Math.min(65, (e.clientX - rect.left) / availableWidth * 100)));
      }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />
    <div className="desktop-inspector" ref={setInspectorHost} hidden={!inspectorOpen} />
    <div role="separator" aria-label="詳細パネルの幅" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxInspectorWidth} aria-valuenow={visibleInspectorWidth} tabIndex={0}
      hidden={!inspectorOpen} className="desktop-divider desktop-inspector-divider" onKeyDown={e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault(); setInspectorWidth(Math.max(280, Math.min(maxInspectorWidth, visibleInspectorWidth + (e.key === 'ArrowLeft' ? -16 : 16) * (stacked && !expanded ? -1 : 1))));
        }
      }} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId) || !inspectorHost) return;
        const inspectorRect = inspectorHost.getBoundingClientRect();
        setInspectorWidth(Math.max(280, Math.min(maxInspectorWidth, stacked && !expanded ? inspectorRect.right - e.clientX : e.clientX - inspectorRect.left)));
      }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />
    <aside className="desktop-agents" aria-label="エージェント" onKeyDown={event => event.stopPropagation()}>
      <header className="agent-toolbar"><span className="agent-toolbar-name"><Bot size={16} /><span><span className="agent-toolbar-label">agents </span><small>{toolsBusy ? 1 : panes.length}/8</small></span></span>
        {panes.length > 0 && !toolsOpen ? <div className="agent-navigation" role="tablist" aria-label="エージェントペイン">{panes.map((pane, index) => <button key={pane.id} id={`pane-tab-${pane.id}`} type="button" role="tab" aria-selected={selectedId === pane.id} aria-controls={`pane-${pane.id}`} tabIndex={selectedId === pane.id ? 0 : -1} title={`${pane.agent === 'claude' ? 'Claude Code' : 'Codex'}${pane.assignment ? ` · ${items[pane.assignment.taskId]?.text || '（無題）'}` : ''}`} onClick={() => { setActiveId(pane.id); if (zoomId) setZoomId(pane.id); }} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + panes.length) % panes.length;
          setActiveId(panes[target].id); if (zoomId) setZoomId(panes[target].id);
          document.getElementById(`pane-tab-${panes[target].id}`)?.focus();
        }}><AgentLogo agent={pane.agent} size={12} />{index + 1}<span className={pane.busy ? 'is-running' : ''} /></button>)}</div> : null}
        <div className="agent-toolbar-actions">
          <button type="button" className="icon-btn agent-layout-trigger" title="配置" aria-label="配置" popoverTarget="agent-layout-options"><PanelsTopLeft size={16} /></button>
          <div ref={layoutPopover} id="agent-layout-options" className="agent-layout-popover" popover="auto">
            <div role="group" aria-label="画面の分割方向">
              <button type="button" aria-label={stacked ? '左右分割に切り替え' : '左右分割'} aria-pressed={!stacked} onClick={() => { setOrientation('columns'); layoutPopover.current?.hidePopover(); }}><Columns2 size={15} />左右分割</button>
              <button type="button" aria-label={stacked ? '上下分割' : '上下分割に切り替え'} aria-pressed={stacked} onClick={() => { setOrientation('rows'); layoutPopover.current?.hidePopover(); }}><Rows2 size={15} />上下分割</button>
            </div>
            {panes.length > 0 ? <div role="group" aria-label="ペインの表示方法">
              <button type="button" aria-label="並列表示" aria-pressed={layout === 'grid' && !zoomId} onClick={() => { setLayout('grid'); setZoomId(null); layoutPopover.current?.hidePopover(); }}><Columns2 size={15} />並列表示</button>
              <button type="button" aria-label="タブ表示" aria-pressed={layout === 'tabs' || Boolean(zoomId)} onClick={() => { setLayout('tabs'); setZoomId(null); layoutPopover.current?.hidePopover(); }}><PanelsTopLeft size={15} />タブ表示</button>
            </div> : null}
            {panes.length > 1 && !toolsOpen ? <div role="group" aria-label="ペインの順序">
              <button type="button" aria-label="選択ペインを前へ" disabled={selectedId === panes[0]?.id} onClick={() => { moveSelected(-1); layoutPopover.current?.hidePopover(); }}><ArrowLeft size={14} />前へ</button>
              <button type="button" aria-label="選択ペインを後ろへ" disabled={selectedId === panes.at(-1)?.id} onClick={() => { moveSelected(1); layoutPopover.current?.hidePopover(); }}><ArrowRight size={14} />後ろへ</button>
            </div> : null}
          </div>
          {bridge.taskToolsSupported ? <button type="button" className="icon-btn" title="オーケストレーション・タスクベース分解" aria-label="作業ツールを開く" aria-expanded={toolsOpen} onClick={() => { setToolsOpen(value => !value); setDraft(null); setExpanded(false); }}><ListTodo size={16} /></button> : null}
          <button type="button" className="icon-btn" title="ターミナル設定" aria-label="ターミナル設定" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={16} /></button>
          {panes.length || toolsOpen ? <button type="button" className="icon-btn" title={expanded ? 'タスク画面を表示' : 'エージェント画面を拡大'} aria-label="エージェント画面を拡大・縮小" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button> : null}
          <button type="button" className="icon-btn" title="エージェントを追加" aria-label="エージェントを追加" disabled={panes.length >= 8 || toolsBusy} onClick={() => { setToolsOpen(false); setDraft(newPane(lastCwd)); setExpanded(false); }}><Plus size={17} /></button>
        </div>
      </header>
      {storageKey ? <TaskTools key={storageKey} storageKey={`${storageKey}.task-tools.v1`} available={available} cwd={lastCwd} busy={panes.some(pane => pane.busy)} intent={toolsIntent} hidden={!toolsOpen} onClose={() => setToolsOpen(false)} onCwd={setLastCwd} onBusy={setToolsBusy} onOpenTask={taskOpener ?? undefined} fontSize={prefs.terminalFontSize} /> : null}
      {settingsOpen ? <div className="agent-settings" role="region" aria-label="ターミナル設定" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setSettingsOpen(false); }
      }}>
        <div className="agent-settings-font"><span>ターミナルの文字サイズ</span><button type="button" className="icon-btn" title="ターミナルの文字を小さく" aria-label="文字を小さく" disabled={prefs.terminalFontSize <= 10} onClick={() => changePrefs({ ...prefs, terminalFontSize: prefs.terminalFontSize - 1 })}><Minus size={14} /></button><output aria-label="ターミナル文字サイズ">{prefs.terminalFontSize} px</output><button type="button" className="icon-btn" title="ターミナルの文字を大きく" aria-label="文字を大きく" disabled={prefs.terminalFontSize >= 24} onClick={() => changePrefs({ ...prefs, terminalFontSize: prefs.terminalFontSize + 1 })}><Plus size={14} /></button></div>
        <label><input type="checkbox" checked={prefs.completionNotifications} disabled={!account || !bridge.notificationsSupported} onChange={event => changePrefs({ ...prefs, completionNotifications: event.target.checked })} />担当タスクの完了を通知</label>
        <details><summary>エージェント診断</summary><button type="button" className="icon-btn" title="診断を更新" aria-label="診断を更新" disabled={checkingAgents} onClick={() => void checkAgents()}><RotateCcw size={14} /></button>{available.map(agent => <AgentSetup key={agent.id} diagnostic={agent} />)}</details>
        {prefsError ? <p className="agent-error" role="alert">設定を保存できませんでした。</p> : null}
      </div> : null}
      {draft ? <div className="agent-launcher-stage"><AgentLauncher key={draft.id} draft={draft} items={items} available={available} checking={checkingAgents} onRefresh={() => void checkAgents()} onLaunch={createAgent} onClose={() => setDraft(null)} /></div> : null}
      {!bridge.nativeDesktop ? <p className="agent-error" role="status">エージェントの起動はデスクトップアプリで利用できます。</p> : null}
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
      {storageError ? <p className="agent-error" role="alert">ペインの配置を保存できませんでした。</p> : null}
      <div className={`agent-grid${layout === 'tabs' || zoomId ? ' is-single' : ''}`} data-count={panes.length}>
        {panes.map(pane => <AgentPane key={pane.id} pane={pane} items={items} available={available} reportBusy={reportBusy} assign={assign} onStarted={setLastCwd} fontSize={prefs.terminalFontSize}
          hidden={(layout === 'tabs' || Boolean(zoomId)) && pane.id !== selectedId} zoomed={zoomId === pane.id}
          onSelect={() => setActiveId(pane.id)} onZoom={() => { setActiveId(pane.id); setZoomId(value => value === pane.id ? null : pane.id); }}
          update={next => setPanes(values => values.map(value => value.id === next.id ? next : value))}
          close={() => { if (zoomId === pane.id) setZoomId(null); setPanes(values => values.filter(value => value.id !== pane.id)); }} />)}
      </div>
    </aside>
  </div></div></DesktopHeaderContext.Provider></DesktopInspectorContext.Provider></DesktopHandoffContext.Provider>;
}
