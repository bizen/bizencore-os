import { useEffect, useState, type ReactNode } from 'react';
import { SignIn, useAuth, useClerk } from '@clerk/clerk-react';
import { LoaderCircle, LogOut, RotateCcw } from 'lucide-react';
import { Brand } from '../src/components/Brand';
import { ConvexClientProvider } from '../src/components/ConvexClientProvider';
import { isCloudConfigured } from '../src/lib/cloudConfig';
import * as bridge from './bridge';
import { DesktopWorkspaceAccount } from './workspace-account';

function AuthScreen({ children }: { children: ReactNode }) {
  return <main className="desktop-auth"><header><Brand desktop /></header><div className="desktop-auth-content">{children}</div></main>;
}

function PendingAuth() {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);
  return <AuthScreen>{timedOut ? <>
    <p role="status">ログインの確認に時間がかかっています。macOSのキーチェーン確認が出ていれば、このアプリについて許可してください。確認画面がなければ、通信を確認して再読み込みしてください。</p><ReloadButton />
  </> : <p className="desktop-auth-status" role="status"><LoaderCircle size={18} aria-hidden />ログインを確認しています...</p>}</AuthScreen>;
}

function ReloadButton() {
  return <button type="button" className="ghost-btn" onClick={() => window.location.reload()}><RotateCcw size={15} aria-hidden />再読み込み</button>;
}

function VerifiedSession({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const { signOut } = useClerk();
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [signOutError, setSignOutError] = useState(false);

  useEffect(() => {
    let active = true;
    let failed = false;
    let hasGrant = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let unlistenResume: (() => void) | undefined;
    let verifying = false;
    const fail = () => {
      if (!active || failed) return;
      failed = true;
      setVerified(false);
      setError('ログインを確認できませんでした。再度サインインしてください。');
      if (timer) clearTimeout(timer);
      void bridge.lock().catch(() => {});
    };
    const verify = async () => {
      if (!active || failed || verifying) return;
      verifying = true;
      if (timer) clearTimeout(timer);
      try {
        if (hasGrant && await window.bizencoreDesktop?.validation?.state().then(state => state.pauseRefresh)) {
          timer = setTimeout(() => void verify(), 1000);
          return;
        }
        const token = await getToken({ template: 'convex', skipCache: true });
        if (!active || failed) return;
        if (!token || !bridge.nativeDesktop) { fail(); return; }
        const grant = await bridge.authorize(token);
        if (!active || failed) return;
        if (grant.userId !== userId) { fail(); return; }
        setVerified(true);
        hasGrant = true;
        // Persisted Clerk state never replaces fresh native server authorization.
        const remaining = grant.expiresAt * 1000 - Date.now();
        timer = setTimeout(() => void verify(), Math.max(1000, Math.min(30000, remaining / 2)));
      } catch { fail(); }
      finally { verifying = false; }
    };
    if (bridge.nativeDesktop) {
      void bridge.onExpired(fail).then(stop => {
        if (active) unlisten = stop;
        else stop();
      }).catch(fail);
      unlistenResume = window.bizencoreDesktop?.onResume?.(state => {
        if (!state.authorized || state.reauthorize) fail();
        else void verify();
      });
    }
    void verify();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unlisten?.();
      unlistenResume?.();
      void bridge.lock().catch(() => {});
    };
  }, [getToken, userId]);

  if (error) return <AuthScreen>
    <p role="alert">{error}</p>
    <div className="desktop-auth-actions"><ReloadButton /><button type="button" className="ghost-btn" onClick={() => {
      void signOut({ redirectUrl: '/' }).catch(() => setSignOutError(true));
    }}><LogOut size={15} aria-hidden />サインアウト</button></div>
    {signOutError ? <p role="alert">サインアウトできませんでした。</p> : null}
  </AuthScreen>;
  return verified ? <DesktopWorkspaceAccount.Provider value={userId ?? null}>{children}</DesktopWorkspaceAccount.Provider> : <PendingAuth />;
}

function AuthenticationGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  if (!isLoaded) return <PendingAuth />;
  if (!isSignedIn || !userId || !sessionId) return <AuthScreen>
    <SignIn routing="hash" fallbackRedirectUrl="/" appearance={{
      variables: { colorPrimary: '#5fd9e8', colorBackground: '#111416', colorText: '#f1f2f2', colorTextSecondary: '#959da6', colorInputBackground: '#0a0b0c', colorInputText: '#f1f2f2', borderRadius: '6px' },
      elements: {
        rootBox: 'desktop-sign-in', card: 'desktop-sign-in-card',
        cardBox: { borderRadius: '6px' },
        socialButtonsBlockButton: { backgroundColor: '#1c2127', color: '#f1f2f2', borderColor: '#383d43' },
        socialButtonsBlockButtonText: { color: '#f1f2f2' },
        formButtonPrimary: { backgroundColor: '#5fd9e8', backgroundImage: 'none', color: '#0a0b0c', boxShadow: 'none' },
      },
    }} />
  </AuthScreen>;
  return <VerifiedSession key={`${userId}:${sessionId}`}>{children}</VerifiedSession>;
}

export function DesktopAuthentication({ children }: { children: ReactNode }) {
  useEffect(() => { void window.bizencoreDesktop?.updateReady?.().catch(() => {}); }, []);
  if (!isCloudConfigured) return <AuthScreen><p role="alert">ログイン設定を読み込めませんでした。</p><ReloadButton /></AuthScreen>;
  return <ConvexClientProvider><AuthenticationGate>{children}</AuthenticationGate></ConvexClientProvider>;
}
