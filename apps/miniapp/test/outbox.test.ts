import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionCreateRequest, StationDeliveryCreateRequest, StationDeliveryResponse, SyncBatchResponse } from '@eco-oil/shared-types';
import { syncOutbox, type SyncBatchClient } from '../src/lib/outbox-sync';
import { outboxErrorMessage } from '../src/lib/outbox-errors';
import type { OutboxRecord, OutboxStats, OutboxStore } from '../src/lib/outbox-db';

class MemoryOutboxStore implements OutboxStore {
  readonly records = new Map<string, OutboxRecord>();

  constructor(records: OutboxRecord[]) {
    for (const record of records) {
      this.records.set(record.client_uuid, structuredClone(record));
    }
  }

  async addPending(record: OutboxRecord): Promise<void> {
    this.records.set(record.client_uuid, structuredClone(record));
  }

  async getPending(limit: number, now: Date): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' && (!record.next_attempt_at || new Date(record.next_attempt_at) <= now))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async get(clientUuid: string): Promise<OutboxRecord | undefined> {
    const record = this.records.get(clientUuid);
    return record ? structuredClone(record) : undefined;
  }

  async update(record: OutboxRecord): Promise<void> {
    this.records.set(record.client_uuid, structuredClone(record));
  }

  async list(): Promise<OutboxRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async deleteSyncedBefore(): Promise<number> {
    return 0;
  }

  async stats(): Promise<OutboxStats> {
    const records = [...this.records.values()];
    return {
      pending: records.filter((record) => record.status === 'pending').length,
      syncing: records.filter((record) => record.status === 'syncing').length,
      failed: records.filter((record) => record.status === 'failed').length,
      synced: records.filter((record) => record.status === 'synced').length,
      bytes: 0,
      over_limit: false,
    };
  }

  async recoverStaleSyncing(now: Date): Promise<number> {
    let recovered = 0;
    for (const record of this.records.values()) {
      const startedAt = record.sync_started_at ?? record.updated_at ?? record.created_at;
      if (record.status === 'syncing' && new Date(startedAt).getTime() <= now.getTime() - 60_000) {
        this.records.set(record.client_uuid, { ...record, status: 'pending', sync_started_at: null, updated_at: now.toISOString() });
        recovered += 1;
      }
    }
    return recovered;
  }
}

function record(clientUuid: string): OutboxRecord {
  const payload: CollectionCreateRequest = {
    client_uuid: clientUuid,
    order_id: '00000000-0000-4000-8000-000000000001',
    container_code: 'ECO-UCO-Q3P7-001',
    actual_liters: 10.5,
    grade: 'A',
    collector_selected_grade: 'A',
    collector_grade_confirmed: true,
    quality: 'PASS',
    geo: { lat: 10.78, lng: 106.68 },
    photos: [],
  };
  return {
    client_uuid: clientUuid,
    type: 'collection',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };
}

function response(records: OutboxRecord[], status: 'created' | 'duplicate' = 'created'): SyncBatchResponse {
  return {
    results: records.map((item) => ({ client_uuid: item.client_uuid, status, id: `transaction-${item.client_uuid}` })),
    summary: { created: status === 'created' ? records.length : 0, duplicate: status === 'duplicate' ? records.length : 0, failed: 0 },
  };
}

test('3 pending rows are sent in one batch and marked synced', async () => {
  const records = [record(crypto.randomUUID()), record(crypto.randomUUID()), record(crypto.randomUUID())];
  const store = new MemoryOutboxStore(records);
  let calls = 0;
  const client: SyncBatchClient = { syncBatch: async (items) => { calls += 1; return response(items.map((payload) => record(payload.client_uuid))); } };

  await syncOutbox({ store, client });

  assert.equal(calls, 1);
  assert.equal((await store.stats()).synced, 3);
});

test('server duplicate is success and is not sent again', async () => {
  const source = record(crypto.randomUUID());
  const store = new MemoryOutboxStore([source]);
  let calls = 0;
  const client: SyncBatchClient = { syncBatch: async (items) => { calls += 1; return response(items.map((payload) => record(payload.client_uuid)), 'duplicate'); } };

  await syncOutbox({ store, client });
  await syncOutbox({ store, client });

  assert.equal(calls, 1);
  assert.equal((await store.get(source.client_uuid))?.status, 'synced');
});

test('concurrent syncOutbox calls send only one real request', async () => {
  const source = record(crypto.randomUUID());
  const store = new MemoryOutboxStore([source]);
  let calls = 0;
  let release!: (value: SyncBatchResponse) => void;
  const client: SyncBatchClient = {
    syncBatch: async (items) => {
      calls += 1;
      return new Promise<SyncBatchResponse>((resolve) => {
        release = () => resolve(response(items.map((payload) => record(payload.client_uuid))));
      });
    },
  };

  const first = syncOutbox({ store, client });
  const second = syncOutbox({ store, client });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(response([source]));
  await Promise.all([first, second]);
  assert.equal((await store.get(source.client_uuid))?.status, 'synced');
});

test('network failure keeps the original payload and retries later', async () => {
  const source = record(crypto.randomUUID());
  const store = new MemoryOutboxStore([source]);
  const client: SyncBatchClient = { syncBatch: async () => { throw new TypeError('Failed to fetch'); } };

  await syncOutbox({ store, client });

  const saved = await store.get(source.client_uuid);
  assert.equal(saved?.status, 'pending');
  assert.equal(saved?.attempts, 1);
  assert.equal(saved?.last_error, 'Failed to fetch');
  assert.deepEqual(saved?.payload, source.payload);
});

test('station delivery rows use the delivery endpoint and retain the server receipt', async () => {
  const clientUuid = crypto.randomUUID();
  const payload: StationDeliveryCreateRequest = {
    client_uuid: clientUuid,
    station_id: '00000000-0000-4000-8000-000000000002',
    transaction_ids: ['00000000-0000-4000-8000-000000000003'],
    actual_liters: 10,
    note: 'Khớp số lít',
    photos: [],
  };
  const source: OutboxRecord = {
    client_uuid: clientUuid,
    type: 'station_delivery',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };
  const store = new MemoryOutboxStore([source]);
  let calls = 0;
  const serverResponse: StationDeliveryResponse = {
    ...payload,
    id: 'delivery-1',
    collector_id: 'collector-1',
    expected_liters: 10,
    variance_l: 0,
    variance_pct: 0,
    status: 'OK',
    created_at: new Date().toISOString(),
  };
  const client: SyncBatchClient = {
    syncBatch: async () => { throw new Error('collection endpoint must not receive a station delivery'); },
    createStationDelivery: async () => { calls += 1; return serverResponse; },
  };

  await syncOutbox({ store, client });

  const saved = await store.get(clientUuid);
  assert.equal(calls, 1);
  assert.equal(saved?.status, 'synced');
  assert.equal(saved?.server_id, 'delivery-1');
  assert.deepEqual(saved?.server_response, serverResponse);
});

test('stale syncing rows are recovered to pending before the worker sends them', async () => {
  const source = { ...record(crypto.randomUUID()), status: 'syncing' as const, sync_started_at: '2026-08-26T07:00:00.000Z' };
  const store = new MemoryOutboxStore([source]);
  const result = await syncOutbox({
    store,
    now: () => new Date('2026-08-26T08:01:01.000Z'),
    client: { syncBatch: async (items) => response(items.map((payload) => record(payload.client_uuid))) },
  });
  assert.equal(result.synced, 1);
  assert.equal((await store.get(source.client_uuid))?.status, 'synced');
});

test('sync timeout releases active sync and returns a row to pending for retry', async () => {
  const source = record(crypto.randomUUID());
  const store = new MemoryOutboxStore([source]);
  const result = await syncOutbox({
    store,
    syncTimeoutMs: 10,
    client: { syncBatch: async () => new Promise<SyncBatchResponse>(() => undefined) },
  });
  assert.equal(result.failed, 1);
  assert.equal((await store.get(source.client_uuid))?.status, 'pending');
  assert.match((await store.get(source.client_uuid))?.last_error ?? '', /thời gian/);
});

test('payload-too-large sync errors are translated to a Vietnamese actionable message', () => {
  assert.equal(
    outboxErrorMessage('PAYLOAD_TOO_LARGE: Request body exceeds 10mb'),
    'Ảnh hoặc dữ liệu giao dịch vượt giới hạn máy chủ. Hãy giảm kích thước ảnh rồi thử lại.',
  );
});
