import { SignedIn, useAuth } from '@clerk/clerk-react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { isCloudConfigured } from '../lib/cloudConfig';
import { notificationDesktop, notificationDeviceId, unsubscribeNotifications } from '../lib/notificationClient';

function Session({ userId }: { userId: string }) {
  const [deviceId] = useState(() => { try { return notificationDeviceId(userId); } catch { return null; } });
  const desktop = notificationDesktop();
  const state = useQuery(api.notifications.state, deviceId ? { deviceId } : 'skip');
  const pending = useQuery(api.notifications.pending, deviceId && desktop?.notifyTask ? { deviceId } : 'skip');
  const acknowledge = useMutation(api.notifications.acknowledge);
  const displayed = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('bizencore:managed-completion', { detail: state?.preferences.completion === true }));
    return () => { window.dispatchEvent(new CustomEvent('bizencore:managed-completion', { detail: false })); };
  }, [state?.preferences.completion]);
  useEffect(() => {
    if (!desktop?.notifyTask || !pending) return;
    const pendingIds = new Set<string>(pending.map(notice => notice.id));
    for (const id of displayed.current) if (!pendingIds.has(id)) displayed.current.delete(id);
    let cancelled = false;
    const flush = async () => {
      for (const notice of pending) {
        if (cancelled || inFlight.current.has(notice.id)) continue;
        inFlight.current.add(notice.id);
        try {
          if (!displayed.current.has(notice.id)) { await desktop.notifyTask!(notice); displayed.current.add(notice.id); }
          if (!cancelled) await acknowledge({ id: notice.id });
        } catch { /* Retry acknowledgement without displaying the same notice again. */ }
        finally { inFlight.current.delete(notice.id); }
      }
    };
    void flush(); const timer = setInterval(() => { void flush(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending, desktop, acknowledge]);
  useEffect(() => {
    if (desktop?.notifyTask) return;
    // Unsubscribe on account change/sign-out, not on browser close.
    return () => { void unsubscribeNotifications().catch(() => {}); };
  }, [desktop]);
  return null;
}
function AuthenticatedSession() {
  const { userId } = useAuth();
  return userId ? <Session key={userId} userId={userId} /> : null;
}
export function TaskNotificationBridge() {
  return isCloudConfigured ? <SignedIn><AuthenticatedSession /></SignedIn> : null;
}
