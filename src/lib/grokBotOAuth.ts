export const grokBotClientId = 'grok-bot';
export const grokBotOAuthPath = '/grok-bot/authorize';
export const grokBotIdPattern = /^[a-z0-9-]{1,64}$/;
export const grokBotChallengePattern = /^[A-Za-z0-9_-]{43}$/;
export function isGrokBotRedirect(uri: string) {
  return /^(?:https:\/\/(?:www\.)?cursor\.com\/(?:bot|agents)\/mcp\/oauth\/callback|grokbot:\/\/mcp\/oauth\/callback|http:\/\/localhost:(?:8787|18787|28787|31787)\/callback)$/.test(uri);
}

export function grokBotOAuthRequest(search: string) {
  const values = new URLSearchParams(search);
  const assignment = values.get('assignment') ?? '';
  const challenge = values.get('code_challenge') ?? '';
  const redirectUri = values.get('redirect_uri') ?? '';
  const state = values.get('state') ?? '';
  if (values.get('client_id') !== grokBotClientId || values.get('response_type') !== 'code' ||
      values.get('code_challenge_method') !== 'S256' || !grokBotIdPattern.test(assignment) ||
      !grokBotChallengePattern.test(challenge) || !isGrokBotRedirect(redirectUri) ||
      !state || state.length > 4096) return null;
  return { assignment, challenge, redirectUri, state };
}

export const grokBotRandomCode = () => grokBotHex(crypto.getRandomValues(new Uint8Array(32)));
export const grokBotHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
