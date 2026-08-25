import type { PrismaService, RouteOrderRow } from '../../prisma/prisma.service';
import { OrdersService } from './orders.service';

const collector = {
  maxCapacityLiters: 100,
  status: 'ACTIVE',
  collectorWards: [{ wardId: 'ward-01', createdAt: new Date('2026-01-01'), ward: { centerLat: 10, centerLng: 106 } }],
};

function routeRow(overrides: Partial<RouteOrderRow> = {}): RouteOrderRow {
  return {
    orderId: 'order-01',
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
  const prisma = {
    collector: { findUnique: jest.fn().mockResolvedValue({ ...collector, maxCapacityLiters }) },
    findReadyOrdersForRoute,
  } as unknown as PrismaService;
  return { service: new OrdersService(prisma), findReadyOrdersForRoute };
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
});
