import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionCreateRequest } from '@eco-oil/shared-types';
import { EcoOilDatabase, ecoOilDb, enqueueCollection, persistOutboxForTest, type OutboxRecord, type OutboxStats, type OutboxStore } from '../src/lib/outbox-db';

test('pending outbox payload survives a database close and reopen', async () => {
  await ecoOilDb.outbox.clear();
  const payload: CollectionCreateRequest = {
    client_uuid: '00000000-0000-4000-8000-000000000099',
    order_id: '00000000-0000-4000-8000-000000000001',
    container_code: 'ECO-UCO-Q3P7-001',
    actual_liters: 12.5,
    quality: 'PASS',
    geo: { lat: 10.78, lng: 106.68 },
    photos: ['data:image/jpeg;base64,offline-photo'],
  };

  await enqueueCollection(payload);
  ecoOilDb.close();

  const reopened = new EcoOilDatabase();
  const restored = await reopened.outbox.get(payload.client_uuid);
  assert.equal(restored?.status, 'pending');
  assert.deepEqual(restored?.payload, payload);

  await reopened.delete();
});

class RetryableStore implements OutboxStore {
  readonly records = new Map<string, OutboxRecord>();
  writes = 0;
  readonly mode: 'retry' | 'write-then-hang' | 'always-hang';

  constructor(mode: RetryableStore['mode']) {
    this.mode = mode;
  }

  async addPending(record: OutboxRecord): Promise<void> {
    this.writes += 1;
    if (this.mode === 'always-hang' || (this.mode === 'retry' && this.writes === 1) || (this.mode === 'write-then-hang' && this.writes === 1)) {
      if (this.mode === 'write-then-hang') this.records.set(record.client_uuid, structuredClone(record));
      await new Promise<void>(() => undefined);
    }
    this.records.set(record.client_uuid, structuredClone(record));
  }

  async get(clientUuid: string): Promise<OutboxRecord | undefined> {
    const record = this.records.get(clientUuid);
    return record ? structuredClone(record) : undefined;
  }

  async getPending(): Promise<OutboxRecord[]> { return []; }
  async update(record: OutboxRecord): Promise<void> { this.records.set(record.client_uuid, structuredClone(record)); }
  async list(): Promise<OutboxRecord[]> { return [...this.records.values()]; }
  async deleteSyncedBefore(): Promise<number> { return 0; }
  async stats(): Promise<OutboxStats> { return { pending: 0, syncing: 0, failed: 0, synced: 0, bytes: 0, over_limit: false }; }
}

function persistenceRecord(clientUuid: string): OutboxRecord {
  return {
    client_uuid: clientUuid,
    type: 'collection',
    payload: { client_uuid: clientUuid },
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };
}

test('first outbox write timeout reopens and retries once with the same UUID', async () => {
  const store = new RetryableStore('retry');
  const record = persistenceRecord('outbox-retry-uuid');
  const saved = await persistOutboxForTest(record, { store, reopen: () => store, timeoutMs: 10 });
  assert.equal(saved.client_uuid, record.client_uuid);
  assert.equal(store.writes, 2);
  assert.equal(store.records.size, 1);
});

test('a write that happened before timeout is read back without creating a duplicate', async () => {
  const store = new RetryableStore('write-then-hang');
  const record = persistenceRecord('outbox-write-before-timeout');
  const saved = await persistOutboxForTest(record, { store, reopen: () => store, timeoutMs: 10 });
  assert.equal(saved.client_uuid, record.client_uuid);
  assert.equal(store.writes, 1);
  assert.equal(store.records.size, 1);
});

test('two outbox write timeouts return an error after the second attempt', async () => {
  const store = new RetryableStore('always-hang');
  await assert.rejects(
    persistOutboxForTest(persistenceRecord('outbox-timeout'), { store, reopen: () => store, timeoutMs: 10 }),
    /quá thời gian|Không lưu được/i,
  );
  assert.equal(store.writes, 2);
});
