export const DESKTOP_DEV_CONVEX_URL = "https://dazzling-setter-393.convex.cloud";
export const DESKTOP_PROD_CONVEX_URL = "https://good-chinchilla-15.convex.cloud";

export function desktopMcpIdentity(
    identity: { subject: string; issuer: string } | null,
    env: Record<string, string | undefined>,
): string | undefined {
    const development = env.DESKTOP_MCP_ENABLED === "true" && env.CONVEX_CLOUD_URL === DESKTOP_DEV_CONVEX_URL;
    const production = env.DESKTOP_MCP_PRODUCTION_ENABLED === "true" && env.CONVEX_CLOUD_URL === DESKTOP_PROD_CONVEX_URL;
    if (!development && !production) return undefined;
    const issuer = env.DESKTOP_MCP_ISSUER;
    const expectedIssuer = production ? "https://clerk.bizencore.com" : "https://grown-gorilla-52.clerk.accounts.dev";
    if (issuer !== expectedIssuer || identity?.issuer !== issuer) return undefined;
    return identity.subject || undefined;
}
