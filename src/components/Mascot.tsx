import { useAuth } from '@clerk/clerk-react';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import cirnoImg from '../assets/cirno.png';
import { AI_TARGETS, aiConversationLink, buildTaskHandoff, readHandoffPreferences, saveHandoffPreferences, type HandoffPreferences } from '../lib/aiHandoff';
import { isCloudConfigured } from '../lib/cloudConfig';
import { useDesktopHandoff } from '../lib/desktopHandoff';
import { isLive } from '../lib/taskModel';
import { taskStore, useTaskState } from '../lib/taskStore';
import type { HandoffIntent } from '../lib/taskWorkPrompt';
import { HandoffIntentControl } from './task/HandoffIntentControl';
import { MascotPortrait } from './MascotPortrait';

const AGENT_KEY = 'bizencore.mascotAgent';
type Panel = 'about' | 'settings' | { taskId: string } | null;
type Gesture = { pointerId: number; x: number; y: number; moved: boolean; row: HTMLElement | null };

function readAgent() {
    try {
        const saved = localStorage.getItem(AGENT_KEY);
        return AI_TARGETS.some(target => target.id === saved) ? saved! : 'codex';
    } catch { return 'codex'; }
}

function taskRowAt(x: number, y: number) {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.row--task[data-row-id]') ?? null;
    const item = taskStore.getState().items[row?.dataset.rowId ?? ''];
    return isLive(item) && item.type === 'task' ? row : null;
}

export function Mascot({ handoff = false }: { handoff?: boolean }) {
    return isCloudConfigured ? <CloudMascot handoff={handoff} /> : <MascotContent handoff={handoff} canUseMcp={false} />;
}

function CloudMascot({ handoff }: { handoff: boolean }) {
    const { userId, isSignedIn } = useAuth();
    return <MascotContent key={userId ?? 'signed-out'} handoff={handoff} canUseMcp={isSignedIn === true} />;
}

function MascotContent({ handoff, canUseMcp }: { handoff: boolean; canUseMcp: boolean }) {
    const desktop = useDesktopHandoff();
    const mcpEnabled = canUseMcp && desktop?.mcpAvailable !== false;
    const { items } = useTaskState();
    const [panel, setPanel] = useState<Panel>(null);
    const [agent, setAgent] = useState(readAgent);
    const [preferences, setPreferences] = useState(readHandoffPreferences);
    const [intent, setIntent] = useState<HandoffIntent>('consult');
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const [message, setMessage] = useState('');
    const [manualCopy, setManualCopy] = useState('');
    const [copying, setCopying] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const gesture = useRef<Gesture | null>(null);
    const copyAttempt = useRef<symbol | null>(null);
    const suppressClick = useRef(false);
    const bubbleId = useId();
    const target = AI_TARGETS.find(target => target.id === agent)!;
    const item = panel && typeof panel === 'object' ? items[panel.taskId] : undefined;
    const validTask = isLive(item) && item.type === 'task';
    const mode = mcpEnabled ? preferences.mode : 'text';
    const prompt = validTask ? buildTaskHandoff(item, items, mode, intent) : '';
    const link = target.kind === 'open' ? aiConversationLink(target, prompt, preferences.destination, mode) : null;

    const resetResult = () => { copyAttempt.current = null; setCopying(false); setMessage(''); setManualCopy(''); };
    const close = () => { resetResult(); setPanel(null); buttonRef.current?.focus(); };
    const selectTask = (taskId: string) => {
        resetResult();
        const saved = readHandoffPreferences();
        setPreferences(saved);
        if (desktop) {
            const error = desktop.assign(null, { taskId, intent, mode: mcpEnabled ? saved.mode : 'text' });
            setMessage(error ?? '');
            setPanel(error ? { taskId } : null);
        } else setPanel({ taskId });
    };

    useEffect(() => {
        if (!panel) return;
        containerRef.current?.querySelector<HTMLElement>('[data-mascot-initial-focus]')?.focus();
        const outside = (event: globalThis.PointerEvent) => {
            if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setPanel(null);
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [panel]);

    useEffect(() => () => {
        gesture.current?.row?.classList.remove('is-mascot-drop-target');
        copyAttempt.current = null;
    }, []);

    const cancelDrag = () => {
        if (gesture.current?.moved) suppressClick.current = true;
        gesture.current?.row?.classList.remove('is-mascot-drop-target');
        gesture.current = null;
        setPosition(null);
    };

    const move = (event: PointerEvent<HTMLButtonElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
        current.moved = true;
        setPanel(null);
        setPosition({ x: event.clientX, y: event.clientY });
        const row = taskRowAt(event.clientX, event.clientY);
        if (row === current.row) return;
        current.row?.classList.remove('is-mascot-drop-target');
        row?.classList.add('is-mascot-drop-target');
        current.row = row;
    };

    const drop = (event: PointerEvent<HTMLButtonElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (current.moved) {
            suppressClick.current = true;
            const taskId = taskRowAt(event.clientX, event.clientY)?.dataset.rowId;
            if (taskId) selectTask(taskId);
        }
        cancelDrag();
    };

    const changePreferences = (changes: Partial<HandoffPreferences>) => {
        const next = { ...preferences, ...changes };
        setPreferences(next);
        saveHandoffPreferences(next);
        resetResult();
    };

    const copy = async (value: string) => {
        resetResult();
        const attempt = Symbol();
        copyAttempt.current = attempt;
        setCopying(true);
        try {
            await navigator.clipboard.writeText(value);
            if (copyAttempt.current !== attempt) return;
            setMessage(target.kind === 'copy' ? '起動コマンドをコピーしたよ。ターミナルに貼り付けてね！' : '指示文をコピーしたよ。開いた会話に貼り付けてね！');
        } catch {
            if (copyAttempt.current === attempt) setManualCopy(value);
        } finally { if (copyAttempt.current === attempt) setCopying(false); }
    };

    return <div ref={containerRef} className={`mascot-container${handoff ? ' mascot-container--handoff' : ''}${position ? ' is-dragging' : ''}`}
        onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault(); cancelDrag(); close();
            }
        }}>
        {panel ? <div className="speech-bubble" id={bubbleId} role="dialog" aria-label={panel === 'settings' ? 'チルノのハンドオフ設定' : panel === 'about' ? 'bizencore について' : 'タスクのハンドオフ'}>
            <button type="button" onClick={close} className="close-bubble" aria-label="閉じる"><X size={16} /></button>
            {panel === 'about' ? <>
                <h3 className="speech-bubble-title">bizencore について</h3>
                <p className="speech-bubble-body">あたいが文字数をかぞえるよ！<br />Let me count the words for you!</p>
            </> : panel === 'settings' ? <div className="mascot-settings">
                <h3 className="speech-bubble-title">{desktop ? 'ターミナルでお願いする' : '誰にお願いする？'}</h3>
                {desktop ? null : <label className="mascot-field">エージェント
                    <select aria-label="エージェント" data-mascot-initial-focus value={agent} onChange={event => {
                        setAgent(event.target.value); resetResult();
                        try { localStorage.setItem(AGENT_KEY, event.target.value); } catch { /* This selection still works without storage. */ }
                    }}>{AI_TARGETS.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select>
                </label>}
                <HandoffIntentControl intent={intent} onChange={value => { setIntent(value); resetResult(); }} />
                <label className="mascot-field">渡し方
                    <select aria-label="渡し方" data-mascot-initial-focus={desktop ? true : undefined} value={mode} onChange={event => changePreferences({ mode: event.target.value as HandoffPreferences['mode'] })}>
                        <option value="mcp" disabled={!mcpEnabled}>MCPで進める</option>
                        <option value="text">内容だけ渡す</option>
                    </select>
                </label>
                {!desktop && target.kind === 'open' ? <label className="mascot-field">開く先
                    <select aria-label="開く先" value={preferences.destination} onChange={event => changePreferences({ destination: event.target.value as HandoffPreferences['destination'] })}>
                        <option value="web">Web</option><option value="desktop">アプリ</option>
                    </select>
                </label> : null}
                <p className="speech-bubble-body">あたいをタスクへドラッグしてね。<br />{desktop ? 'タスクの起動設定を開くよ。エージェントと作業フォルダを選んで起動してね。' : target.kind === 'copy' ? '起動コマンドをコピーして渡すよ。' : '新しい会話を開いて渡すよ。'}</p>
                <label className="mascot-field">タスクを選ぶ
                    <select aria-label="タスクを選ぶ" value="" onChange={event => selectTask(event.target.value)}>
                        <option value="" disabled>タスクを選んでハンドオフ…</option>
                        {Object.values(items).filter(item => isLive(item) && item.type === 'task').map(item => <option key={item.id} value={item.id}>{item.text.trim() || '（無題）'}</option>)}
                    </select>
                </label>
            </div> : desktop ? <p className="speech-bubble-body" role="alert">{message}</p> : validTask ? <div className="mascot-handoff">
                <h3 className="speech-bubble-title">{target.name}にお願いする？</h3>
                <p className="mascot-task-name">{item.text.trim() || '（無題）'}</p>
                <p className="speech-bubble-body">{intent === 'consult' ? 'まずは検討・相談するよ。' : '実行をお願いするよ。'}{target.kind === 'copy' ? '起動コマンドをコピーして、ターミナルに貼り付けてね。' : link?.copyPrompt ? '指示文をコピーして、新しい会話に貼り付けてね。' : '指示文を入れた新しい会話を開くよ。'}</p>
                {target.kind === 'open' && link ? <a data-mascot-initial-focus className="mascot-handoff-action" href={link.url} target={preferences.destination === 'web' ? '_blank' : undefined} rel="noopener noreferrer"
                    onClick={() => { if (link.copyPrompt) void copy(prompt); else setMessage('新しい会話に指示文を渡したよ。'); }}>{target.name}にハンドオフ</a>
                    : target.kind === 'copy' ? <button data-mascot-initial-focus type="button" className="mascot-handoff-action" disabled={copying} onClick={() => void copy(target.command(prompt))}>{target.name}にハンドオフ</button> : null}
                <p className="mascot-handoff-summary">{mode === 'mcp' ? 'MCPで引き継ぎ（送り先にも接続が必要）' : '内容のみ（進捗の自動反映・ファイル転送なし）'}</p>
                {message ? <p className="speech-bubble-body" role="status">{message}</p> : null}
                {manualCopy ? <label className="mascot-field"><span role="alert">コピーできなかったよ。この内容を選択してコピーしてね。</span><textarea readOnly value={manualCopy} aria-label="手動でコピーする内容" onFocus={event => event.target.select()} /></label> : null}
            </div> : <p className="speech-bubble-body" role="status">このタスクは削除されたよ。別のタスクを選んでね。</p>}
        </div> : null}
        <button ref={buttonRef} type="button" className="mascot-button" aria-label={handoff ? 'チルノのハンドオフ設定' : 'bizencore について'} aria-haspopup="dialog" aria-expanded={!!panel} aria-controls={panel ? bubbleId : undefined}
            onClick={event => {
                if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
                resetResult();
                setPreferences(readHandoffPreferences());
                setPanel(current => current === (handoff ? 'settings' : 'about') ? null : handoff ? 'settings' : 'about');
            }}
            onPointerDown={event => {
                if (!handoff || event.button !== 0 || !event.isPrimary) return;
                suppressClick.current = false;
                gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, row: null };
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={move} onPointerUp={drop} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
            <MascotPortrait active={!position && !panel} />
        </button>
        {position ? <img src={cirnoImg} alt="" className="mascot-drag-preview" style={{ left: position.x, top: position.y }} /> : null}
    </div>;
}
