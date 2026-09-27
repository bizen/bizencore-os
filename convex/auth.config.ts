/*
 * Clerk の Frontend API のドメイン。開発用と本番用で違うので環境変数で渡す。
 * Convex のデプロイメントに CLERK_JWT_ISSUER_DOMAINS をカンマ区切りで置く。
 *
 * 開発用から本番用へ移す間は、両方を並べておく。Vercel の鍵を差し替える前後で
 * どちらのログインでも同期が止まらないように。移し終えたら本番用だけにする。
 *   https://clerk.bizencore.com,https://grown-gorilla-52.clerk.accounts.dev
 */
const domains = (process.env.CLERK_JWT_ISSUER_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);

if (domains.length === 0) throw new Error("CLERK_JWT_ISSUER_DOMAINS is not set");

export default {
    providers: domains.map((domain) => ({ domain, applicationID: "convex" })),
};
