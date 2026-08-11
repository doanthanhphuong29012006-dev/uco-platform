import type { CollectionCreateRequest, SyncBatchResponse } from '@eco-oil/shared-types';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_RETENTION_DAYS,
  dexieOutboxStore,
  type OutboxRecord,
  type OutboxStore,
} from './outbox-db';

export interface SyncBatchClient {
  syncBatch(items: CollectionCreateRequest[]): Promise<SyncBatchResponse>;
}

export interface SyncOutboxOptions {
  store?: OutboxStore;
  client?: SyncBatchClient;
  now?: () => Date;
}

export interface SyncSummary {
  sent: number;
  synced: number;
  failed: number;
}

let activeSync: Promise<SyncSummary> | null = null;
let workerCleanup: (() => void) | null = null;

function backoffMs(attempts: number): number {
  return Math.min(2_000 * 2 ** Math.max(attempts - 1, 0), 5 * 60 * 1_000);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Không thể đồng bộ giao dịch';
}

function failedRecord(record: OutboxRecord, message: string, now: Date): OutboxRecord {
  const attempts = record.attempts + 1;
  const terminal = attempts >= 10;
  return {
    ...record,
    status: terminal ? 'failed' : 'pending',
    attempts,
    last_error: message,
    next_attempt_at: terminal ? null : new Date(now.getTime() + backoffMs(attempts)).toISOString(),
  };
}

async function performSync({ store = dexieOutboxStore, client, now = () => new Date() }: SyncOutboxOptions): Promise<SyncSummary> {
  const currentTime = now();
  const records = await store.getPending(OUTBOX_BATCH_SIZE, currentTime);
  if (records.length === 0) {
    await store.deleteSyncedBefore(new Date(currentTime.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1_000));
    return { sent: 0, synced: 0, failed: 0 };
  }

  const syncable = records.filter((record) => record.type === 'collection');
  for (const record of records) {
    await store.update({ ...record, status: 'syncing' });
  }

  let response: SyncBatchResponse;
  try {
    const syncClient = client ?? (await import('./api')).api;
    response = await syncClient.syncBatch(syncable.map((record) => record.payload as CollectionCreateRequest));
  } catch (error) {
    for (const record of records) {
      await store.update(failedRecord(record, errorText(error), currentTime));
    }
    return { sent: syncable.length, synced: 0, failed: records.length };
  }

  const results = new Map(response.results.map((result) => [result.client_uuid, result]));
  let synced = 0;
  let failed = 0;
  for (const record of records) {
    const result = record.type === 'collection' ? results.get(record.client_uuid) : undefined;
    if (result?.status === 'created' || result?.status === 'duplicate') {
      await store.update({ ...record, status: 'synced', last_error: null, next_attempt_at: null, synced_at: currentTime.toISOString() });
      synced += 1;
      continue;
    }
    const message = record.type !== 'collection'
      ? 'Loại giao dịch chưa được hỗ trợ đồng bộ'
      : result?.error
        ? `${result.error.code}: ${result.error.message}`
        : 'Không nhận được kết quả đồng bộ cho giao dịch';
    await store.update(failedRecord(record, message, currentTime));
    failed += 1;
  }
  await store.deleteSyncedBefore(new Date(currentTime.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1_000));
  return { sent: syncable.length, synced, failed };
}

export function syncOutbox(options: SyncOutboxOptions = {}): Promise<SyncSummary> {
  if (!activeSync) {
    activeSync = performSync(options).finally(() => {
      activeSync = null;
    });
  }
  return activeSync;
}

export function startOutboxSyncWorker(): () => void {
  if (workerCleanup || typeof window === 'undefined') {
    return workerCleanup ?? (() => undefined);
  }
  const kick = () => {
    if (navigator.onLine !== false) {
      void syncOutbox();
    }
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      kick();
    }
  };
  const interval = window.setInterval(kick, 30_000);
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', onVisibilityChange);
  kick();
  workerCleanup = () => {
    window.clearInterval(interval);
    window.removeEventListener('online', kick);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    workerCleanup = null;
  };
  return workerCleanup;
}
