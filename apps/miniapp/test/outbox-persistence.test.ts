import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionCreateRequest } from '@eco-oil/shared-types';
import { EcoOilDatabase, ecoOilDb, enqueueCollection } from '../src/lib/outbox-db';

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
