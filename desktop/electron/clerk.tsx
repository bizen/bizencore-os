import { useAuth, SignIn as ElectronSignIn, UserButton as ElectronUserButton } from '@clerk/electron/react';
import type { ComponentProps, ReactNode } from 'react';

// This compatibility module re-exports both SDK components and hooks.
// eslint-disable-next-line react-refresh/only-export-components
export * from '@clerk/electron/react';

type SignInProps = {
  routing?: 'hash';
  fallbackRedirectUrl?: string;
  appearance?: Omit<NonNullable<ComponentProps<typeof ElectronSignIn>['appearance']>, 'variables'> & { variables?: Record<string, string> };
};
export function SignIn({ appearance, ...props }: SignInProps) {
  const variables = { ...appearance?.variables };
  const renamed: Record<string, string> = { colorText: 'colorForeground', colorTextSecondary: 'colorMutedForeground', colorInputText: 'colorInputForeground' };
  for (const [old, current] of Object.entries(renamed)) {
    if (variables[old]) { variables[current] = variables[old]; delete variables[old]; }
  }
  return <ElectronSignIn {...props} appearance={{ ...appearance, variables }} />;
}
export function UserButton(props: ComponentProps<typeof ElectronUserButton> & { afterSignOutUrl?: string }) {
  const next = { ...props };
  delete next.afterSignOutUrl;
  return <ElectronUserButton {...next} />;
}

// Keep the shared Web UI on its current Clerk API while Electron uses Core 3.
export function SignedIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && isSignedIn ? children : null;
}
export function SignedOut({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && !isSignedIn ? children : null;
}
