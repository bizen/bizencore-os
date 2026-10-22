import { mcpClientName } from '../src/lib/mcpClientName.js';
import { createClerkClient } from '@clerk/backend';
import type { AuthInfo, ServerContext } from '@modelcontextprotocol/server';
import { withMcpAuth } from 'mcp-handler';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clerkPublishableKey, clerkSecretKey, convexSiteUrl, mcpSecret } from './_lib/env.js';

import { createBizencoreMcp } from './_lib/mcpServer.js';

const clerk = createClerkClient({
  secretKey: clerkSecretKey(),
  publishableKey: clerkPublishableKey(),
});

let clientNames: { at: number; values: Map<string, string> } | undefined;

async function clientNameOf(clientId: string | undefined): Promise<string | undefined> {
  if (!clientId || clientId === 'unknown') return undefined;
  if (!clientNames || Date.now() - clientNames.at > 10 * 60_000) {
    try {
      const apps = await clerk.oauthApplications.list({ limit: 500 });
      clientNames = {
        at: Date.now(),
        values: new Map(apps.data.map((app) => [app.clientId, app.name])),
      };
    } catch {
      return undefined;
    }
  }
  return clientNames.values.get(clientId);
}

async function verifyToken(request: Request, token?: string): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const state = await clerk.authenticateRequest(request, { acceptsToken: 'oauth_token' });
  const auth = state.toAuth();
  if (!auth?.isAuthenticated || !auth.userId) return undefined;
  return {
    token,
    clientId: auth.clientId ?? 'unknown',
    scopes: auth.scopes ?? [],
    extra: { userId: auth.userId },
  };
}

function userIdOf(ctx: ServerContext): string {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== 'string') throw new Error('Not signed in');
  return userId;
}

async function fetchConvex(
  ctx: ServerContext,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const clientId = ctx.http?.authInfo?.clientId;
  const info = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/clientInfo'];
  const declaredName = info && typeof info === 'object' && 'name' in info && typeof info.name === 'string' ? info.name : undefined;
  // Client-reported names affect history display only; authorization still uses OAuth identity.
  const clientName = clientId && clientId !== 'unknown' ? mcpClientName(clientId, await clientNameOf(clientId), declaredName) : undefined;
  const response = await fetch(`${convexSiteUrl()}/mcp/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mcpSecret()}`,
    },
    body: JSON.stringify({ ...body, userId: userIdOf(ctx), clientId, clientName }),
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload;
}

const instance = createBizencoreMcp({
  signingKey: createHash('sha256').update(mcpSecret()).digest(),
  fetchData: fetchConvex,
  readApp: () => readFile(join(process.cwd(), 'dist-mcp/index.html'), 'utf8'),
});
export const { withResolvedLabel, deleteWithConfirmation, workOnTask, workOnTaskPrompt } = instance;
const handler = instance.handler;

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
});

export const GET = authed;
export const POST = authed;
export const DELETE = authed;
