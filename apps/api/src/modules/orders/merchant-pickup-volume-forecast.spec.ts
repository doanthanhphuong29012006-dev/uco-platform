import { forecastMerchantPickupVolume, type MerchantPickupVolumeForecastInput } from './merchant-pickup-volume-forecast';

const asOf = '2026-01-10T12:00:00.000Z';

function point(actual_liters: number | null, daysAgo: number, collected_at?: Date | string) {
  return { actual_liters, collected_at: collected_at ?? new Date(Date.parse(asOf) - daysAgo * 86_400_000) };
}

function input(overrides: Partial<MerchantPickupVolumeForecastInput> = {}): MerchantPickupVolumeForecastInput {
  return {
    container_capacity_liters: 30,
    declared_estimated_liters: null,
    history: [],
    as_of: asOf,
    ...overrides,
  };
}

describe('forecastMerchantPickupVolume', () => {
  it('returns HIGH for five stable samples', () => {
    const result = forecastMerchantPickupVolume(input({
      declared_estimated_liters: 10,
      history: [point(10, 1), point(10, 2), point(10, 3), point(10, 4), point(10, 5)],
    }));

    expect(result).toEqual({
      predicted_liters: 10,
      confidence: 'HIGH',
      sample_size: 5,
      reason_codes: ['HISTORY_WEIGHTED', 'DECLARED_ESTIMATE_BLEND', 'STABLE_HISTORY'],
    });
  });

  it('returns MEDIUM for three stable samples', () => {
    const result = forecastMerchantPickupVolume(input({
      history: [point(10, 1), point(10, 2), point(10, 3)],
    }));

    expect(result.confidence).toBe('MEDIUM');
    expect(result.sample_size).toBe(3);
    expect(result.reason_codes).toContain('STABLE_HISTORY');
    expect(result.reason_codes).not.toContain('LIMITED_HISTORY');
  });

  it('returns LOW and LIMITED_HISTORY for one or two samples', () => {
    const result = forecastMerchantPickupVolume(input({ history: [point(10, 1), point(12, 2)] }));

    expect(result.confidence).toBe('LOW');
    expect(result.sample_size).toBe(2);
    expect(result.reason_codes).toContain('LIMITED_HISTORY');
  });

  it('marks volatile history LOW', () => {
    const result = forecastMerchantPickupVolume(input({
      history: [point(30, 1), point(0, 2), point(30, 3), point(0, 4), point(30, 5)],
    }));

    expect(result.confidence).toBe('LOW');
    expect(result.reason_codes).toContain('VOLATILE_HISTORY');
  });

  it('weights newer samples more heavily', () => {
    const result = forecastMerchantPickupVolume(input({ history: [point(10, 2), point(20, 1)] }));

    expect(result.predicted_liters).toBe(15.6);
  });

  it('blends 80/20 with at least three samples and 60/40 with fewer samples', () => {
    const threeSamples = forecastMerchantPickupVolume(input({
      declared_estimated_liters: 20,
      history: [point(10, 1), point(10, 2), point(10, 3)],
    }));
    const twoSamples = forecastMerchantPickupVolume(input({
      declared_estimated_liters: 20,
      history: [point(10, 1), point(10, 2)],
    }));

    expect(threeSamples.predicted_liters).toBe(12);
    expect(twoSamples.predicted_liters).toBe(14);
  });

  it('uses only a declared estimate when history is absent', () => {
    expect(forecastMerchantPickupVolume(input({ declared_estimated_liters: 18 }))).toEqual({
      predicted_liters: 18,
      confidence: 'LOW',
      sample_size: 0,
      reason_codes: ['DECLARED_ESTIMATE_ONLY', 'LIMITED_HISTORY'],
    });
  });

  it('uses only history when declared estimate is absent', () => {
    const result = forecastMerchantPickupVolume(input({ history: [point(12, 1), point(10, 2), point(8, 3)] }));

    expect(result.predicted_liters).toBe(10.3);
    expect(result.reason_codes).toContain('HISTORY_WEIGHTED');
    expect(result.reason_codes).not.toContain('DECLARED_ESTIMATE_BLEND');
  });

  it('returns insufficient data when both history and estimate are absent', () => {
    expect(forecastMerchantPickupVolume(input())).toEqual({
      predicted_liters: null,
      confidence: 'INSUFFICIENT_DATA',
      sample_size: 0,
      reason_codes: ['MISSING_HISTORY_AND_ESTIMATE', 'LIMITED_HISTORY'],
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects invalid capacity %s safely', (capacity) => {
    const result = forecastMerchantPickupVolume(input({ container_capacity_liters: capacity }));

    expect(result).toEqual({
      predicted_liters: null,
      confidence: 'INSUFFICIENT_DATA',
      sample_size: 0,
      reason_codes: ['INVALID_CAPACITY'],
    });
  });

  it('ignores invalid declared values and caps a declared value above capacity', () => {
    const invalid = forecastMerchantPickupVolume(input({ declared_estimated_liters: Number.NaN }));
    const capped = forecastMerchantPickupVolume(input({ declared_estimated_liters: 40 }));

    expect(invalid.reason_codes).toEqual(['INVALID_DECLARED_ESTIMATE', 'MISSING_HISTORY_AND_ESTIMATE', 'LIMITED_HISTORY']);
    expect(capped).toEqual({
      predicted_liters: 30,
      confidence: 'LOW',
      sample_size: 0,
      reason_codes: ['DECLARED_ESTIMATE_ONLY', 'LIMITED_HISTORY', 'PREDICTION_CAPPED_TO_CAPACITY'],
    });
  });

  it('ignores negative, over-capacity, invalid and future history', () => {
    const result = forecastMerchantPickupVolume(input({
      history: [
        point(10, 1),
        point(-1, 2),
        point(31, 3),
        point(10, 4, 'not-a-date'),
        point(10, 0),
      ],
    }));

    expect(result.sample_size).toBe(2);
    expect(result.reason_codes).toContain('IGNORED_INVALID_HISTORY');
  });

  it('uses only the five most recent valid samples', () => {
    const result = forecastMerchantPickupVolume(input({
      history: [
        point(99, 10),
        point(5, 5),
        point(5, 4),
        point(5, 3),
        point(5, 2),
        point(5, 1),
      ],
    }));

    expect(result.sample_size).toBe(5);
    expect(result.predicted_liters).toBe(5);
  });

  it('handles all-zero history with stable CV and a zero prediction', () => {
    const result = forecastMerchantPickupVolume(input({
      history: [point(0, 1), point(0, 2), point(0, 3), point(0, 4), point(0, 5)],
    }));

    expect(result.predicted_liters).toBe(0);
    expect(result.confidence).toBe('HIGH');
    expect(result.reason_codes).toContain('STABLE_HISTORY');
  });

  it('clamps and rounds predictions to one decimal place', () => {
    const result = forecastMerchantPickupVolume(input({
      declared_estimated_liters: 30,
      history: [point(29.96, 1), point(29.96, 2), point(29.96, 3)],
    }));

    expect(result.predicted_liters).toBe(30);
    expect(result.predicted_liters).toBeLessThanOrEqual(30);
  });

  it('uses declared data with invalid as_of but does not use history', () => {
    const result = forecastMerchantPickupVolume(input({
      as_of: 'invalid-date',
      declared_estimated_liters: 12,
      history: [point(30, 1)],
    }));

    expect(result.predicted_liters).toBe(12);
    expect(result.confidence).toBe('LOW');
    expect(result.sample_size).toBe(0);
    expect(result.reason_codes).toContain('INVALID_AS_OF');
    expect(result.reason_codes).toContain('DECLARED_ESTIMATE_ONLY');
  });

  it('does not mutate input and is deterministic with unique stable reasons', () => {
    const originalHistory = [point(10, 1), point(8, 2), point(9, 3)];
    const original = input({ declared_estimated_liters: 12, history: originalHistory });
    const snapshot = originalHistory.map((item) => ({ ...item }));
    const first = forecastMerchantPickupVolume(original);
    const second = forecastMerchantPickupVolume(original);

    expect(original.history).toEqual(snapshot);
    expect(first).toEqual(second);
    expect(new Set(first.reason_codes).size).toBe(first.reason_codes.length);
    expect(first.predicted_liters).toBeGreaterThanOrEqual(0);
    expect(first.predicted_liters).toBeLessThanOrEqual(30);
  });
});
