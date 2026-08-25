import { scoreMerchantPickupPriority, type MerchantPickupPriorityInput } from './merchant-pickup-priority';

const baseInput = (overrides: Partial<MerchantPickupPriorityInput> = {}): MerchantPickupPriorityInput => ({
  estimated_liters: 15,
  container_capacity_liters: 30,
  days_since_last_collection: 0,
  distance_km: 10,
  has_active_pickup: false,
  ...overrides,
});

describe('scoreMerchantPickupPriority', () => {
  it('returns insufficient data when fill data is missing', () => {
    expect(scoreMerchantPickupPriority(baseInput({ estimated_liters: null }))).toEqual({
      score: 0,
      priority: 'INSUFFICIENT_DATA',
      reason_codes: ['MISSING_FILL_DATA'],
    });
    expect(scoreMerchantPickupPriority(baseInput({ container_capacity_liters: 0 }))).toEqual({
      score: 0,
      priority: 'INSUFFICIENT_DATA',
      reason_codes: ['MISSING_FILL_DATA'],
    });
  });

  it('scores a near-full, overdue, nearby merchant as urgent', () => {
    const result = scoreMerchantPickupPriority(baseInput({
      estimated_liters: 30,
      container_capacity_liters: 30,
      days_since_last_collection: 14,
      distance_km: 2,
    }));

    expect(result).toEqual({
      score: 95,
      priority: 'URGENT',
      reason_codes: ['NEAR_FULL', 'OVERDUE_COLLECTION', 'NEARBY'],
    });
  });

  it('adds the HIGH_FILL score for 75 to 89 percent fill', () => {
    const result = scoreMerchantPickupPriority(baseInput({
      estimated_liters: 24,
      container_capacity_liters: 30,
      days_since_last_collection: null,
      distance_km: null,
    }));

    expect(result.score).toBe(45);
    expect(result.priority).toBe('NORMAL');
    expect(result.reason_codes).toEqual(['HIGH_FILL', 'MISSING_COLLECTION_HISTORY', 'MISSING_DISTANCE']);
  });

  it('subtracts active pickup score and records the reason', () => {
    const result = scoreMerchantPickupPriority(baseInput({
      estimated_liters: 15,
      days_since_last_collection: 7,
      distance_km: 2,
      has_active_pickup: true,
    }));

    expect(result).toEqual({
      score: 10,
      priority: 'LOW',
      reason_codes: ['MEDIUM_FILL', 'WAITING_LONG', 'NEARBY', 'ALREADY_SCHEDULED'],
    });
  });

  it('handles missing distance and collection history without crashing', () => {
    const result = scoreMerchantPickupPriority(baseInput({
      days_since_last_collection: null,
      distance_km: null,
    }));

    expect(result.reason_codes).toEqual(['MEDIUM_FILL', 'MISSING_COLLECTION_HISTORY', 'MISSING_DISTANCE']);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it.each([
    ['negative liters', { estimated_liters: -1 }],
    ['negative capacity', { container_capacity_liters: -1 }],
    ['NaN days', { days_since_last_collection: Number.NaN }],
    ['infinite distance', { distance_km: Number.POSITIVE_INFINITY }],
  ])('treats %s as missing or invalid safely', (_, overrides) => {
    const result = scoreMerchantPickupPriority(baseInput(overrides));

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Number.isFinite(result.score)).toBe(true);
    if ('estimated_liters' in overrides || 'container_capacity_liters' in overrides) {
      expect(result.priority).toBe('INSUFFICIENT_DATA');
    }
  });

  it('clamps fill percentage when estimated liters exceed capacity', () => {
    const result = scoreMerchantPickupPriority(baseInput({
      estimated_liters: 45,
      container_capacity_liters: 30,
      days_since_last_collection: null,
      distance_km: null,
    }));

    expect(result.score).toBe(60);
    expect(result.reason_codes[0]).toBe('NEAR_FULL');
  });

  it('does not mutate input and keeps stable unique reason order', () => {
    const input = baseInput({ days_since_last_collection: null, distance_km: null });
    const before = { ...input };
    const first = scoreMerchantPickupPriority(input);
    const second = scoreMerchantPickupPriority(input);

    expect(input).toEqual(before);
    expect(first).toEqual(second);
    expect(new Set(first.reason_codes).size).toBe(first.reason_codes.length);
  });

  it.each([
    [30, 'NORMAL'],
    [60, 'HIGH'],
    [80, 'URGENT'],
  ] as const)('classifies the score boundary %s correctly', (expectedScore, expectedPriority) => {
    const inputs: Record<number, MerchantPickupPriorityInput> = {
      30: baseInput({ estimated_liters: 5, days_since_last_collection: 14, distance_km: null }),
      60: baseInput({ estimated_liters: 22.5, days_since_last_collection: 7, distance_km: 10 }),
      80: baseInput({ estimated_liters: 22.5, days_since_last_collection: 14, distance_km: 2 }),
    };
    const result = scoreMerchantPickupPriority(inputs[expectedScore]!);

    expect(result.score).toBe(expectedScore);
    expect(result.priority).toBe(expectedPriority);
  });
});
