import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Play, Search, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import * as bridge from './bridge';
import { readTerminalTheme } from './terminal-theme';
import type { WorkReply, WorkRequest } from '../src/lib/taskTools';
import { useTaskState } from '../src/lib/taskStore';
import { AgentTaskAssignment } from './AgentTaskAssignment';
import { AgentLogo } from './AgentLogo';

export type TerminalJob = {
  request: WorkRequest; title: string; automatic: boolean; controller: AbortController;
  settle: (reply?: WorkReply, error?: unknown) => void;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function OrchestrationTerminal({ job, fontSize = 13, onOpenTask }: { job: TerminalJob | null; fontSize?: number; onOpenTask?: (id: string) => void }) {
  const { items } = useTaskState();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const live = useRef<string | null>(null);
  const current = useRef(job);
  const held = useRef(false);
  const reviewing = useRef(false);
  const finishing = useRef(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState('未起動');
  const [hold, setHold] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<bridge.AgentId>('claude');
  const title = agent === 'codex' ? 'Codex' : 'Claude Code';
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => { current.current = job; }, [job]);

  useEffect(() => {
    const terminal = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 3000,
      cursorBlink: false, theme: readTerminalTheme(), minimumContrastRatio: 4.5, screenReaderMode: true });
    const fitter = new FitAddon();
    const finder = new SearchAddon();
    terminal.loadAddon(fitter); terminal.loadAddon(finder);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => { void bridge.openExternal(uri).catch(failure => setError(message(failure))); }));
    terminal.open(host.current!); term.current = terminal; fit.current = fitter; search.current = finder;
    terminal.attachCustomKeyEventHandler(event => {
      if (!event.isComposing && event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.type === 'keydown') { event.preventDefault(); setSearchOpen(true); }
        return false;
      }
      return true;
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitter.fit());
    });
    observer.observe(host.current!);
    const theme = new MutationObserver(() => { terminal.options.theme = readTerminalTheme(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const intervene = () => { if (live.current && current.current) { held.current = true; setHold(true); } };
    const element = host.current!;
    // xterm consumes some keys (including Enter) before they can bubble.
    element.addEventListener('keydown', intervene, true);
    element.addEventListener('paste', intervene, true);
    element.addEventListener('compositionstart', intervene, true);
    const input = terminal.onData(data => {
      if (!live.current || !current.current || finishing.current) return;
      // Terminal protocol replies are input too, but are not human intervention.
      void bridge.write(live.current, data).catch(failure => setError(message(failure)));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (live.current) void bridge.resize(live.current, cols, rows).catch(failure => setError(message(failure)));
    });
    return () => {
      observer.disconnect(); theme.disconnect(); cancelAnimationFrame(frame); input.dispose(); resize.dispose();
      element.removeEventListener('keydown', intervene, true); element.removeEventListener('paste', intervene, true); element.removeEventListener('compositionstart', intervene, true);
      if (live.current) void bridge.stop(live.current).catch(() => {});
      terminal.dispose(); term.current = null; fit.current = null; search.current = null;
    };
  }, []);
  useEffect(() => { if (term.current) { term.current.options.fontSize = fontSize; fit.current?.fit(); } }, [fontSize]);

  const advance = useCallback(async (run: TerminalJob, automatic: boolean) => {
    if (reviewing.current || finishing.current || run.controller.signal.aborted || current.current !== run) return;
    reviewing.current = true; setChecking(true); setError('');
    try {
      const reply = await bridge.taskReview(run.request.id);
      if (run.controller.signal.aborted || current.current !== run || (automatic && held.current)) return;
      if (automatic && !reply.taskDone) return;
      if (!automatic && !confirm(reply.taskDone
        ? 'MCPで完了を確認しました。このCLIを終了し、次のタスクへ進みますか？'
        : 'MCPではまだ完了していません。このCLIを終了し、未完了のまま次のタスクへ進みますか？')) return;
      finishing.current = true; setStatus('停止中');
      // Wait for the owned process tree to stop before another CLI can launch.
      await bridge.stop(run.request.id);
      live.current = null;
      if (run.controller.signal.aborted || current.current !== run) return;
      setStatus(reply.taskDone ? '完了確認済み' : '残作業あり'); run.settle(reply);
    } catch (failure) {
      if (run.controller.signal.aborted || current.current !== run) return;
      held.current = true; setHold(true); setError(message(failure));
    } finally { reviewing.current = false; finishing.current = false; setChecking(false); }
  }, []);

  useEffect(() => {
    if (!job) return;
    const run = job;
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    held.current = false; finishing.current = false;
    const abort = () => {
      live.current = null;
      void bridge.stop(run.request.id).then(() => {
        if (!disposed) setStatus('中断');
        run.settle(undefined, Error('実行を停止しました。変更済みの内容は取り消されません'));
      }).catch(failure => run.settle(undefined, failure));
    };
    const cleanup = () => {
      disposed = true; clearTimeout(poll); run.controller.signal.removeEventListener('abort', abort);
      live.current = null; void bridge.stop(run.request.id).catch(() => {});
    };
    run.controller.signal.addEventListener('abort', abort, { once: true });
    if (run.controller.signal.aborted) { abort(); return cleanup; }
    void (async () => {
      setStarted(true); setHold(false); setError(''); setStatus('起動中');
      setAgent(run.request.agent); setTaskId(run.request.taskId);
      fit.current?.fit();
      const terminal = term.current!;
      const plainTitle = Array.from(run.title, char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('');
      terminal.writeln(`\r\n[${run.request.agent === 'codex' ? 'Codex' : 'Claude Code'}: ${plainTitle}]\r\n`);
      let exited = false;
      live.current = run.request.id;
      await bridge.start(run.request.id, run.request.agent, run.request.cwd, terminal.cols, terminal.rows, event => {
        if (disposed) return;
        if (event.kind === 'data') terminal.write(new Uint8Array(event.bytes), () => {
          if (!disposed && event.sequence !== undefined && event.streamId) {
            void bridge.acknowledgeOutput(run.request.id, event.streamId, event.sequence).catch(failure => setError(message(failure)));
          }
        });
        else { exited = true; live.current = null; setStatus('CLI終了'); terminal.writeln(`\r\n[終了: ${event.code ?? '停止'}]`); }
      }, undefined, undefined, { taskId: run.request.taskId, reply: run.request.reply });
      if (disposed || run.controller.signal.aborted) { await bridge.stop(run.request.id); return; }
      if (!exited) { live.current = run.request.id; setStatus('作業中'); terminal.focus(); }
      const check = async () => {
        if (disposed || run.controller.signal.aborted || current.current !== run) return;
        if (run.automatic && !held.current) await advance(run, true);
        if (!disposed && !run.controller.signal.aborted && current.current === run) poll = setTimeout(() => void check(), 5000);
      };
      if (run.automatic) poll = setTimeout(() => void check(), 5000);
    })().catch(failure => { if (!disposed && !run.controller.signal.aborted) { setStatus('起動失敗'); setError(message(failure)); run.settle(undefined, failure); } });
    return cleanup;
  }, [job, advance]);

  return <section className="orchestration-terminal" hidden={!started && !job} aria-label="オーケストレーションのターミナル">
    <header><span className="agent-identity" title={title}><AgentLogo agent={agent} />{title}</span><small role="status">{status}{job?.automatic && hold ? ' · 自動移行を保留' : ''}</small>
      <button type="button" className="icon-btn" title="ターミナル内を検索" aria-label="ターミナル内を検索" onClick={() => setSearchOpen(value => !value)}><Search size={14} /></button></header>
    {taskId ? <AgentTaskAssignment taskId={taskId} items={items} onOpenTask={onOpenTask} /> : null}
    {searchOpen ? <div className="agent-search"><input autoFocus type="search" aria-label="オーケストレーションの出力を検索" value={query} onChange={event => { setQuery(event.target.value); if (event.target.value) search.current?.findNext(event.target.value); else search.current?.clearDecorations(); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) search.current?.findNext(query); if (event.key === 'Escape') { setSearchOpen(false); term.current?.focus(); } }} /><button type="button" className="icon-btn" title="検索を閉じる" aria-label="検索を閉じる" onClick={() => { setSearchOpen(false); search.current?.clearDecorations(); term.current?.focus(); }}><X size={14} /></button></div> : null}
    <div ref={host} className="orchestration-terminal-host" />
    {error ? <p className="agent-error" role="alert">{error}</p> : null}
    {job?.automatic && hold ? <button type="button" className="ghost-btn" disabled={checking} onClick={() => {
      if (!confirm('MCPで完了を確認できたら、このCLIを終了して次へ進む設定を再開しますか？')) return;
      held.current = false; setHold(false); setError('');
    }}><Play size={15} />自動移行を再開</button> : null}
    {job ? <button type="button" className="ghost-btn" disabled={checking} onClick={() => void advance(job, false)}><ArrowRight size={15} />完了を確認して次へ</button> : null}
  </section>;
}
