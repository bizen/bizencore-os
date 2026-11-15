// Synthetic transport only; the browser test executes the real authenticated handlers.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getFunctionName } from 'convex/server';

let user = 'a', revision = 0;
const listeners = new Set(), snapshots = new Map();
const publish = () => { revision++; for (const notify of listeners) notify(); };
const subscribe = notify => { listeners.add(notify); return () => listeners.delete(notify); };
const useRevision = () => useSyncExternalStore(subscribe, () => revision);
globalThis.fixtureSetUser = next => { user = next; snapshots.clear(); publish(); };
globalThis.fixtureRemote = (accountId, value) => { snapshots.set(accountId, value); publish(); };

export function useAuth() {
  useRevision();
  return { isLoaded: true, isSignedIn: !!user, userId: user, getToken: async () => null };
}
export function useConvexAuth() { useRevision(); return { isLoading: false, isAuthenticated: !!user }; }
export function SignedIn({ children }) { return useAuth().isSignedIn ? children : null; }
export function SignedOut({ children }) { return useAuth().isSignedIn ? null : children; }

export function useQuery(ref, args) {
  useRevision();
  const name = getFunctionName(ref), account = args !== 'skip' ? args?.accountId : undefined;
  useEffect(() => {
    if (name !== 'focusedLabels:get' || !account || snapshots.has(account)) return;
    let active = true;
    void globalThis.fixtureRpc(name, { accountId: account }).then(value => {
      if (active) { snapshots.set(account, value); publish(); }
    });
    return () => { active = false; };
  }, [name, account]);
  return name === 'focusedLabels:get' ? (account ? snapshots.get(account) : undefined) : null;
}

export function useMutation(ref) {
  const name = getFunctionName(ref);
  return useMemo(() => {
    const make = optimistic => {
      const call = async args => {
        const before = snapshots.get(args.accountId);
        optimistic?.({
          getQuery: (_ref, query) => snapshots.get(query.accountId),
          setQuery: (_ref, query, value) => { snapshots.set(query.accountId, value); publish(); },
        }, args);
        try { return await globalThis.fixtureRpc(name, args); }
        catch (error) { snapshots.set(args.accountId, before); publish(); throw error; }
      };
      call.withOptimisticUpdate = update => make(update);
      return call;
    };
    return make();
  }, [name]);
}
