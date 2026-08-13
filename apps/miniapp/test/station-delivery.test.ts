import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitStationDelivery, retryStationDeliverySync } from '../src/lib/station-delivery';

test('retry sync resets loading on success', async () => {
  const loading: boolean[] = [];
  const errors: Array<string | null> = [];

  const result = await retryStationDeliverySync(
    async () => ({ sent: 1, synced: 1, failed: 0 }),
    (value) => loading.push(value),
    (value) => errors.push(value),
  );

  assert.equal(result, true);
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(errors, [null]);
});

test('retry sync resets loading and reports error on failure', async () => {
  const loading: boolean[] = [];
  const errors: Array<string | null> = [];

  const result = await retryStationDeliverySync(
    async () => {
      throw new Error('network down');
    },
    (value) => loading.push(value),
    (value) => errors.push(value),
  );

  assert.equal(result, false);
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(errors, [null, 'network down']);
});

test('missing evidence photo disables flagged station delivery confirmation', () => {
  assert.equal(canSubmitStationDelivery({ invalid: false, flagged: true, note: 'Lý do', photoCount: 0 }), false);
  assert.equal(canSubmitStationDelivery({ invalid: false, flagged: true, note: 'Lý do', photoCount: 1 }), true);
});
