import { getPublicOrigin, protectedResourceHandler } from 'mcp-handler';
import { convexSiteUrl } from './_lib/env.js';
import { grokBotClientId, grokBotIdPattern, grokBotOAuthPath, isGrokBotRedirect } from '../src/lib/grokBotOAuth.js';

function route(request: Request) {
  const url = new URL(request.url);
  const match = /\/(mcp|oauth|token|register)\/([a-z0-9-]+)$/.exec(url.pathname);
  const kind = match?.[1] ?? url.searchParams.get('kind');
  const assignment = match?.[2] ?? url.searchParams.get('assignment');
  return assignment && grokBotIdPattern.test(assignment) ? { kind, assignment } : null;
}

export function GET(request: Request) {
  const target = route(request);
  if (!target) return new Response(null, { status: 404 });
  const origin = getPublicOrigin(request);
  const resource = `${origin}/grok-bot/mcp/${target.assignment}`;
  const issuer = `${origin}/grok-bot/oauth/${target.assignment}`;
  if (target.kind === 'mcp') return protectedResourceHandler({
    authServerUrls: [issuer], resourceUrl: resource,
  })(request);
  if (target.kind !== 'oauth') return new Response(null, { status: 404 });
  return Response.json({
    issuer, authorization_endpoint: `${origin}${grokBotOAuthPath}?assignment=${target.assignment}`,
    token_endpoint: `${origin}/grok-bot/token/${target.assignment}`,
    registration_endpoint: `${origin}/grok-bot/register/${target.assignment}`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
  }, { headers: { 'Access-Control-Allow-Origin': '*' } });
}

export async function POST(request: Request) {
  const target = route(request);
  if (!target) return new Response(null, { status: 404 });
  const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Access-Control-Allow-Origin': '*' };
  if (target.kind === 'register') {
    const registration = await request.json().catch(() => null);
    const uris: unknown = registration?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || uris.some(uri => typeof uri !== 'string' || !isGrokBotRedirect(uri))) {
      return Response.json({ error: 'invalid_redirect_uri' }, { status: 400, headers });
    }
    if (registration.token_endpoint_auth_method !== undefined && registration.token_endpoint_auth_method !== 'none') {
      return Response.json({ error: 'invalid_client_metadata' }, { status: 400, headers });
    }
    return Response.json({
      client_id: grokBotClientId, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'],
    }, { status: 201, headers });
  }
  if (target.kind !== 'token') return new Response(null, { status: 404 });
  const body = new URLSearchParams(await request.text());
  const resource = body.get('resource');
  if (resource && resource !== `${getPublicOrigin(request)}/grok-bot/mcp/${target.assignment}`) {
    return Response.json({ error: 'invalid_target' }, { status: 400, headers });
  }
  body.set('assignment', target.assignment);
  try {
    const response = await fetch(`${convexSiteUrl()}/grok-bot/token`, {
      method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(12_000),
    });
    return new Response(response.body, {
      status: response.status, headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch {
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' },
  });
}
