import type { PaneAssignment } from '../src/lib/desktopHandoff';
import type { WorkReply, WorkRequest } from '../src/lib/taskTools';

export type AgentId = 'claude' | 'codex';
export type AgentEvent = { kind: 'data'; bytes: number[]; sequence?: number; streamId?: string } | { kind: 'exit'; code: number | null };
export type AgentInfo = { id: AgentId; name: string; path: string | null };
export type AgentDiagnostic = AgentInfo & { version: string | null; problem?: string };
export type Conversation = { id: string; title: string; updatedAt: number };
export type PaneNotification = { paneId: string; title: string; body: string };
export type AccessGrant = { userId: string; expiresAt: number };
export type ResumeEvent = { authorized: boolean; reauthorize: boolean };
export type OrchestrationHandoff = { taskId: string; reply: string };
export type StartArgs = { id: string; agent: AgentId; cwd: string; cols: number; rows: number; handoff?: PaneAssignment & { prompt: string }; resumeSessionId?: string; orchestration?: OrchestrationHandoff };
export type TaskStartRequest = { requestId: string; paneId: string; assignment: PaneAssignment; expiresAt: number };
export type DesktopBridge = {
  checkUpdate?: () => Promise<{ version: string; pageUrl: string; sha256: string; size: number } | null>;
  openUpdate?: () => Promise<void>;
  downloadUpdate?: () => Promise<{ version: string }>;
  installUpdate?: () => Promise<boolean>;
  onUpdateProgress?: (callback: (percent: number) => void) => () => void;
  updateReady?: () => Promise<void>;
  integratedTitlebar?: boolean;
  validation?: {
    state: () => Promise<{ pauseRefresh: boolean }>;
    sample: (value: { kind: string; surface: string; ms: number; start?: number }) => Promise<void>;
  };
  mcpSupported?: boolean;
  authorize: (token: string) => Promise<AccessGrant>;
  lock: () => Promise<void>;
  agents: () => Promise<AgentInfo[]>;
  agentDiagnostics?: () => Promise<AgentDiagnostic[]>;
  conversations?: (agent: AgentId, cwd: string) => Promise<Conversation[]>;
  openExternal?: (url: string) => Promise<void>;
  notify?: (value: PaneNotification) => Promise<void>;
  onTaskStart?: (callback: (request: TaskStartRequest) => void) => () => void;
  replyTaskStart?: (requestId: string, error: string | null) => Promise<void>;
  onFocusPane?: (callback: (paneId: string) => void) => () => void;
  folder: () => Promise<string | null>;
  taskRun?: (request: WorkRequest) => Promise<WorkReply>;
  taskStop?: (id: string) => Promise<void>;
  taskReview?: (id: string) => Promise<WorkReply>;
  start: (args: StartArgs) => Promise<number>;
  write: (id: string, data: string) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  acknowledgeOutput?: (id: string, streamId: string, sequence: number) => Promise<void>;
  stop: (id: string) => Promise<void>;
  onEvent: (callback: (id: string, event: AgentEvent) => void) => () => void;
  onExpired: (callback: () => void) => () => void;
  onResume?: (callback: (value: ResumeEvent) => void) => () => void;
};
declare global { interface Window { bizencoreDesktop?: DesktopBridge } }
const electron = window.bizencoreDesktop;
function required(): DesktopBridge {
  if (!electron) throw new Error('Electronデスクトップ接続を利用できません');
  return electron;
}
const unavailable = (name: string) => Promise.reject(new Error(`${name}を利用できません。デスクトップアプリを更新してください。`));
export const nativeDesktop = Boolean(electron);
export const taskHandoffSupported = Boolean(electron);
export const mcpSupported = electron?.mcpSupported === true;
export const conversationsSupported = Boolean(electron?.conversations);
export const notificationsSupported = Boolean(electron?.notify && electron?.onFocusPane);
export const authorize = (token: string) => required().authorize(token);
export const lock = () => required().lock();
export const onExpired = async (callback: () => void): Promise<() => void> => required().onExpired(callback);
export const onResume = (callback: (value: ResumeEvent) => void) => electron?.onResume?.(callback) ?? (() => {});
export const agents = () => required().agents();
export const agentDiagnostics = async (): Promise<AgentDiagnostic[]> => electron?.agentDiagnostics ? electron.agentDiagnostics() : (await agents()).map(agent => ({ ...agent, version: null }));
export const conversations = (agent: AgentId, cwd: string) => electron?.conversations?.(agent, cwd) ?? unavailable('会話履歴');
export const openExternal = (url: string) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Webリンクのみ開けます');
    return electron?.openExternal?.(url) ?? unavailable('外部リンク');
  } catch { return Promise.reject(new Error('Webリンクのみ開けます')); }
};
export const notify = (value: PaneNotification) => electron?.notify?.({ ...value, title: value.title.slice(0, 160), body: value.body.slice(0, 500) }) ?? unavailable('通知');
export const onFocusPane = (callback: (paneId: string) => void) => electron?.onFocusPane?.(callback) ?? (() => {});
export const folder = () => required().folder();
export const taskToolsSupported = Boolean(electron?.taskRun && electron?.taskStop);
export const taskRun = (request: WorkRequest) => electron?.taskRun?.(request) ?? unavailable('オーケストレーション');
export const taskStop = (id: string) => electron?.taskStop?.(id) ?? unavailable('オーケストレーションの停止');
export const interactiveOrchestrationSupported = Boolean(electron?.taskReview);
export const taskReview = (id: string) => electron?.taskReview?.(id) ?? unavailable('オーケストレーションの完了確認');
export function start(id: string, agent: AgentId, cwd: string, cols: number, rows: number, onEvent: (event: AgentEvent) => void, handoff?: PaneAssignment & { prompt: string }, resumeSessionId?: string, orchestration?: OrchestrationHandoff) {
  if (orchestration && (handoff || resumeSessionId)) return Promise.reject(new Error('オーケストレーションでは新しい専用セッションを使用します'));
  if (resumeSessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeSessionId)) return Promise.reject(new Error('会話IDが無効です'));
  const native = required();
  const unlisten = native.onEvent((eventId, event) => {
    if (eventId !== id) return;
    onEvent(event);
    if (event.kind === 'exit') unlisten();
  });
  // A resumed CLI session already contains its handoff.
  return native.start({ id, agent, cwd, cols, rows, ...(orchestration ? { orchestration } : resumeSessionId ? { resumeSessionId } : { handoff }) }).catch(error => { unlisten(); throw error; });
}
export const write = (id: string, data: string) => required().write(id, data);
export const resize = (id: string, cols: number, rows: number) => required().resize(id, cols, rows);
export const acknowledgeOutput = (id: string, streamId: string, sequence: number) => electron?.acknowledgeOutput?.(id, streamId, sequence) ?? Promise.resolve();
export const stop = (id: string) => required().stop(id);

export const onTaskStart = (callback: (request: TaskStartRequest) => void) => electron?.onTaskStart?.(callback) ?? (() => {});
export const replyTaskStart = (requestId: string, error: string | null) => electron?.replyTaskStart?.(requestId, error) ?? unavailable('担当タスクの反映');
