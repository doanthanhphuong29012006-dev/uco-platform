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

test('route progress only restores completed stops for the matching route and reconciles pending outbox rows', async () => {
  const { reconcileRouteProgress } = await loadPickupPriorityHelpers();
  const route = {
    route_id: 'route-a',
    stops: [stop({ order_id: 'order-a', route_stop_status: 'PENDING' })],
    total_expected_liters: 20,
    remaining_capacity_l: 80,
  } as never;
  const storedCompleted = {
    'order-a': { liters: 6, kilograms: 5.46, clientUuid: 'client-a', stop: stop({ order_id: 'order-a' }) },
  } as never;
  const restored = reconcileRouteProgress(route, storedCompleted, 'route-a', []);
  assert.deepEqual(restored.completedOrderIds, ['order-a']);

  const differentRoute = { ...route, route_id: 'route-b' } as never;
  assert.deepEqual(reconcileRouteProgress(differentRoute, storedCompleted, 'route-a', []).completedOrderIds, []);

  const pending = {
    client_uuid: 'client-pending',
    type: 'collection',
    status: 'pending',
    payload: { order_id: 'order-a', actual_liters: 7, actual_kg: 6.37 },
  } as never;
  const fromOutbox = reconcileRouteProgress(route, {}, 'route-a', [pending]);
  assert.equal(fromOutbox.completedOrderIds.includes('order-a'), true);
  assert.equal(fromOutbox.completed['order-a']?.liters, 7);
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

test('image grading display translates suggestion, confidence and bounded reasons', async () => {
  const { getImageGradeAnalysisDisplay } = await loadPickupPriorityHelpers();
  const display = getImageGradeAnalysisDisplay({
    suggested_grade: 'C', confidence: 'HIGH', model_version: 'oil-image-heuristic-v1', analyzed_image_count: 1,
    quality_status: 'USABLE', reason_codes: ['DARK_APPEARANCE', 'HIGH_TEXTURE_OR_SEDIMENT', 'UNKNOWN'],
    summary: 'Gợi ý thử nghiệm.', features: { mean_luminance: 0.1 },
  } as never);
  assert.deepEqual(display?.reasons, ['Màu sẫm', 'Kết cấu/cặn nổi bật']);
  assert.equal(display?.suggestedGrade, 'Hạng C');
  assert.equal(display?.confidenceLabel, 'Tin cậy cao');
  assert.equal(display?.canUseSuggestion, true);
});

test('image grading display keeps a low/null suggestion safe for manual review', async () => {
  const { getImageGradeAnalysisDisplay } = await loadPickupPriorityHelpers();
  const display = getImageGradeAnalysisDisplay({
    suggested_grade: null, confidence: 'LOW', model_version: 'oil-image-heuristic-v1', analyzed_image_count: 1,
    quality_status: 'RETAKE_RECOMMENDED', reason_codes: ['IMAGE_TOO_BLURRY'], summary: 'Nên chụp lại.', features: {},
  } as never);
  assert.equal(display?.suggestedGrade, null);
  assert.equal(display?.canUseSuggestion, false);
  assert.equal(display?.reasons[0], 'Ảnh có thể bị mờ');
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

test('route capacity risk maps levels, metrics and safe messages', async () => {
  const { getRouteCapacityRiskDisplay, formatRouteCapacityRiskLiters } = await loadPickupPriorityHelpers();
  const base = {
    predicted_total_liters: 95,
    risk_adjusted_total_liters: 112,
    risk_adjusted_remaining_liters: -12,
    risk_utilization_pct: 112.4,
    confidence: 'HIGH',
    forecast_coverage_pct: 100,
    reason_codes: [],
  } as const;

  const over = getRouteCapacityRiskDisplay({ ...base, level: 'OVER_CAPACITY' }, 100);
  assert.equal(over?.title, 'Nguy cơ quá tải');
  assert.equal(over?.tone, 'danger');
  assert.equal(over?.utilizationPct, 112);
  assert.equal(over?.message, 'Có thể vượt tải khoảng 12 lít');
  assert.equal(over?.message?.includes('-'), false);
  assert.equal(formatRouteCapacityRiskLiters(0), '0 lít');

  const near = getRouteCapacityRiskDisplay({ ...base, level: 'NEAR_CAPACITY', risk_adjusted_remaining_liters: 5.5 }, 100);
  assert.equal(near?.title, 'Xe có thể gần đầy');
  assert.equal(near?.message, 'Còn khoảng 5,5 lít dự phòng');

  const balanced = getRouteCapacityRiskDisplay({ ...base, level: 'BALANCED', risk_utilization_pct: 60, risk_adjusted_remaining_liters: 40 }, 100);
  assert.equal(balanced?.title, 'Tải xe hợp lý');
  assert.equal(balanced?.message, 'Tuyến đang sử dụng sức chứa ở mức phù hợp');

  const under = getRouteCapacityRiskDisplay({ ...base, level: 'UNDERUTILIZED', risk_utilization_pct: 0, risk_adjusted_total_liters: 0, risk_adjusted_remaining_liters: 100, forecast_coverage_pct: 0, confidence: 'LOW' }, 100);
  assert.equal(under?.title, 'Xe còn nhiều chỗ trống');
  assert.equal(under?.message, 'Còn khoảng 100 lít sức chứa');
  assert.equal(under?.coveragePct, 0);
  assert.equal(under?.utilizationPct, 0);
});

test('route capacity risk safely handles insufficient, legacy and invalid metadata', async () => {
  const { getRouteCapacityRiskDisplay } = await loadPickupPriorityHelpers();
  assert.equal(getRouteCapacityRiskDisplay({
    predicted_total_liters: null,
    risk_adjusted_total_liters: null,
    risk_adjusted_remaining_liters: null,
    risk_utilization_pct: null,
    level: 'INSUFFICIENT_DATA',
    confidence: 'INSUFFICIENT_DATA',
    forecast_coverage_pct: 0,
    reason_codes: [],
  }, 100)?.title, 'Chưa đủ dữ liệu đánh giá tải xe');
  assert.equal(getRouteCapacityRiskDisplay({
    predicted_total_liters: 10,
    risk_adjusted_total_liters: Number.NaN,
    risk_adjusted_remaining_liters: Number.POSITIVE_INFINITY,
    risk_utilization_pct: Number.NaN,
    level: 'BALANCED',
    confidence: 'MEDIUM',
    forecast_coverage_pct: 100,
    reason_codes: [],
  }, 100)?.utilizationPct, null);
  assert.equal(getRouteCapacityRiskDisplay({
    predicted_total_liters: 0,
    risk_adjusted_total_liters: 0,
    risk_adjusted_remaining_liters: 100,
    risk_utilization_pct: 0,
    level: 'INSUFFICIENT_DATA',
    confidence: 'INSUFFICIENT_DATA',
    forecast_coverage_pct: 0,
    reason_codes: ['NO_STOPS'],
  }, 100), null);
  assert.equal(getRouteCapacityRiskDisplay(undefined, 100), null);
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
  assert.deepEqual(getRouteRefreshNotice({ data: route, gpsFallback: true }, updatedAt), {
    kind: 'warning',
    message: 'Chưa lấy được GPS, tuyến đang dùng vị trí trung tâm phường.',
  });
});

test('refresh retries GPS and loads the route with the newest coordinates', async () => {
  const { getRouteRefreshNotice, refreshRouteWithLocation } = await loadPickupPriorityHelpers();
  const fallback = { lat: 21.0333, lng: 105.85 };
  const freshPoint = { lat: 21.034, lng: 105.851 };
  const loadedLocations: Array<{ lat: number; lng: number } | undefined> = [];
  const route = { route: { stops: [], total_expected_liters: 0, remaining_capacity_l: 100 }, fromCache: false, cachedAt: null } as never;
  let gpsAllowed = false;
  const load = async (point?: { lat: number; lng: number }) => {
    loadedLocations.push(point);
    return route;
  };

  const first = await refreshRouteWithLocation(
    async () => { if (!gpsAllowed) throw new Error('permission denied'); return freshPoint; },
    load,
    fallback,
  );
  assert.equal(first.gpsFallback, true);
  assert.deepEqual(first.point, fallback);
  assert.deepEqual(loadedLocations[0], fallback);
  assert.equal(getRouteRefreshNotice(first).kind, 'warning');

  gpsAllowed = true;
  const second = await refreshRouteWithLocation(async () => freshPoint, load, fallback);
  assert.equal(second.gpsFallback, false);
  assert.equal(second.gpsUpdated, true);
  assert.deepEqual(second.point, freshPoint);
  assert.deepEqual(loadedLocations[1], freshPoint);
  assert.deepEqual(getRouteRefreshNotice(second, new Date('2026-08-25T08:05:00+07:00')), {
    kind: 'success',
    message: 'Đã cập nhật GPS và tuyến lúc 08:05',
  });
});

test('location attempts are single-flight and can retry after completion', async () => {
  const { createLocationAttemptRunner } = await loadPickupPriorityHelpers();
  let calls = 0;
  let resolveLocation: ((point: { lat: number; lng: number }) => void) | null = null;
  const attempt = createLocationAttemptRunner(() => {
    calls += 1;
    if (calls > 1) return Promise.resolve({ lat: 21.0333, lng: 105.85 });
    return new Promise((resolve) => { resolveLocation = resolve; });
  });

  const first = attempt();
  const second = attempt();
  assert.equal(calls, 1);
  resolveLocation?.({ lat: 21.0333, lng: 105.85 });
  assert.deepEqual(await Promise.all([first, second]), [
    { point: { lat: 21.0333, lng: 105.85 }, failed: false },
    { point: { lat: 21.0333, lng: 105.85 }, failed: false },
  ]);
  await attempt();
  assert.equal(calls, 2);
});

test('collection save falls back instead of waiting forever for Zalo location', async () => {
  const { resolveCollectionLocation } = await loadPickupPriorityHelpers();
  const fallback = { lat: 21.0333, lng: 105.85 };
  const result = await resolveCollectionLocation(
    () => new Promise(() => undefined),
    fallback,
    10,
  );

  assert.deepEqual(result, { point: fallback, usedFallback: true });
});

test('collection save keeps a valid live location and rejects an invalid fallback', async () => {
  const { resolveCollectionLocation } = await loadPickupPriorityHelpers();
  const live = { lat: 21.034, lng: 105.851 };
  assert.deepEqual(await resolveCollectionLocation(async () => live, { lat: 0, lng: 0 }, 10), {
    point: live,
    usedFallback: false,
  });
  assert.deepEqual(await resolveCollectionLocation(async () => null, { lat: Number.NaN, lng: 105.85 }, 10), {
    point: null,
    usedFallback: false,
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

test('pickup volume deviation classifies exact boundaries and keeps signed liters', async () => {
  const { evaluatePickupVolumeDeviation } = await loadPickupPriorityHelpers();
  const forecastedStop = stop({ pickup_volume_forecast: {
    predicted_liters: 20,
    confidence: 'HIGH',
    sample_size: 5,
    reason_codes: ['HISTORY_WEIGHTED'],
  } });

  assert.equal(evaluatePickupVolumeDeviation(forecastedStop, 24)?.level, 'NORMAL');
  assert.equal(evaluatePickupVolumeDeviation(forecastedStop, 24.1)?.level, 'REVIEW');
  assert.equal(evaluatePickupVolumeDeviation(forecastedStop, 27)?.level, 'REVIEW');
  assert.equal(evaluatePickupVolumeDeviation(forecastedStop, 27.1)?.level, 'HIGH');
  assert.deepEqual(evaluatePickupVolumeDeviation(forecastedStop, 10), {
    level: 'HIGH',
    predicted_liters: 20,
    actual_liters: 10,
    deviation_liters: -10,
    deviation_pct: 0.5,
  });
});

test('pickup volume deviation uses derived liters and safely skips low-confidence or invalid metadata', async () => {
  const { evaluatePickupVolumeDeviation, getPickupVolumeDeviationKey, requiresPickupVolumeAcknowledgement } = await loadPickupPriorityHelpers();
  const highConfidenceStop = stop({ pickup_volume_forecast: {
    predicted_liters: 20,
    confidence: 'MEDIUM',
    sample_size: 3,
    reason_codes: [],
  } });
  const derivedLiters = 22.75 / 0.91;
  const high = evaluatePickupVolumeDeviation(highConfidenceStop, derivedLiters);
  assert.equal(high?.actual_liters, derivedLiters);
  assert.equal(high?.level, 'REVIEW');

  for (const confidence of ['LOW', 'INSUFFICIENT_DATA'] as const) {
    assert.equal(evaluatePickupVolumeDeviation(stop({ pickup_volume_forecast: { predicted_liters: 20, confidence, sample_size: 1, reason_codes: [] } }), 40), null);
  }
  assert.equal(evaluatePickupVolumeDeviation(stop({ pickup_volume_forecast: { predicted_liters: 20, confidence: 'HIGH', sample_size: 5, reason_codes: ['DECLARED_ESTIMATE_ONLY'] } }), 40), null);
  assert.equal(evaluatePickupVolumeDeviation(stop({ pickup_volume_forecast: { predicted_liters: 0, confidence: 'HIGH', sample_size: 5, reason_codes: [] } }), 40), null);
  assert.equal(evaluatePickupVolumeDeviation(stop({ pickup_volume_forecast: { predicted_liters: Number.NaN, confidence: 'HIGH', sample_size: 5, reason_codes: [] } }), 40), null);
  assert.equal(evaluatePickupVolumeDeviation(highConfidenceStop, Number.POSITIVE_INFINITY), null);
  assert.equal(evaluatePickupVolumeDeviation(highConfidenceStop, -1), null);

  const highResult = evaluatePickupVolumeDeviation(highConfidenceStop, 50);
  const highKey = getPickupVolumeDeviationKey(highResult);
  assert.equal(requiresPickupVolumeAcknowledgement(highResult, null), true);
  assert.equal(requiresPickupVolumeAcknowledgement(highResult, highKey), false);
  assert.equal(requiresPickupVolumeAcknowledgement(evaluatePickupVolumeDeviation(highConfidenceStop, 24), highKey), false);
  const changedHigh = evaluatePickupVolumeDeviation(highConfidenceStop, 60);
  assert.equal(requiresPickupVolumeAcknowledgement(changedHigh, highKey), true);
});
