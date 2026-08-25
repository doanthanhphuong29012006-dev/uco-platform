import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { isValidGeoPoint } from '../src/lib/zalo-client';

type PickupPriorityHelpers = typeof import('../src/pages/CollectorFlow');

async function loadPickupPriorityHelpers(): Promise<PickupPriorityHelpers> {
  const server = await createServer({
    root: process.cwd(),
    configFile: resolve('vite.config.ts'),
    server: { middlewareMode: true },
  });
  try {
    return await server.ssrLoadModule('/src/pages/CollectorFlow.tsx') as PickupPriorityHelpers;
  } finally {
    await server.close();
  }
}

function stop(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    order_id: 'order-01',
    merchant: { name: 'Quán thử nghiệm', address: 'Địa chỉ', lat: 10, lng: 106 },
    container_code: 'ECO-UCO-Q3P7-001',
    expected_liters: 20,
    priority: 10,
    distance_m: 500,
    ...overrides,
  } as never;
}

test('pickup priority maps every API level to the Vietnamese label and style', async () => {
  const { getPickupPriorityDisplay, pickupPriorityLevelLabel } = await loadPickupPriorityHelpers();
  const expected = [
    ['URGENT', 'Khẩn cấp', 'urgent'],
    ['HIGH', 'Ưu tiên cao', 'high'],
    ['NORMAL', 'Bình thường', 'normal'],
    ['LOW', 'Ưu tiên thấp', 'low'],
    ['INSUFFICIENT_DATA', 'Chưa đủ dữ liệu', 'insufficient'],
  ] as const;

  for (const [level, label, className] of expected) {
    assert.equal(pickupPriorityLevelLabel(level), label);
    assert.equal(getPickupPriorityDisplay(stop({ pickup_priority_score: 0, pickup_priority_level: level, pickup_priority_reason_codes: [] }))?.className, className);
  }
});

test('pickup priority translates reason codes and preserves unknown codes safely', async () => {
  const { getPickupPriorityDisplay, pickupPriorityReasonLabel } = await loadPickupPriorityHelpers();
  const display = getPickupPriorityDisplay(stop({
    pickup_priority_score: 85,
    pickup_priority_level: 'URGENT',
    pickup_priority_reason_codes: ['NEAR_FULL', 'UNKNOWN_REASON'],
  }));

  assert.deepEqual(display?.reasons, ['Can gần đầy', 'UNKNOWN_REASON']);
  assert.equal(pickupPriorityReasonLabel('MISSING_DISTANCE'), 'Thiếu dữ liệu khoảng cách');
});

test('legacy cached stop without AI fields keeps the old card path', async () => {
  const { getPickupPriorityDisplay } = await loadPickupPriorityHelpers();
  const legacyStop = stop();
  assert.equal(getPickupPriorityDisplay(legacyStop), null);
});

test('pickup priority display does not reorder stops and accepts insufficient data', async () => {
  const { getPickupPriorityDisplay, isValidPhone, runCollectorAction } = await loadPickupPriorityHelpers();
  const stops = [
    stop({ order_id: 'first', pickup_priority_score: 0, pickup_priority_level: 'INSUFFICIENT_DATA', pickup_priority_reason_codes: ['MISSING_FILL_DATA'] }),
    stop({ order_id: 'second', pickup_priority_score: 75, pickup_priority_level: 'HIGH', pickup_priority_reason_codes: ['HIGH_FILL'] }),
  ];

  assert.equal(stops[0].order_id, 'first');
  assert.equal(getPickupPriorityDisplay(stops[0])?.label, 'Chưa đủ dữ liệu');
  assert.equal(getPickupPriorityDisplay(stops[1])?.label, 'Ưu tiên cao');
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone('0900000001'), true);
  assert.equal(isValidGeoPoint({ lat: Number.NaN, lng: 105.85 }), false);
  assert.equal(isValidGeoPoint({ lat: 21.0333, lng: 105.85 }), true);

  const busy: boolean[] = [];
  const errors: Array<string | null> = [];
  const succeeded = await runCollectorAction(
    async () => { throw new Error('SDK failed'); },
    'Không thể mở chỉ đường. Vui lòng thử lại.',
    (value) => busy.push(value),
    (value) => errors.push(value),
  );
  assert.equal(succeeded, false);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, [null, 'Không thể mở chỉ đường. Vui lòng thử lại.']);
});
