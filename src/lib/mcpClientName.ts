const KNOWN_CLIENTS = new Map([
  ['https://chatgpt.com/oauth/codex/client.json', 'Codex（CLI／Desktop未判別）'],
  ['https://chatgpt.com/oauth/client.json', 'ChatGPT'],
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude（Web／Desktop未判別）'],
  ['https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code CLI'],
  ['https://antigravity.google/oauth/client-metadata.json', 'Antigravity'],
]);

const APP_NAMES = new Map([
  ['codex cli', 'Codex CLI'], ['codex-cli', 'Codex CLI'],
  ['codex desktop', 'Codex Desktop'], ['codex-desktop', 'Codex Desktop'],
  ['claude code', 'Claude Code CLI'], ['claude-code', 'Claude Code CLI'], ['claude code cli', 'Claude Code CLI'],
  ['claude desktop', 'Claude Desktop'], ['claude-desktop', 'Claude Desktop'],
  ['claude code desktop', 'Claude Code Desktop'],
  ['antigravity', 'Antigravity'],
  ['google antigravity', 'Antigravity'],
  ['cursor', 'Cursor'], ['chatgpt', 'ChatGPT'],
]);

export function mcpClientName(clientId: string, savedName?: string, declaredName?: string): string {
  // These IDs are the CLI processes launched inside bizencore, not standalone desktop apps.
  if (clientId === 'desktop-codex') return 'Codex CLI（bizencore内）';
  if (clientId === 'desktop-claude') return 'Claude Code CLI（bizencore内）';
  const declaredApp = APP_NAMES.get(declaredName?.trim().toLowerCase() ?? '');
  if (declaredApp) return declaredApp;
  const name = savedName?.trim();
  if (name && name !== clientId) {
    const app = APP_NAMES.get(name.toLowerCase());
    if (app) return app;
    if (!['codex', 'claude'].includes(name.toLowerCase())) return name;
  }
  return KNOWN_CLIENTS.get(clientId) || name || clientId;
}
