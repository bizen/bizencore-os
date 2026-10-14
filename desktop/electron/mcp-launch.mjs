import { runAgentProbe } from './agent-probe.mjs';
export const MCP_TOKEN_ENV = 'BIZENCORE_DESKTOP_MCP_TOKEN';

export function codexMcpOverrides(servers, url, workMode) {
  const args = ['-c', 'features.apps=false'];
  for (const server of servers) {
    if (typeof server.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(server.name)) throw new Error('Cannot isolate MCP configuration');
    args.push('-c', `mcp_servers.${server.name}={command="/usr/bin/false",enabled=false}`);
  }
  if (workMode !== undefined && !['execute', 'decompose'].includes(workMode)) throw Error('Invalid work mode');
  const tools = ['work_on_task', 'get_task', ...(workMode === 'execute' ? ['attach_context', 'update_context', 'record_task_progress', 'complete_task'] : [])];
  const policy = workMode ? `,enabled_tools=${JSON.stringify(tools)},tools={${tools.map(tool => `${tool}={approval_mode="approve"}`).join(',')}}` : '';
  args.push('-c', `mcp_servers.bizencore={url=${JSON.stringify(url)},bearer_token_env_var="${MCP_TOKEN_ENV}",enabled=true${policy}}`);
  return args;
}

export function verifyCodexMcp(servers, url) {
  const enabled = servers.filter(server => server.enabled !== false);
  const server = enabled[0];
  if (enabled.length !== 1 || server?.name !== 'bizencore' || server.transport?.type !== 'streamable_http' ||
    server.transport.url !== url || server.transport.bearer_token_env_var !== MCP_TOKEN_ENV ||
    Object.keys(server.transport.http_headers ?? {}).length || Object.keys(server.transport.env_http_headers ?? {}).length) {
    throw new Error('本番MCPを隔離できませんでした。エージェントの起動を中止しました');
  }
}

export async function isolatedMcpLaunch(agent, executable, cwd, env, capability, run = runAgentProbe, signal, workMode) {
  const childEnv = { ...env, [MCP_TOKEN_ENV]: capability.token };
  if (agent === 'claude') {
    const { stdout } = await run(executable, ['--help'], { cwd, env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024, signal });
    if (!stdout.includes('--strict-mcp-config')) throw new Error('Claude Codeを更新してください');
    return { env: childEnv, args: ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
      bizencore: { type: 'http', url: capability.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } },
    } })] };
  }
  if (agent !== 'codex') throw new Error('Unsupported agent');
  const options = { cwd, env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024, signal };
  const base = JSON.parse((await run(executable, ['mcp', 'list', '--json'], options)).stdout);
  const args = codexMcpOverrides(base, capability.url, workMode);
  const effective = JSON.parse((await run(executable, ['mcp', 'list', '--json', ...args], options)).stdout);
  verifyCodexMcp(effective, capability.url);
  return { env: childEnv, args };
}
