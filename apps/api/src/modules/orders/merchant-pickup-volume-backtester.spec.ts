import { evaluatePickupVolumeBacktest, type PickupForecastBacktestObservation } from './merchant-pickup-volume-backtester';

const start = Date.parse('2026-01-01T00:00:00.000Z');

function observation(
  merchant_id: string,
  day: number,
  actual_liters: number,
  overrides: Partial<PickupForecastBacktestObservation> = {},
): PickupForecastBacktestObservation {
  return {
    merchant_id,
    merchant_name: merchant_id === 'merchant-a' ? 'Quán A' : 'Quán B',
    collected_at: new Date(start + day * 86_400_000),
    actual_liters,
    declared_estimated_liters: null,
    container_capacity_liters: 30,
    ...overrides,
  };
}

describe('evaluatePickupVolumeBacktest', () => {
  it('does not use future transactions for a rolling-origin forecast', () => {
    const result = evaluatePickupVolumeBacktest([
      observation('merchant-a', 1, 10),
      observation('merchant-a', 2, 20),
      observation('merchant-a', 3, 30),
    ]);

    expect(result.sample_count).toBe(2);
    expect(result.points[0]?.actual_liters).toBe(30);
    expect(result.points[0]?.predicted_liters).toBe(15.6);
    expect(result.points[0]?.history_sample_size).toBe(2);
  });

  it('calculates MAE, WAPE, bias and tolerance counts without MAPE for zero actuals', () => {
    const result = evaluatePickupVolumeBacktest([
      observation('merchant-a', 1, 10),
      observation('merchant-a', 2, 10),
      observation('merchant-a', 3, 10),
      observation('merchant-a', 4, 20),
      observation('merchant-a', 5, 0),
      observation('merchant-a', 6, 10),
    ]);

    expect(result.sample_count).toBe(5);
    expect(result.mae_liters).toBe(4.86);
    expect(result.wape_pct).toBe(48.6);
    expect(result.bias_liters).toBe(0.58);
    expect(result.accuracy_pct).toBe(51.4);
    expect(result.within_10_pct_count).toBeGreaterThanOrEqual(0);
    expect(result.points.find((point) => point.actual_liters === 0)?.error_percentage_pct).toBeNull();
  });

  it('returns empty metrics and insufficient reliability when history is missing', () => {
    const result = evaluatePickupVolumeBacktest([observation('merchant-a', 1, 10)]);

    expect(result).toMatchObject({
      sample_count: 0,
      mae_liters: null,
      wape_pct: null,
      bias_liters: null,
      accuracy_pct: null,
      reliability: 'INSUFFICIENT',
    });
  });

  it.each([
    [5, 'LOW'],
    [10, 'MEDIUM'],
    [20, 'HIGH'],
  ] as const)('assigns reliability at %s valid samples', (sampleCount, reliability) => {
    const observations = Array.from({ length: sampleCount + 1 }, (_, index) => observation('merchant-a', index + 1, 10));
    expect(evaluatePickupVolumeBacktest(observations).reliability).toBe(reliability);
  });

  it('sorts points newest first and limits details to 30 points', () => {
    const observations = Array.from({ length: 37 }, (_, index) => observation('merchant-a', index + 1, 10));
    const result = evaluatePickupVolumeBacktest(observations);

    expect(result.points).toHaveLength(30);
    expect(result.points[0]?.collected_at).toBe(new Date(start + 37 * 86_400_000).toISOString());
    expect(result.points[29]?.collected_at).toBe(new Date(start + 8 * 86_400_000).toISOString());
  });

  it('keeps merchants isolated and does not mutate or become nondeterministic', () => {
    const input = [observation('merchant-a', 1, 10), observation('merchant-b', 1, 100), observation('merchant-a', 2, 10), observation('merchant-b', 2, 100)];
    const snapshot = input.map((item) => ({ ...item }));
    const first = evaluatePickupVolumeBacktest(input);
    const second = evaluatePickupVolumeBacktest(input);

    expect(input).toEqual(snapshot);
    expect(first).toEqual(second);
    expect(first.points.every((point) => point.merchant_id === 'merchant-a' || point.merchant_id === 'merchant-b')).toBe(true);
  });
});
