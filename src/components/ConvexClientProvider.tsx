import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { clerkPublishableKey, convexUrl } from "../lib/cloudConfig";

let convex: ConvexReactClient | undefined;
try {
    if (convexUrl) {
        convex = new ConvexReactClient(convexUrl);
    }
} catch (error) {
    console.error("Failed to initialize Convex client:", error);
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
    if (!convex || !clerkPublishableKey) {
        if (import.meta.env.DEV) {
            console.warn(
                "[chrct] Convex / Clerk env vars are missing. Tasks page will be disabled, character counter still works."
            );
        }
        return <>{children}</>;
    }

    /*
     * サインインの後はいまのアプリへ戻す。指定しないと Clerk はインスタンスの
     * ホーム（本番では bizencore.com 本体。ブランドの LP でアプリではない）へ送る。
     */
    return (
        <ClerkProvider
            publishableKey={clerkPublishableKey}
            signInFallbackRedirectUrl="/"
            signUpFallbackRedirectUrl="/"
            afterSignOutUrl="/"
        >
            <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
                {children}
            </ConvexProviderWithClerk>
        </ClerkProvider>
    );
}
