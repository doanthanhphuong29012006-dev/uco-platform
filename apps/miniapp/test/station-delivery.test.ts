import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitStationDelivery, loadStationRecommendations, resolveStationSearchLocation, retryStationDeliverySync } from '../src/lib/station-delivery';

const station = {
  id: 'station-01',
  name: 'Trạm Eco-Oil',
  address: 'Phường 7, Quận 3',
  lat: 10.7769,
  lng: 106.7009,
  capacity_l: 1000,
  current_volume_l: 100,
  remaining_capacity_l: 900,
  distance_m: 750,
};

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

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

test('station recommendation request stops loading and exposes retryable error', async () => {
  const loading: boolean[] = [];
  const result = await loadStationRecommendations(
    async () => { throw new Error('Mất kết nối máy chủ'); },
    (value) => loading.push(value),
  );

  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(result, { status: 'error', stations: [], error: 'Mất kết nối máy chủ' });
});

test('empty station recommendation response has an explicit empty state', async () => {
  const loading: boolean[] = [];
  const result = await loadStationRecommendations(async () => [], (value) => loading.push(value));

  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(result, { status: 'empty', stations: [], error: null });
});

test('station recommendation success returns stations and stops loading', async () => {
  const loading: boolean[] = [];
  const result = await loadStationRecommendations(async () => [station], (value) => loading.push(value));

  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(result, { status: 'success', stations: [station], error: null });
});

test('GPS failure uses the ward fallback to load station recommendations', async () => {
  const fallback = { lat: 21.0333, lng: 105.85 };
  const resolved = await resolveStationSearchLocation(
    async () => { throw new Error('Zalo location permission denied'); },
    fallback,
  );
  let requestLocation: typeof fallback | null = null;
  const result = await loadStationRecommendations(async () => {
    requestLocation = resolved.location;
    return [station];
  }, () => undefined);

  assert.deepEqual(resolved, { location: fallback, usedFallback: true, error: null });
  assert.deepEqual(requestLocation, fallback);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.stations, [station]);
});

test('GPS failure without a ward fallback remains a location error', async () => {
  const resolved = await resolveStationSearchLocation(
    async () => { throw new Error('GPS unavailable'); },
    null,
  );

  assert.equal(resolved.location, null);
  assert.equal(resolved.usedFallback, false);
  assert.match(resolved.error ?? '', /không có tọa độ trung tâm phường/i);
});

test('station lookup falls back instead of hanging forever on Zalo location', async () => {
  const fallback = { lat: 21.0333, lng: 105.85 };
  const resolved = await resolveStationSearchLocation(
    () => new Promise(() => undefined),
    fallback,
    10,
  );

  assert.deepEqual(resolved, { location: fallback, usedFallback: true, error: null });
});

test('station lookup rejects invalid live and fallback coordinates', async () => {
  const resolved = await resolveStationSearchLocation(
    async () => ({ lat: Number.NaN, lng: 105.85 }),
    { lat: 95, lng: 200 },
    10,
  );

  assert.equal(resolved.location, null);
  assert.equal(resolved.usedFallback, false);
  assert.match(resolved.error ?? '', /không có tọa độ trung tâm phường/i);
});

test('pending station delivery survives reload and page navigation', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new TestStorage() });
  const { pendingStationDeliveryStorage } = await import('../src/lib/storage');
  const collectorId = 'collector-01';
  const shift = {
    completed: {
      'order-01': {
        liters: 6,
        kilograms: 5.46,
        clientUuid: '00000000-0000-4000-8000-000000000001',
        stop: {
          seq: 1,
          order_id: 'order-01',
          merchant: { name: 'Quán A', address: 'Địa chỉ A', lat: 10.77, lng: 106.7 },
          container_code: 'ECO-UCO-Q3P7-001',
          expected_liters: 6,
          priority: 80,
          distance_m: 100,
          ward_center: { lat: 10.77, lng: 106.7 },
        },
      },
    },
    totalStops: 3,
    savedAt: '2026-08-21T08:00:00.000Z',
  };

  pendingStationDeliveryStorage.save(collectorId, shift);
  const afterReload = pendingStationDeliveryStorage.load(collectorId);
  const afterPageNavigation = pendingStationDeliveryStorage.load(collectorId);

  assert.deepEqual(afterReload, shift);
  assert.deepEqual(afterPageNavigation, shift);
  assert.equal(afterReload?.completed['order-01']?.liters, 6);
  assert.equal(afterReload?.completed['order-01']?.kilograms, 5.46);
  assert.equal(afterReload?.completed['order-01']?.stop.container_code, 'ECO-UCO-Q3P7-001');
});

test('successful station delivery clears only the persisted pending shift', async () => {
  const { pendingStationDeliveryStorage } = await import('../src/lib/storage');
  const collectorId = 'collector-success';
  pendingStationDeliveryStorage.save(collectorId, { completed: {}, totalStops: 1, savedAt: new Date().toISOString() });

  pendingStationDeliveryStorage.clear(collectorId);

  assert.equal(pendingStationDeliveryStorage.load(collectorId), null);
});

test('station lookup failure preserves pending IN_TRANSIT delivery data', async () => {
  const { pendingStationDeliveryStorage } = await import('../src/lib/storage');
  const collectorId = 'collector-network-error';
  const shift = {
    completed: {},
    totalStops: 1,
    savedAt: '2026-08-21T09:00:00.000Z',
  };
  pendingStationDeliveryStorage.save(collectorId, shift);

  await loadStationRecommendations(async () => { throw new Error('timeout'); }, () => undefined);

  assert.deepEqual(pendingStationDeliveryStorage.load(collectorId), shift);
});

test('active route snapshot and client uuid survive Mini App reload', async () => {
  const { pendingStationDeliveryStorage } = await import('../src/lib/storage');
  const collectorId = 'collector-active-route';
  const activeRoute = {
    stops: [{ seq: 1, order_id: 'order-01', merchant: { name: 'Quán thử nghiệm', address: null, lat: 10, lng: 106 }, container_code: 'ECO-UCO-Q3P7-001', expected_liters: 20, priority: 1, distance_m: 100, pickup_priority_score: 10, pickup_priority_level: 'LOW', pickup_priority_reason_codes: [] }],
    total_expected_liters: 20,
    remaining_capacity_l: 80,
    route_id: 'route-01',
    route_status: 'ACTIVE',
    persisted: true,
    client_uuid: '11111111-1111-4111-8111-111111111111',
    started_at: '2026-08-26T08:00:00.000Z',
  } as never;
  const shift = { completed: {}, totalStops: 1, savedAt: new Date().toISOString(), activeRoute, routeClientUuid: activeRoute.client_uuid };
  pendingStationDeliveryStorage.save(collectorId, shift);
  assert.deepEqual(pendingStationDeliveryStorage.load(collectorId), shift);
  pendingStationDeliveryStorage.clear(collectorId);
});
