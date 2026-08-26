import type { PrismaService, RouteOrderRow } from '../../prisma/prisma.service';
import { OrdersService } from './orders.service';

const collector = {
  id: 'collector-01',
  maxCapacityLiters: 100,
  status: 'ACTIVE',
  collectorWards: [{ wardId: 'ward-01', createdAt: new Date('2026-01-01'), ward: { centerLat: 10, centerLng: 106 } }],
};

function routeRow(overrides: Partial<RouteOrderRow> = {}): RouteOrderRow {
  return {
    orderId: 'order-01',
    merchantId: 'merchant-01',
    merchantName: 'Quán thử nghiệm',
    merchantAddress: 'Địa chỉ thử nghiệm',
    merchantPhone: '0900000000',
    merchantLat: 10.1,
    merchantLng: 106.1,
    wardCenterLat: 10,
    wardCenterLng: 106,
    containerCode: 'ECO-UCO-Q3P7-001',
    expectedLiters: 20,
    containerCapacityLiters: 30,
    lastCollectedAt: null,
    priority: 10,
    distanceM: 1_000,
    ...overrides,
  };
}

function createService(rows: RouteOrderRow[], maxCapacityLiters = 100) {
  const findReadyOrdersForRoute = jest.fn().mockResolvedValue(rows);
  const findRecentCollectionHistoryByMerchantIds = jest.fn().mockResolvedValue([]);
  const prisma = {
    collector: { findUnique: jest.fn().mockResolvedValue({ ...collector, maxCapacityLiters }) },
    collectionRoute: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    findReadyOrdersForRoute,
    findRecentCollectionHistoryByMerchantIds,
  } as unknown as PrismaService;
  return { service: new OrdersService(prisma), findReadyOrdersForRoute, findRecentCollectionHistoryByMerchantIds };
}

function persistedRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-01',
    clientUuid: '11111111-1111-4111-8111-111111111111',
    status: 'ACTIVE',
    originLat: 10,
    originLng: 106,
    vehicleCapacityLiters: 100,
    totalExpectedLiters: 20,
    remainingCapacityLiters: 80,
    optimizationSnapshot: { optimization_applied: false, reason_codes: ['INSUFFICIENT_STOPS'] },
    capacityRiskSnapshot: { level: 'UNDERUTILIZED', confidence: 'LOW', forecast_coverage_pct: 0, reason_codes: [] },
    startedAt: new Date('2026-08-26T08:00:00.000Z'),
    completedAt: null,
    cancelledAt: null,
    stops: [{
      orderId: 'order-01', sequence: 1, expectedLiters: 20,
      merchantSnapshot: { name: 'Quán thử nghiệm', address: 'Địa chỉ', phone: '0900000001', lat: 10, lng: 106, container_code: 'ECO-UCO-Q3P7-001', distance_m: 1000, ward_center: { lat: 10, lng: 106 } },
      aiSnapshot: { priority: 10, pickup_priority_score: 25, pickup_priority_level: 'NORMAL', pickup_priority_reason_codes: [], pickup_volume_forecast: { predicted_liters: 20, confidence: 'LOW', sample_size: 0, reason_codes: ['DECLARED_ESTIMATE_ONLY'] } },
      status: 'PENDING', collectedAt: null, skippedAt: null, skipReason: null,
    }],
    ...overrides,
  };
}

function createLifecycleService() {
  const route = persistedRoute();
  const tx = {
    collectionOrder: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    collectionRoute: {
      create: jest.fn().mockResolvedValue(route),
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(route),
    },
    collectionRouteStop: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn() },
  };
  const prisma = {
    collector: { findUnique: jest.fn().mockResolvedValue({ ...collector, id: 'collector-01' }) },
    collectionRoute: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    findReadyOrdersForRoute: jest.fn().mockResolvedValue([routeRow()]),
    findRecentCollectionHistoryByMerchantIds: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  return { service: new OrdersService(prisma), prisma, tx, route };
}

describe('OrdersService currentRoute pickup priority', () => {
  it('adds AI fields and sorts urgent before lower scores without N+1 queries', async () => {
    const rows = [
      routeRow({ orderId: 'normal-far', expectedLiters: 15, containerCapacityLiters: 30, distanceM: 500, priority: 99 }),
      routeRow({ orderId: 'urgent-far', expectedLiters: 30, containerCapacityLiters: 30, lastCollectedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000), distanceM: 10_000, priority: 1 }),
    ];
    const { service, findReadyOrdersForRoute } = createService(rows);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(findReadyOrdersForRoute).toHaveBeenCalledTimes(1);
    expect(result.stops.map((stop) => stop.order_id)).toEqual(['urgent-far', 'normal-far']);
    expect(result.stops[0]).toMatchObject({
      pickup_priority_score: 85,
      pickup_priority_level: 'URGENT',
      pickup_priority_reason_codes: ['NEAR_FULL', 'OVERDUE_COLLECTION'],
    });
    expect(result.stops[0]).toHaveProperty('priority', 1);
    expect(result.stops[0]).toHaveProperty('merchant');
    expect(result.stops[0]).toHaveProperty('container_code');
    expect(result.stops[0]).toHaveProperty('expected_liters');
    expect(result.stops[0]).toHaveProperty('distance_m');
    expect(result.route_optimization).toMatchObject({ optimization_applied: false, reason_codes: ['ALREADY_OPTIMAL'] });
  });

  it('uses legacy priority, then distance, then original order for ties and renumbers seq', async () => {
    const rows = [
      routeRow({ orderId: 'legacy-low', expectedLiters: 15, priority: 1, distanceM: 6_000 }),
      routeRow({ orderId: 'legacy-high', expectedLiters: 15, priority: 9, distanceM: 7_000 }),
      routeRow({ orderId: 'same-priority-near', expectedLiters: 15, priority: 9, distanceM: 6_000 }),
      routeRow({ orderId: 'same-all-first', expectedLiters: 15, priority: 9, distanceM: 6_000 }),
      routeRow({ orderId: 'same-all-second', expectedLiters: 15, priority: 9, distanceM: 6_000 }),
    ];
    const { service } = createService(rows);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops.map((stop) => stop.order_id)).toEqual([
      'same-priority-near',
      'same-all-first',
      'same-all-second',
      'legacy-high',
      'legacy-low',
    ]);
    expect(result.stops.map((stop) => stop.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(result.route_optimization).toMatchObject({ optimization_applied: false, reason_codes: ['ALREADY_OPTIMAL'] });
  });

  it('returns insufficient data for null capacity, clamps future collection to zero, and keeps truck limit', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000);
    const rows = [
      routeRow({ orderId: 'missing-capacity', expectedLiters: 20, containerCapacityLiters: null, lastCollectedAt: future, distanceM: 1_000 }),
      routeRow({ orderId: 'full-capacity', expectedLiters: 30, containerCapacityLiters: 30, lastCollectedAt: future, distanceM: 2_000 }),
      routeRow({ orderId: 'over-limit', expectedLiters: 80, containerCapacityLiters: 100, distanceM: 3_000 }),
    ];
    const { service } = createService(rows, 50);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]).toMatchObject({ order_id: 'full-capacity', pickup_priority_level: 'HIGH' });
    expect(result.total_expected_liters).toBeLessThanOrEqual(50);
    expect(result.route_optimization?.reason_codes).toContain('INSUFFICIENT_STOPS');
  });

  it('passes null history for a never-collected merchant and clamps a future date to zero days', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000);
    const rows = [
      routeRow({ orderId: 'never-collected', expectedLiters: 15, containerCapacityLiters: 30, lastCollectedAt: null, distanceM: 10_000 }),
      routeRow({ orderId: 'future-collected', expectedLiters: 15, containerCapacityLiters: 30, lastCollectedAt: future, distanceM: 10_000 }),
    ];
    const { service } = createService(rows);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    const neverCollected = result.stops.find((stop) => stop.order_id === 'never-collected');
    const futureCollected = result.stops.find((stop) => stop.order_id === 'future-collected');

    expect(neverCollected?.pickup_priority_reason_codes).toContain('MISSING_COLLECTION_HISTORY');
    expect(futureCollected?.pickup_priority_reason_codes).not.toContain('MISSING_COLLECTION_HISTORY');
    expect(neverCollected?.pickup_priority_score).toBe(futureCollected?.pickup_priority_score);
  });

  it('optimizes selected stops within their priority group without changing the selected set or totals', async () => {
    const rows = [
      routeRow({ orderId: 'near-origin', expectedLiters: 10, merchantLat: 10.001, merchantLng: 106.001, distanceM: 1_000 }),
      routeRow({ orderId: 'far', expectedLiters: 10, merchantLat: 10.01, merchantLng: 106.01, distanceM: 2_000 }),
      routeRow({ orderId: 'near-far', expectedLiters: 10, merchantLat: 10.009, merchantLng: 106.009, distanceM: 3_000 }),
    ];
    const { service } = createService(rows, 30);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops.map((stop) => stop.order_id)).toEqual(['near-origin', 'near-far', 'far']);
    expect(new Set(result.stops.map((stop) => stop.order_id))).toEqual(new Set(rows.map((row) => row.orderId)));
    expect(result.stops.map((stop) => stop.seq)).toEqual([1, 2, 3]);
    expect(result.total_expected_liters).toBe(30);
    expect(result.remaining_capacity_l).toBe(0);
    expect(result.route_optimization).toMatchObject({ optimization_applied: true, reason_codes: ['ROUTE_OPTIMIZED'] });
    expect(result.route_optimization?.estimated_distance_after_m).toBeLessThanOrEqual(result.route_optimization?.estimated_distance_before_m ?? Infinity);
  });

  it('keeps a low-priority nearby stop after an urgent stop and preserves stop fields', async () => {
    const rows = [
      routeRow({ orderId: 'low-near', expectedLiters: 5, containerCapacityLiters: 30, merchantLat: 10.001, merchantLng: 106.001, distanceM: 100 }),
      routeRow({ orderId: 'urgent-far', expectedLiters: 30, containerCapacityLiters: 30, merchantLat: 10.02, merchantLng: 106.02, distanceM: 20_000, lastCollectedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000), priority: 1 }),
    ];
    const { service } = createService(rows, 35);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops.map((stop) => stop.order_id)).toEqual(['urgent-far', 'low-near']);
    expect(result.stops[0]).toMatchObject({
      pickup_priority_level: 'URGENT',
      merchant: { phone: '0900000000' },
      ward_center: { lat: 10, lng: 106 },
    });
  });

  it('returns safe metadata for an invalid stop coordinate without crashing', async () => {
    const rows = [
      routeRow({ orderId: 'invalid-coordinate', merchantLat: Number.NaN }),
      routeRow({ orderId: 'valid-coordinate', merchantLat: 10.2, merchantLng: 106.2, distanceM: 2_000 }),
    ];
    const { service } = createService(rows);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops).toHaveLength(2);
    expect(result.route_optimization).toMatchObject({
      estimated_distance_before_m: null,
      estimated_distance_after_m: null,
      saved_distance_m: null,
    });
    expect(result.route_optimization?.optimization_applied).toBe(true);
    expect(result.route_optimization?.reason_codes).toEqual(['ROUTE_OPTIMIZED', 'INVALID_STOP_COORDINATES']);
    expect(result.stops.map((stop) => stop.seq)).toEqual([1, 2]);
  });

  it('adds volume forecasts from one batched history query without changing route totals or priority', async () => {
    const rows = [
      routeRow({ orderId: 'merchant-a-order-1', merchantId: 'merchant-a', expectedLiters: 20, priority: 9 }),
      routeRow({ orderId: 'merchant-a-order-2', merchantId: 'merchant-a', expectedLiters: 15, priority: 8 }),
      routeRow({ orderId: 'merchant-b-order', merchantId: 'merchant-b', expectedLiters: 10, priority: 7 }),
    ];
    const { service, findRecentCollectionHistoryByMerchantIds } = createService(rows, 100);
    findRecentCollectionHistoryByMerchantIds.mockResolvedValue([
      { merchantId: 'merchant-a', actualLiters: 20, collectedAt: new Date('2026-01-09') },
      { merchantId: 'merchant-a', actualLiters: 20, collectedAt: new Date('2026-01-08') },
      { merchantId: 'merchant-a', actualLiters: 20, collectedAt: new Date('2026-01-07') },
      { merchantId: 'merchant-a', actualLiters: 20, collectedAt: new Date('2026-01-06') },
      { merchantId: 'merchant-a', actualLiters: 20, collectedAt: new Date('2026-01-05') },
      { merchantId: 'merchant-b', actualLiters: 10, collectedAt: new Date('2026-01-09') },
      { merchantId: 'merchant-b', actualLiters: 10, collectedAt: new Date('2026-01-08') },
      { merchantId: 'merchant-b', actualLiters: 10, collectedAt: new Date('2026-01-07') },
    ]);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(findRecentCollectionHistoryByMerchantIds).toHaveBeenCalledTimes(1);
    expect(findRecentCollectionHistoryByMerchantIds).toHaveBeenCalledWith(['merchant-a', 'merchant-b']);
    expect(result.stops).toHaveLength(3);
    expect(result.stops.every((stop) => stop.pickup_volume_forecast)).toBe(true);
    expect(result.stops.find((stop) => stop.order_id === 'merchant-a-order-1')?.pickup_volume_forecast).toMatchObject({
      predicted_liters: 20,
      confidence: 'HIGH',
      sample_size: 5,
    });
    expect(result.stops.find((stop) => stop.order_id === 'merchant-b-order')?.pickup_volume_forecast).toMatchObject({
      predicted_liters: 10,
      confidence: 'MEDIUM',
      sample_size: 3,
    });
    expect(result.stops.map((stop) => stop.expected_liters)).toEqual([20, 15, 10]);
    expect(result.total_expected_liters).toBe(45);
    expect(result.remaining_capacity_l).toBe(55);
    expect(result.stops[0]).toHaveProperty('pickup_priority_score');
    expect(result.stops[0].merchant.phone).toBe('0900000000');
    expect(result.stops[0].ward_center).toEqual({ lat: 10, lng: 106 });
    expect(result.route_optimization).toBeDefined();
  });

  it('uses declared estimate with LOW confidence when a merchant has no history', async () => {
    const rows = [routeRow({ merchantId: 'merchant-without-history', expectedLiters: 18 })];
    const { service, findRecentCollectionHistoryByMerchantIds } = createService(rows);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(findRecentCollectionHistoryByMerchantIds).toHaveBeenCalledTimes(1);
    expect(result.stops[0]?.pickup_volume_forecast).toEqual({
      predicted_liters: 18,
      confidence: 'LOW',
      sample_size: 0,
      reason_codes: ['DECLARED_ESTIMATE_ONLY', 'LIMITED_HISTORY'],
    });
  });

  it('keeps only five recent history samples per merchant in the forecast', async () => {
    const rows = [routeRow({ merchantId: 'merchant-a', expectedLiters: 10 })];
    const { service, findRecentCollectionHistoryByMerchantIds } = createService(rows);
    findRecentCollectionHistoryByMerchantIds.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        merchantId: 'merchant-a',
        actualLiters: 10,
        collectedAt: new Date(`2026-01-${String(9 - index).padStart(2, '0')}`),
      })),
    );

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops[0]?.pickup_volume_forecast?.sample_size).toBe(5);
  });

  it('does not query history for an empty route', async () => {
    const { service, findRecentCollectionHistoryByMerchantIds } = createService([]);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.stops).toEqual([]);
    expect(findRecentCollectionHistoryByMerchantIds).not.toHaveBeenCalled();
    expect(result.route_capacity_risk).toEqual({
      predicted_total_liters: 0,
      risk_adjusted_total_liters: 0,
      risk_adjusted_remaining_liters: 100,
      risk_utilization_pct: 0,
      level: 'INSUFFICIENT_DATA',
      confidence: 'INSUFFICIENT_DATA',
      forecast_coverage_pct: 0,
      reason_codes: ['NO_STOPS'],
    });
  });

  it.each([
    [10, 'UNDERUTILIZED'],
    [60, 'BALANCED'],
    [70, 'NEAR_CAPACITY'],
    [100, 'OVER_CAPACITY'],
  ] as const)('assesses route capacity risk at %s declared liters as %s', async (expectedLiters, level) => {
    const { service } = createService([routeRow({ expectedLiters, containerCapacityLiters: null })], 100);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(result.route_capacity_risk?.level).toBe(level);
    expect(result.stops[0]?.expected_liters).toBe(expectedLiters);
    expect(result.total_expected_liters).toBe(expectedLiters);
    expect(result.remaining_capacity_l).toBe(100 - expectedLiters);
    if (level === 'OVER_CAPACITY') {
      expect(result.route_capacity_risk?.risk_adjusted_remaining_liters).toBe(-25);
    }
  });

  it('reuses the existing forecasts for risk without another history query', async () => {
    const rows = [
      routeRow({ orderId: 'risk-a', merchantId: 'merchant-a', expectedLiters: 20 }),
      routeRow({ orderId: 'risk-b', merchantId: 'merchant-b', expectedLiters: 30 }),
    ];
    const { service, findRecentCollectionHistoryByMerchantIds } = createService(rows, 100);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, {});

    expect(findRecentCollectionHistoryByMerchantIds).toHaveBeenCalledTimes(1);
    expect(result.route_capacity_risk).toMatchObject({
      predicted_total_liters: 50,
      risk_adjusted_total_liters: 54,
      risk_utilization_pct: 54,
      level: 'UNDERUTILIZED',
      confidence: 'LOW',
      forecast_coverage_pct: 100,
    });
    expect(result.stops.map((stop) => stop.order_id)).toEqual(['risk-b', 'risk-a']);
    expect(result.stops.map((stop) => stop.seq)).toEqual([1, 2]);
    expect(result.route_optimization).toBeDefined();
  });
});

describe('OrdersService persisted collection route lifecycle', () => {
  it('starts one server-owned route and returns the persisted snapshot', async () => {
    const { service, prisma, tx } = createLifecycleService();
    const result = await service.startRoute({ sub: 'collector-user' } as never, {
      client_uuid: '22222222-2222-4222-8222-222222222222', lat: 10, lng: 106,
    });

    expect(result.persisted).toBe(true);
    expect(result.route_status).toBe('ACTIVE');
    expect(result.stops.map((stop) => stop.order_id)).toEqual(['order-01']);
    expect((prisma as unknown as { collectionRoute: { findFirst: jest.Mock } }).collectionRoute.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.collectionOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'READY' }),
      data: expect.objectContaining({ status: 'ASSIGNED', collectorId: 'collector-01' }),
    }));
  });

  it('returns the active snapshot on reload without recomputing preview or history', async () => {
    const { service, prisma, route } = createLifecycleService();
    const db = prisma as unknown as { collectionRoute: { findFirst: jest.Mock }; findReadyOrdersForRoute: jest.Mock; findRecentCollectionHistoryByMerchantIds: jest.Mock };
    db.collectionRoute.findFirst.mockResolvedValue(route);

    const result = await service.currentRoute({ sub: 'collector-user' } as never, { lat: 99, lng: 99 } as never);

    expect(result.persisted).toBe(true);
    expect(result.route_id).toBe('route-01');
    expect(result.stops[0]).toMatchObject({ order_id: 'order-01', priority: 10, merchant: { phone: '0900000001' } });
    expect(db.findReadyOrdersForRoute).not.toHaveBeenCalled();
    expect(db.findRecentCollectionHistoryByMerchantIds).not.toHaveBeenCalled();
  });
});
