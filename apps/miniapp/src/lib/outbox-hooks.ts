import { useEffect, useState } from 'react';
import {
  dexieOutboxStore,
  subscribeOutbox,
  type OutboxRecord,
  type OutboxStats,
} from './outbox-db';

const emptyStats: OutboxStats = { pending: 0, syncing: 0, failed: 0, synced: 0, bytes: 0, over_limit: false };

export function useOutboxStats(): OutboxStats {
  const [stats, setStats] = useState(emptyStats);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void dexieOutboxStore.stats().then((next) => {
        if (active) {
          setStats(next);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeOutbox(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return stats;
}

export function useOutboxRows(): OutboxRecord[] {
  const [rows, setRows] = useState<OutboxRecord[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void dexieOutboxStore.list().then((next) => {
        if (active) {
          setRows(next);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeOutbox(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return rows;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  return online;
}
