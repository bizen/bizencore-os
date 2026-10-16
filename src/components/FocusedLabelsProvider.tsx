import { useAuth } from '@clerk/clerk-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../convex/_generated/api';
import { convexUrl, isCloudConfigured } from '../lib/cloudConfig';
import { browserFocusStorage, changeFocusedLabel, claimLegacyFocus, focusCacheKey, GUEST_FOCUS_KEY, readFocusCache, readGuestFocus } from '../lib/focusedLabels';
import { FocusedLabelsContext, type FocusedLabels } from '../lib/focusedLabelsContext';

const SAVE_ERROR = 'フォーカス表示を保存できませんでした。接続を確認して、もう一度お試しください。';

export function FocusedLabelsProvider({ children }: { children: ReactNode }) {
  return isCloudConfigured ? <CloudFocusedLabels>{children}</CloudFocusedLabels>
    : <GuestFocusedLabels>{children}</GuestFocusedLabels>;
}

function GuestFocusedLabels({ children }: { children: ReactNode }) {
  const [storage] = useState(browserFocusStorage);
  const [ids, setIds] = useState(() => readGuestFocus(storage));
  const value: FocusedLabels = { ids, error: null, change: (id, focused) => setIds(previous => {
    const next = changeFocusedLabel(previous, id, focused);
    try { storage.setItem(GUEST_FOCUS_KEY, JSON.stringify(next)); } catch { /* Guest mode can remain in memory. */ }
    return next;
  }) };
  return <FocusedLabelsContext value={value}>{children}</FocusedLabelsContext>;
}

function CloudFocusedLabels({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  if (!isLoaded) return <FocusedLabelsContext value={{ ids: [], change: () => {}, error: null }}>{children}</FocusedLabelsContext>;
  if (!isSignedIn || !userId) return <GuestFocusedLabels>{children}</GuestFocusedLabels>;
  return <AccountFocusedLabels key={userId} accountId={userId} enabled={isAuthenticated}>{children}</AccountFocusedLabels>;
}

function AccountFocusedLabels({ children, accountId, enabled }: { children: ReactNode; accountId: string; enabled: boolean }) {
  const scope = convexUrl!;
  const key = focusCacheKey(scope, accountId);
  const [storage] = useState(browserFocusStorage);
  const [cachedIds] = useState(() => readFocusCache(storage, key));
  const [error, setError] = useState<string | null>(null);
  const remote = useQuery(api.focusedLabels.get, enabled ? { accountId } : 'skip');
  const initialize = useMutation(api.focusedLabels.initialize);
  const set = useMutation(api.focusedLabels.set);
  const initializeOptimistic = useMemo(() => initialize.withOptimisticUpdate((store, args) => {
    const previous = store.getQuery(api.focusedLabels.get, { accountId: args.accountId });
    if (previous?.labelIds === null) store.setQuery(api.focusedLabels.get, { accountId: args.accountId }, { accountId: args.accountId, labelIds: args.labelIds });
  }), [initialize]);
  const setOptimistic = useMemo(() => set.withOptimisticUpdate((store, args) => {
    const previous = store.getQuery(api.focusedLabels.get, { accountId: args.accountId });
    if (previous?.labelIds) store.setQuery(api.focusedLabels.get, { accountId: args.accountId }, {
      accountId: args.accountId, labelIds: changeFocusedLabel(previous.labelIds, args.labelId, args.focused),
    });
  }), [set]);

  useEffect(() => {
    if (!enabled || !remote || error) return;
    const labelIds = claimLegacyFocus(storage, scope, accountId);
    if (remote.labelIds !== null) return;
    void initializeOptimistic({ accountId, labelIds }).catch(() => setError(SAVE_ERROR));
  }, [enabled, remote, scope, accountId, initializeOptimistic, storage, error]);

  useEffect(() => {
    if (!remote?.labelIds) return;
    try { storage.setItem(key, JSON.stringify(remote.labelIds)); } catch { /* Server remains authoritative. */ }
  }, [remote, key, storage]);

  const change = (labelId: string, focused: boolean) => {
    if (!enabled || !remote) { setError(SAVE_ERROR); return; }
    setError(null);
    const save = async () => {
      if (remote.labelIds === null) await initializeOptimistic({ accountId, labelIds: claimLegacyFocus(storage, scope, accountId) });
      await setOptimistic({ accountId, labelId, focused });
    };
    void save().catch(() => setError(SAVE_ERROR));
  };
  return <FocusedLabelsContext value={{ ids: remote === null ? [] : remote?.labelIds ?? cachedIds, change, error }}>{children}</FocusedLabelsContext>;
}
