import { useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { api } from '../../convex/_generated/api';
import { lifePendingChanges } from '../lib/lifeWorldModel';
import { lifeWorldStore, useLifeWorldState } from '../lib/lifeWorldStore';

export function LifeWorldSyncBridge() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const { data, accountId, syncAttempt } = useLifeWorldState();
  const enabled = isLoaded && isSignedIn === true && !!userId && isAuthenticated;
  const remote = useQuery(api.sync.lifeWorldPull, enabled ? { accountId: userId } : 'skip');
  const push = useMutation(api.sync.lifeWorldPush);
  const [retryTick, setRetryTick] = useState(0);

  useLayoutEffect(() => {
    if (isLoaded) lifeWorldStore.setAccount(isSignedIn && userId ? userId : null);
  }, [isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (enabled && remote === null && userId === accountId) lifeWorldStore.setSyncStatus('error', userId);
    if (!enabled || !remote || userId !== accountId) return;
    lifeWorldStore.mergeRemote(remote, userId);
  }, [enabled, remote, userId, accountId]);

  useEffect(() => {
    if (!enabled || userId !== accountId || !remote) return;
    const dirty = lifePendingChanges(lifeWorldStore.getSnapshot().data, remote);
    if (!dirty.entries.length && !dirty.checks.length && !dirty.preferences) {
      lifeWorldStore.setSyncStatus('synced', userId);
      return;
    }
    lifeWorldStore.setSyncStatus('pending', userId);
    let cancelled = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const send = () => {
      if (cancelled || lifeWorldStore.getSnapshot().accountId !== userId) return;
      // Bound each mutation; new edits/remote snapshots cancel this batch and recompute it.
      const entries = dirty.entries.slice(0, 100);
      const included = new Set(entries.map(entry => entry.id));
      const checks = dirty.checks.filter(check => remote.entries[check.entryId] || included.has(check.entryId)).slice(0, 100);
      void push({ accountId: userId, entries, checks, ...(dirty.preferences ? { preferences: dirty.preferences } : {}) }).then(() => {
        if (!cancelled) setRetryTick(tick => tick + 1);
      }).catch(() => {
        if (cancelled) return;
        lifeWorldStore.setSyncStatus('error', userId);
        if (retries++ < 3) timer = setTimeout(send, Math.min(1000 * 2 ** retries, 10000));
      });
    };
    timer = setTimeout(send, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, userId, accountId, data, remote, push, syncAttempt, retryTick]);

  return null;
}
