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

test('route optimization display formats saved distance and before/after values', async () => {
  const { getRouteOptimizationDisplay, formatRouteOptimizationDistance } = await loadPickupPriorityHelpers();
  const display = getRouteOptimizationDisplay({
    optimization_applied: true,
    estimated_distance_before_m: 3_400,
    estimated_distance_after_m: 1_000,
    saved_distance_m: 2_400,
    reason_codes: ['ROUTE_OPTIMIZED'],
  });

  assert.deepEqual(display, {
    title: 'AI đã tối ưu tuyến',
    message: 'Tiết kiệm khoảng 2,4 km',
    detail: '3,4 km → 1 km',
    tone: 'success',
  });
  assert.equal(formatRouteOptimizationDistance(850), '850 m');
  assert.equal(formatRouteOptimizationDistance(2_400), '2,4 km');
});

test('route optimization display handles fallback states and never renders invalid distances', async () => {
  const { getRouteOptimizationDisplay } = await loadPickupPriorityHelpers();
  assert.deepEqual(getRouteOptimizationDisplay({
    optimization_applied: true,
    estimated_distance_before_m: 1_000,
    estimated_distance_after_m: null,
    saved_distance_m: null,
    reason_codes: ['ROUTE_OPTIMIZED'],
  }), {
    title: 'AI đã sắp xếp lại tuyến',
    message: 'Thứ tự điểm đã được tối ưu theo mức ưu tiên',
    detail: null,
    tone: 'success',
  });
  assert.deepEqual(getRouteOptimizationDisplay({
    optimization_applied: false,
    estimated_distance_before_m: 0,
    estimated_distance_after_m: 0,
    saved_distance_m: 0,
    reason_codes: ['ALREADY_OPTIMAL'],
  }), {
    title: 'Tuyến hiện tại đã tối ưu',
    message: 'Không cần thay đổi thứ tự điểm',
    detail: null,
    tone: 'success',
  });
  assert.deepEqual(getRouteOptimizationDisplay({
    optimization_applied: true,
    estimated_distance_before_m: Number.NaN,
    estimated_distance_after_m: Number.POSITIVE_INFINITY,
    saved_distance_m: -1,
    reason_codes: ['INVALID_ORIGIN'],
  }), {
    title: 'Đã ưu tiên điểm thu gom',
    message: 'Chưa thể ước tính đầy đủ quãng đường',
    detail: null,
    tone: 'warning',
  });
  assert.equal(getRouteOptimizationDisplay({
    optimization_applied: false,
    estimated_distance_before_m: null,
    estimated_distance_after_m: null,
    saved_distance_m: null,
    reason_codes: ['INSUFFICIENT_STOPS'],
  }), null);
  assert.equal(getRouteOptimizationDisplay(undefined), null);
});

test('route refresh notices distinguish fresh data, cache fallback and errors', async () => {
  const { getRouteRefreshNotice } = await loadPickupPriorityHelpers();
  const updatedAt = new Date('2026-08-25T08:05:00+07:00');
  const route = { route: { stops: [], total_expected_liters: 0, remaining_capacity_l: 100 }, fromCache: false, cachedAt: null } as never;
  assert.deepEqual(getRouteRefreshNotice({ data: route }, updatedAt), {
    kind: 'success',
    message: 'Đã cập nhật tuyến lúc 08:05',
  });
  assert.deepEqual(getRouteRefreshNotice({ data: { ...route, fromCache: true, cachedAt: '2026-08-25T07:00:00+07:00' } }, updatedAt), {
    kind: 'cache',
    message: 'Không kết nối được máy chủ, đang dùng tuyến đã lưu.',
  });
  assert.deepEqual(getRouteRefreshNotice({ error: new Error('offline') }, updatedAt), {
    kind: 'error',
    message: 'Không thể tải lại tuyến. Vui lòng kiểm tra mạng và thử lại.',
  });
});

test('route refresh runner is single-flight and can retry after an error', async () => {
  const { createRouteRefreshRunner } = await loadPickupPriorityHelpers();
  let calls = 0;
  let rejectRequest: ((error: Error) => void) | null = null;
  const states: Array<{ busy: boolean; notice: { kind: string } | null }> = [];
  const runner = createRouteRefreshRunner(
    () => {
      calls += 1;
      return new Promise((_, reject) => { rejectRequest = reject; });
    },
    (state) => { states.push(state as { busy: boolean; notice: { kind: string } | null }); },
  );

  const first = runner();
  const second = runner();
  assert.equal(calls, 1);
  rejectRequest?.(new Error('offline'));
  await Promise.all([first, second]);
  assert.equal(states.at(-1)?.notice?.kind, 'error');

  const retry = runner();
  assert.notEqual(retry, first);
  assert.equal(calls, 2);
  rejectRequest?.(new Error('offline again'));
  await retry;
  assert.equal(states.at(-1)?.busy, false);
});

test('pickup volume forecast maps confidence, formats liters and limits reason chips', async () => {
  const { getPickupVolumeForecastDisplay, formatPickupVolumeLiters } = await loadPickupPriorityHelpers();
  const display = getPickupVolumeForecastDisplay(stop({
    pickup_volume_forecast: {
      predicted_liters: 14.8,
      confidence: 'HIGH',
      sample_size: 5,
      reason_codes: ['HISTORY_WEIGHTED', 'STABLE_HISTORY', 'PREDICTION_CAPPED_TO_CAPACITY', 'UNKNOWN_REASON'],
    },
  }));

  assert.equal(formatPickupVolumeLiters(15), '15 lít');
  assert.equal(formatPickupVolumeLiters(14.8), '14,8 lít');
  assert.deepEqual(display, {
    predictedLiters: 14.8,
    confidenceLabel: 'Tin cậy cao',
    className: 'high',
    sampleSize: 5,
    declaredOnly: false,
    reasons: ['Dựa trên lịch sử gần đây', 'Sản lượng khá ổn định'],
  });
});

test('pickup volume forecast maps all confidence labels and declared-only messaging', async () => {
  const { getPickupVolumeForecastDisplay } = await loadPickupPriorityHelpers();
  const cases = [
    ['MEDIUM', 'Tin cậy trung bình', 'medium'],
    ['LOW', 'Tin cậy thấp', 'low'],
    ['INSUFFICIENT_DATA', 'Chưa đủ dữ liệu', 'insufficient'],
  ] as const;
  for (const [confidence, label, className] of cases) {
    const display = getPickupVolumeForecastDisplay(stop({ pickup_volume_forecast: { predicted_liters: 15, confidence, sample_size: 3, reason_codes: [] } }));
    assert.equal(display?.confidenceLabel, label);
    assert.equal(display?.className, className);
  }

  const declaredOnly = getPickupVolumeForecastDisplay(stop({ pickup_volume_forecast: {
    predicted_liters: 20,
    confidence: 'HIGH',
    sample_size: 0,
    reason_codes: ['DECLARED_ESTIMATE_ONLY', 'HISTORY_WEIGHTED'],
  } }));
  assert.equal(declaredOnly?.confidenceLabel, 'Tin cậy thấp');
  assert.equal(declaredOnly?.declaredOnly, true);
  assert.deepEqual(declaredOnly?.reasons, ['Tạm tính theo số quán khai', 'Dựa trên lịch sử gần đây']);
});

test('pickup volume forecast handles null, legacy metadata and invalid values safely', async () => {
  const { getPickupVolumeForecastDisplay, formatPickupVolumeLiters } = await loadPickupPriorityHelpers();
  assert.deepEqual(getPickupVolumeForecastDisplay(stop({ pickup_volume_forecast: {
    predicted_liters: null,
    confidence: 'INSUFFICIENT_DATA',
    sample_size: 0,
    reason_codes: ['MISSING_HISTORY_AND_ESTIMATE'],
  } })), {
    predictedLiters: null,
    confidenceLabel: 'Chưa đủ dữ liệu',
    className: 'insufficient',
    sampleSize: null,
    declaredOnly: false,
    reasons: [],
  });
  assert.equal(getPickupVolumeForecastDisplay(stop()), null);
  assert.equal(formatPickupVolumeLiters(0), '0 lít');
  assert.equal(formatPickupVolumeLiters(-1), null);
  assert.equal(formatPickupVolumeLiters(Number.NaN), null);
  assert.equal(formatPickupVolumeLiters(Number.POSITIVE_INFINITY), null);
});
