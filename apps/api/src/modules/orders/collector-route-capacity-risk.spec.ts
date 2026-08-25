import { assessCollectorRouteCapacityRisk, type CapacityRiskStop } from './collector-route-capacity-risk';

const stop = (overrides: Partial<CapacityRiskStop> = {}): CapacityRiskStop => ({
  declared_liters: 50,
  predicted_liters: 50,
  forecast_confidence: 'HIGH',
  container_capacity_liters: null,
  ...overrides,
});

describe('assessCollectorRouteCapacityRisk', () => {
  it('keeps a high-confidence route under 60 percent as underutilized', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 50, declared_liters: 50 })],
    });

    expect(result).toMatchObject({
      predicted_total_liters: 50,
      risk_adjusted_total_liters: 52.5,
      risk_utilization_pct: 53,
      level: 'UNDERUTILIZED',
      confidence: 'HIGH',
      forecast_coverage_pct: 100,
    });
    expect(result.reason_codes).toEqual(['FORECAST_HIGH_CONFIDENCE', 'RISK_BUFFER_APPLIED', 'PREDICTED_UNDERUTILIZED']);
  });

  it('classifies balanced routes from 60 percent utilization', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 57.14, declared_liters: 57.14 })],
    });

    expect(result.risk_utilization_pct).toBe(60);
    expect(result.level).toBe('BALANCED');
  });

  it('classifies 85 percent as near capacity and exactly 100 percent as near capacity', () => {
    const near = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 80.95, declared_liters: 80.95 })],
    });
    const full = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 95.24, declared_liters: 95.24 })],
    });

    expect(near.level).toBe('NEAR_CAPACITY');
    expect(near.risk_utilization_pct).toBe(85);
    expect(full.level).toBe('NEAR_CAPACITY');
    expect(full.risk_utilization_pct).toBe(100);
  });

  it('classifies over capacity and preserves negative remaining liters', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 100, declared_liters: 100 })],
    });

    expect(result.level).toBe('OVER_CAPACITY');
    expect(result.risk_utilization_pct).toBe(105);
    expect(result.risk_adjusted_remaining_liters).toBe(-5);
    expect(result.reason_codes).toContain('PREDICTED_OVER_CAPACITY');
  });

  it.each([
    ['HIGH', 1.05],
    ['MEDIUM', 1.1],
    ['LOW', 1.2],
    ['INSUFFICIENT_DATA', 1.25],
  ] as const)('applies the %s risk buffer', (confidence, multiplier) => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 10, declared_liters: 10, forecast_confidence: confidence })],
    });

    expect(result.risk_adjusted_total_liters).toBe(10 * multiplier);
    expect(result.reason_codes).toContain('RISK_BUFFER_APPLIED');
  });

  it('uses declared fallback with the insufficient-data buffer', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: null, declared_liters: 20, forecast_confidence: null })],
    });

    expect(result).toMatchObject({
      predicted_total_liters: 20,
      risk_adjusted_total_liters: 25,
      confidence: 'LOW',
      forecast_coverage_pct: 0,
    });
    expect(result.reason_codes).toContain('DECLARED_VOLUME_FALLBACK');
  });

  it('clamps prediction and risk volume at a valid container capacity', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 40, declared_liters: 40, container_capacity_liters: 30 })],
    });

    expect(result.predicted_total_liters).toBe(30);
    expect(result.risk_adjusted_total_liters).toBe(30);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid vehicle capacity %s', (capacity) => {
    expect(assessCollectorRouteCapacityRisk({ vehicle_capacity_liters: capacity, stops: [stop()] })).toEqual({
      predicted_total_liters: null,
      risk_adjusted_total_liters: null,
      risk_adjusted_remaining_liters: null,
      risk_utilization_pct: null,
      level: 'INSUFFICIENT_DATA',
      confidence: 'INSUFFICIENT_DATA',
      forecast_coverage_pct: 0,
      reason_codes: ['INVALID_VEHICLE_CAPACITY'],
    });
  });

  it('handles an empty route without applying a buffer', () => {
    expect(assessCollectorRouteCapacityRisk({ vehicle_capacity_liters: 100, stops: [] })).toEqual({
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

  it('reports missing and invalid stop volumes while retaining usable stops', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [
        stop({ predicted_liters: null, declared_liters: null }),
        stop({ predicted_liters: Number.NaN, declared_liters: Number.POSITIVE_INFINITY }),
        stop({ predicted_liters: 0, declared_liters: 0 }),
      ],
    });

    expect(result.predicted_total_liters).toBe(0);
    expect(result.risk_adjusted_total_liters).toBe(0);
    expect(result.forecast_coverage_pct).toBe(33);
    expect(result.confidence).toBe('LOW');
    expect(result.reason_codes).toEqual([
      'LOW_CONFIDENCE_FORECAST',
      'MISSING_STOP_VOLUME',
      'INVALID_STOP_VOLUME',
      'RISK_BUFFER_APPLIED',
      'PREDICTED_UNDERUTILIZED',
    ]);
  });

  it('reports invalid container capacity without crashing or clamping', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 20, container_capacity_liters: 0 })],
    });

    expect(result.predicted_total_liters).toBe(20);
    expect(result.reason_codes).toContain('INVALID_CONTAINER_CAPACITY');
  });

  it('calculates route confidence for medium, low and insufficient data', () => {
    const medium = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 20, forecast_confidence: 'MEDIUM' }), stop({ predicted_liters: 20, forecast_confidence: 'MEDIUM' })],
    });
    const low = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: 20, forecast_confidence: 'LOW' })],
    });
    const insufficient = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: null, declared_liters: null })],
    });

    expect(medium.confidence).toBe('MEDIUM');
    expect(medium.reason_codes).toContain('FORECAST_MIXED_CONFIDENCE');
    expect(low.confidence).toBe('LOW');
    expect(low.reason_codes).toContain('LOW_CONFIDENCE_FORECAST');
    expect(insufficient.confidence).toBe('INSUFFICIENT_DATA');
  });

  it('reports mixed confidence and coverage accurately', () => {
    const result = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: 100,
      stops: [
        stop({ predicted_liters: 20, forecast_confidence: 'HIGH' }),
        stop({ predicted_liters: 20, forecast_confidence: 'MEDIUM' }),
        stop({ predicted_liters: null, declared_liters: 20, forecast_confidence: null }),
      ],
    });

    expect(result.forecast_coverage_pct).toBe(67);
    expect(result.confidence).toBe('LOW');
    expect(result.reason_codes).toContain('FORECAST_MIXED_CONFIDENCE');
    expect(result.reason_codes).toContain('DECLARED_VOLUME_FALLBACK');
  });

  it('keeps zero valid, rounds metrics, and does not mutate input', () => {
    const stops = [stop({ predicted_liters: 12.24, declared_liters: 12.24, forecast_confidence: 'HIGH' })];
    const snapshot = stops.map((item) => ({ ...item }));
    const first = assessCollectorRouteCapacityRisk({ vehicle_capacity_liters: 20, stops });
    const second = assessCollectorRouteCapacityRisk({ vehicle_capacity_liters: 20, stops });
    const zero = assessCollectorRouteCapacityRisk({ vehicle_capacity_liters: 20, stops: [stop({ predicted_liters: 0, declared_liters: 0 })] });

    expect(first.predicted_total_liters).toBe(12.2);
    expect(first.risk_adjusted_total_liters).toBe(12.9);
    expect(first.risk_utilization_pct).toBe(64);
    expect(first).toEqual(second);
    expect(stops).toEqual(snapshot);
    expect(zero.predicted_total_liters).toBe(0);
  });

  it('keeps reason codes unique and deterministic', () => {
    const input = {
      vehicle_capacity_liters: 100,
      stops: [stop({ predicted_liters: null, declared_liters: 20, forecast_confidence: null, container_capacity_liters: 0 })],
    };
    const first = assessCollectorRouteCapacityRisk(input);
    const second = assessCollectorRouteCapacityRisk(input);

    expect(first).toEqual(second);
    expect(new Set(first.reason_codes).size).toBe(first.reason_codes.length);
  });
});
