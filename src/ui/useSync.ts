import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSyncConfig,
  lastSyncAt,
  lastSyncError,
  syncNow as runSync,
  syncPending,
  type SyncStatus
} from '../db/sync';

export interface SyncApi extends SyncStatus {
  syncNow: (silent?: boolean) => Promise<void>;
}

const PULL_INTERVAL = 10_000;

export function useSync(): SyncApi {
  const [configured, setConfigured] = useState<boolean>(() => !!getSyncConfig());
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [last, setLast] = useState<number | null>(() => lastSyncAt());
  const [error, setError] = useState<string | null>(() => lastSyncError());
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    setConfigured(!!getSyncConfig());
    setPending(await syncPending());
    setLast(lastSyncAt());
    setError(lastSyncError());
  }, []);

  const syncNow = useCallback(
    async (silent = false) => {
      const cfg = getSyncConfig();
      setConfigured(!!cfg);
      if (!cfg) return;
      if (!navigator.onLine) {
        setOnline(false);
        return;
      }
      if (busy.current) return;
      busy.current = true;
      setSyncing(true);
      try {
        await runSync(cfg);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (!silent) throw e;
      } finally {
        busy.current = false;
        setSyncing(false);
        await refresh();
      }
    },
    [refresh]
  );

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void syncNow(true);
    };
    const onOffline = () => setOnline(false);
    let debounce: number | undefined;
    const onWanted = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void syncNow(true), 700);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') void syncNow(true);
    };
    const onConfig = () => void refresh();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('yh-sync-wanted', onWanted);
    window.addEventListener('yh-sync-config', onConfig);
    document.addEventListener('visibilitychange', onVis);

    void refresh();
    if (getSyncConfig()) void syncNow(true);

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void syncNow(true);
    }, PULL_INTERVAL);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('yh-sync-wanted', onWanted);
      window.removeEventListener('yh-sync-config', onConfig);
      document.removeEventListener('visibilitychange', onVis);
      window.clearInterval(timer);
      if (debounce) window.clearTimeout(debounce);
    };
  }, [refresh, syncNow]);

  return { configured, online, syncing, pending, lastSyncAt: last, error, syncNow };
}