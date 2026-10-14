import { checkedRuntimeConfig, desktopMcpSite } from './release-config.mjs';

export function desktopContentPolicy(config, development = false) {
  const profile = checkedRuntimeConfig(config);
  if (development && profile.channel !== 'preview') throw Error('Production cannot allow development origins');
  const convex = new URL(config.convexUrl).origin;
  const fileSite = desktopMcpSite(convex);
  const clerkHost = config.clerkHost;
  return `default-src 'self'; script-src 'self' https://${clerkHost} https://challenges.cloudflare.com https://*.protect.clerk.com${development ? " 'unsafe-eval'" : ''}; connect-src 'self' https://${clerkHost} ${convex} ${fileSite} ${convex.replace('https:', 'wss:')} https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com${development ? ' http://127.0.0.1:5211 ws://127.0.0.1:5211' : ''}; img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; object-src 'none'; base-uri 'self'; form-action 'self'`;
}
