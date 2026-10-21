import type { AgentId } from './bridge';
import type { PaneAssignment } from '../src/lib/desktopHandoff';

export type SavedPane = { id: string; agent: AgentId; cwd: string; assignments?: PaneAssignment[]; resumeSessionId?: string; labelId?: string };
export type WorkspaceState = { version: 1; panes: SavedPane[]; width: number; height: number; orientation: 'columns' | 'rows'; inspectorWidth: number; expanded: boolean; layout: 'grid' | 'tabs'; lastCwd?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const folderPath = (value: unknown) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) ? value : '';

export function workspaceKey(account: string, environment: string): string {
  return `bizencore.desktop.workspace.v1:${encodeURIComponent(environment)}:${encodeURIComponent(account)}`;
}

export function normalizeWorkspace(value: unknown): WorkspaceState | null {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.panes)) return null;
  const paneIds = new Set<string>(), taskIds = new Set<string>();
  const panes: SavedPane[] = [];
  for (const raw of value.panes.slice(0, 8)) {
    if (!object(raw) || typeof raw.id !== 'string' || !uuid.test(raw.id) || paneIds.has(raw.id) || (raw.agent !== 'claude' && raw.agent !== 'codex')) continue;
    paneIds.add(raw.id);
    const cwd = folderPath(raw.cwd);
    const pane: SavedPane = { id: raw.id, agent: raw.agent, cwd };
    if (cwd && typeof raw.resumeSessionId === 'string' && uuid.test(raw.resumeSessionId)) pane.resumeSessionId = raw.resumeSessionId;
    if (typeof raw.labelId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.labelId)) pane.labelId = raw.labelId;
    const assignments = Array.isArray(raw.assignments) ? raw.assignments : raw.assignment ? [raw.assignment] : [];
    for (const assignment of assignments) {
      if ((pane.assignments?.length ?? 0) >= 3) break;
      if (object(assignment) && typeof assignment.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(assignment.taskId) && !taskIds.has(assignment.taskId) &&
        (assignment.intent === 'consult' || assignment.intent === 'execute') && (assignment.mode === 'mcp' || assignment.mode === 'text')) {
        (pane.assignments ??= []).push({ taskId: assignment.taskId, intent: assignment.intent, mode: assignment.mode });
        taskIds.add(assignment.taskId);
      }
    }
    panes.push(pane);
  }
  if (value.panes.length > 0 && panes.length === 0) return null;
  return { version: 1, panes, width: bounded(value.width, 30, 65, 46), height: bounded(value.height, 30, 70, 50), orientation: value.orientation === 'rows' ? 'rows' : 'columns', inspectorWidth: bounded(value.inspectorWidth, 280, 460, 340), expanded: panes.length > 0 && value.expanded === true, layout: value.layout === 'tabs' ? 'tabs' : 'grid', lastCwd: folderPath(value.lastCwd === undefined ? panes.at(-1)?.cwd : value.lastCwd) };
}

export function readWorkspace(key: string): WorkspaceState | null {
  try {
    const saved = localStorage.getItem(key);
    return saved && saved.length <= 64 * 1024 ? normalizeWorkspace(JSON.parse(saved)) : null;
  } catch { return null; }
}

export function writeWorkspace(key: string, value: WorkspaceState): boolean {
  try {
    const normalized = normalizeWorkspace(value);
    if (!normalized) return false;
    localStorage.setItem(key, JSON.stringify(normalized));
    return true;
  } catch { return false; }
}
