import assert from 'node:assert/strict';
import test from 'node:test';
import { requireConfirmedMerchantLocation } from '../src/lib/merchant-location';

test('registration uses an explicitly confirmed real point without fetching another token', () => {
  const point = { lat: 21.03, lng: 105.85 };
  assert.deepEqual(requireConfirmedMerchantLocation({ point, capturedAt: 1000, confirmed: true }, 2000), point);
  assert.throws(() => requireConfirmedMerchantLocation({ point, capturedAt: 1000, confirmed: false }, 2000), /xác nhận/);
  assert.throws(() => requireConfirmedMerchantLocation(null), /xác nhận/);
  assert.throws(() => requireConfirmedMerchantLocation({ point, capturedAt: 1000, confirmed: true }, 31 * 60_000), /đã cũ/);
});
