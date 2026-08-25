import { optimizeCollectionRoute, type RouteOptimizerInput, type RouteOptimizerStop } from './collection-route-optimizer';

function stop(id: string, overrides: Partial<RouteOptimizerStop> = {}): RouteOptimizerStop {
  return {
    id,
    lat: 10.78,
    lng: 106.7,
    pickup_priority_score: 40,
    legacy_priority: 10,
    original_index: 0,
    ...overrides,
  };
}

function input(stops: RouteOptimizerStop[], origin = { lat: 10.7769, lng: 106.7009 }): RouteOptimizerInput {
  return { origin, stops };
}

describe('optimizeCollectionRoute', () => {
  it('keeps all priority groups in strict order', () => {
    const result = optimizeCollectionRoute(input([
      stop('low', { pickup_priority_score: 10, original_index: 0 }),
      stop('normal', { pickup_priority_score: 30, original_index: 1 }),
      stop('urgent', { pickup_priority_score: 80, original_index: 2 }),
      stop('high', { pickup_priority_score: 60, original_index: 3 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('uses nearest neighbor only inside each priority group', () => {
    const result = optimizeCollectionRoute(input([
      stop('urgent-near-origin', { pickup_priority_score: 80, lat: 10.777, lng: 106.701, original_index: 0 }),
      stop('urgent-near-first', { pickup_priority_score: 80, lat: 10.778, lng: 106.702, original_index: 1 }),
      stop('urgent-far', { pickup_priority_score: 80, lat: 10.8, lng: 106.72, original_index: 2 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['urgent-near-origin', 'urgent-near-first', 'urgent-far']);
  });

  it('never lets a lower priority nearby stop pass a higher priority farther stop', () => {
    const result = optimizeCollectionRoute(input([
      stop('low-near', { pickup_priority_score: 20, lat: 10.777, lng: 106.701, original_index: 0 }),
      stop('urgent-far', { pickup_priority_score: 90, lat: 10.8, lng: 106.72, original_index: 1 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['urgent-far', 'low-near']);
  });

  it('applies score, legacy priority, original index, then id tie-breakers', () => {
    const result = optimizeCollectionRoute(input([
      stop('id-z', { pickup_priority_score: 60, legacy_priority: 1, original_index: 3, lat: 10.78, lng: 106.71 }),
      stop('legacy-high', { pickup_priority_score: 60, legacy_priority: 2, original_index: 2, lat: 10.78, lng: 106.71 }),
      stop('index-first', { pickup_priority_score: 60, legacy_priority: 2, original_index: 0, lat: 10.78, lng: 106.71 }),
      stop('id-a', { pickup_priority_score: 60, legacy_priority: 1, original_index: 3, lat: 10.78, lng: 106.71 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['index-first', 'legacy-high', 'id-a', 'id-z']);
  });

  it('does not mutate input and produces the same result repeatedly', () => {
    const stops = [
      stop('second', { original_index: 1, lat: 10.79 }),
      stop('first', { original_index: 0, lat: 10.777 }),
    ];
    const original = structuredClone(stops);
    const first = optimizeCollectionRoute(input(stops));
    const second = optimizeCollectionRoute(input(stops));

    expect(stops).toEqual(original);
    expect(first).toEqual(second);
  });

  it.each([
    ['zero stops', []],
    ['one stop', [stop('only')]],
  ])('handles %s without optimizing', (_label, stops) => {
    const result = optimizeCollectionRoute(input(stops));

    expect(result.optimization_applied).toBe(false);
    expect(result.reason_codes).toContain('INSUFFICIENT_STOPS');
    if (stops.length === 0) {
      expect(result.estimated_distance_before_m).toBe(0);
      expect(result.estimated_distance_after_m).toBe(0);
    } else {
      expect(result.estimated_distance_before_m).toBeGreaterThan(0);
      expect(result.estimated_distance_after_m).toBe(result.estimated_distance_before_m);
    }
  });

  it('returns input order and null metrics for invalid origin', () => {
    const result = optimizeCollectionRoute(input([
      stop('first', { original_index: 0 }),
      stop('second', { original_index: 1 }),
    ], { lat: Number.NaN, lng: 106.7 }));

    expect(result.stops.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(result.optimization_applied).toBe(false);
    expect(result.estimated_distance_before_m).toBeNull();
    expect(result.estimated_distance_after_m).toBeNull();
    expect(result.saved_distance_m).toBeNull();
    expect(result.reason_codes).toEqual(['INVALID_ORIGIN']);
  });

  it('puts invalid coordinates at the end of their group and leaves metrics null', () => {
    const result = optimizeCollectionRoute(input([
      stop('invalid', { lat: Number.POSITIVE_INFINITY, original_index: 0 }),
      stop('valid', { lat: 10.777, lng: 106.701, original_index: 1 }),
      stop('out-of-range', { lat: 91, original_index: 2 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['valid', 'invalid', 'out-of-range']);
    expect(result.estimated_distance_before_m).toBeNull();
    expect(result.estimated_distance_after_m).toBeNull();
    expect(result.saved_distance_m).toBeNull();
    expect(result.reason_codes).toContain('INVALID_STOP_COORDINATES');
  });

  it('places negative, NaN and Infinity scores after valid score groups stably', () => {
    const result = optimizeCollectionRoute(input([
      stop('negative', { pickup_priority_score: -1, original_index: 0 }),
      stop('urgent', { pickup_priority_score: 80, original_index: 1 }),
      stop('nan', { pickup_priority_score: Number.NaN, original_index: 2 }),
      stop('low', { pickup_priority_score: 1, original_index: 3 }),
      stop('infinity', { pickup_priority_score: Number.POSITIVE_INFINITY, original_index: 4 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['urgent', 'low', 'negative', 'nan', 'infinity']);
  });

  it('handles coincident points deterministically and calculates metrics', () => {
    const result = optimizeCollectionRoute(input([
      stop('second', { pickup_priority_score: 40, original_index: 1, lat: 10.78, lng: 106.71 }),
      stop('first', { pickup_priority_score: 40, original_index: 0, lat: 10.78, lng: 106.71 }),
    ]));

    expect(result.stops.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(result.estimated_distance_before_m).not.toBeNull();
    expect(result.estimated_distance_after_m).not.toBeNull();
    expect(result.saved_distance_m).toBeGreaterThanOrEqual(0);
  });

  it('reports route metrics in whole meters and never negative savings', () => {
    const result = optimizeCollectionRoute(input([
      stop('far', { pickup_priority_score: 80, lat: 10.8, lng: 106.72, original_index: 0 }),
      stop('near', { pickup_priority_score: 80, lat: 10.777, lng: 106.701, original_index: 1 }),
    ]));

    const before = result.estimated_distance_before_m;
    const after = result.estimated_distance_after_m;
    const saved = result.saved_distance_m;
    expect(Number.isInteger(before)).toBe(true);
    expect(Number.isInteger(after)).toBe(true);
    expect(Number.isInteger(saved)).toBe(true);
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(after).not.toBeNull();
    expect(before).not.toBeNull();
    if (after !== null && before !== null) {
      expect(after).toBeLessThanOrEqual(before);
    }
  });

  it('returns ALREADY_OPTIMAL when the order is unchanged and keeps reasons unique', () => {
    const result = optimizeCollectionRoute(input([
      stop('first', { pickup_priority_score: 80, original_index: 0, lat: 10.777, lng: 106.701 }),
      stop('second', { pickup_priority_score: 80, original_index: 1, lat: 10.78, lng: 106.71 }),
    ]));

    expect(result.optimization_applied).toBe(false);
    expect(result.reason_codes).toEqual(['ALREADY_OPTIMAL']);
    expect(new Set(result.reason_codes).size).toBe(result.reason_codes.length);
  });
});
