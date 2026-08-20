import { scoreTransactionAnomaly, type TransactionAnomalyInput } from './transaction-anomaly-scorer';

const merchantId = 'merchant-01';
const targetDate = new Date('2026-08-20T02:00:00.000Z');

function history(values: Array<{ kilograms: number; liters: number }>): TransactionAnomalyInput[] {
  return values.map((value, index) => ({
    merchantId,
    actualKg: value.kilograms,
    actualLiters: value.liters,
    collectedAt: new Date(targetDate.getTime() - (index + 2) * 24 * 60 * 60 * 1_000),
  }));
}

const normalHistory = history([
  { kilograms: 18.2, liters: 20 },
  { kilograms: 18.7, liters: 20.5 },
  { kilograms: 17.8, liters: 19.6 },
  { kilograms: 19.1, liters: 21 },
  { kilograms: 18.5, liters: 20.3 },
  { kilograms: 18, liters: 19.8 },
  { kilograms: 18.9, liters: 20.8 },
]);

describe('scoreTransactionAnomaly', () => {
  it('classifies a transaction consistent with history as normal', () => {
    const result = scoreTransactionAnomaly(normalHistory, {
      merchantId,
      actualKg: 18.4,
      actualLiters: 20.2,
      collectedAt: targetDate,
    });

    expect(result.level).toBe('NORMAL');
    expect(result.reasons).toEqual([]);
    expect(result.explanation.densityKgPerLiter.median).toBeCloseTo(0.91, 1);
  });

  it('reports an abnormal kilogram-per-liter density', () => {
    const result = scoreTransactionAnomaly(normalHistory, {
      merchantId,
      actualKg: 18.4,
      actualLiters: 10,
      collectedAt: targetDate,
    });

    expect(result.reasons).toContain('DENSITY_OUTLIER');
    expect(result.explanation.densityKgPerLiter.value).toBeCloseTo(1.84);
    expect(result.explanation.densityKgPerLiter.robustZScore).toBeGreaterThan(3.5);
  });

  it('reports a sudden mass increase against merchant history', () => {
    const result = scoreTransactionAnomaly(normalHistory, {
      merchantId,
      actualKg: 60,
      actualLiters: 65.9,
      collectedAt: targetDate,
    });

    expect(result.reasons).toContain('MASS_OR_VOLUME_OUTLIER');
    expect(result.explanation.massOrVolume.metric).toBe('KG');
    expect(result.explanation.massOrVolume.value).toBe(60);
  });

  it('does not infer high risk from insufficient history', () => {
    const result = scoreTransactionAnomaly(normalHistory.slice(0, 2), {
      merchantId,
      actualKg: 100,
      actualLiters: 10,
      collectedAt: targetDate,
    });

    expect(result.score).toBe(0);
    expect(result.level).toBe('NORMAL');
    expect(result.explanation.densityKgPerLiter.fallback).toBe('INSUFFICIENT_HISTORY');
  });

  it('uses a bounded fallback when MAD is zero', () => {
    const identicalHistory = history(
      Array.from({ length: 8 }, () => ({
        kilograms: 18.2,
        liters: 20,
      })),
    );
    const result = scoreTransactionAnomaly(identicalHistory, {
      merchantId,
      actualKg: 80,
      actualLiters: 40,
      collectedAt: targetDate,
    });

    expect(result.explanation.massOrVolume.mad).toBe(0);
    expect(result.explanation.massOrVolume.fallback).toBe('ZERO_MAD_RELATIVE_DEVIATION');
    expect(result.level).not.toBe('HIGH_RISK');
    expect(result.score).toBeLessThanOrEqual(49);
  });

  it('always clamps the score to the inclusive 0-100 range', () => {
    const candidates: TransactionAnomalyInput[] = [
      { merchantId, actualKg: 18.4, actualLiters: 20.2, collectedAt: targetDate },
      { merchantId, actualKg: 500, actualLiters: 1, collectedAt: '2026-08-20T19:00:00.000Z' },
      { merchantId, actualKg: null, actualLiters: null, collectedAt: 'invalid-date' },
    ];

    for (const candidate of candidates) {
      const result = scoreTransactionAnomaly(normalHistory, candidate);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});
