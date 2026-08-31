import type { ConfigService } from '@nestjs/config';
import { AlertType, AnomalyFeedbackVerdict } from '@eco-oil/shared-types';
import { adminAlertListQuerySchema } from '@eco-oil/validation';
import { AdminService } from './admin.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StationFillAlertCandidate } from '../stations/station-fill-alert';
import type { StationsService } from '../stations/stations.service';

const merchantId = '20000000-0000-4000-8000-000000000001';
const otherMerchantId = '20000000-0000-4000-8000-000000000002';
const candidateTime = new Date('2026-08-20T09:00:00.000Z');

function transaction(
  id = 'candidate-1',
  merchant = merchantId,
  collectedAt = candidateTime.toISOString(),
) {
  return {
    id,
    merchant_id: merchant,
    merchant_name: 'Quán thử nghiệm',
    liters: 20,
    kilograms: 18.2,
    mass_source: 'SCALE',
    grade: 'A',
    suspected_adulteration: false,
    collected_at: collectedAt,
  };
}

function reconciliationRow(transactions: ReturnType<typeof transaction>[]) {
  return {
    collected_liters: 20,
    delivered_liters: 0,
    collected_kg: 18.2,
    delivered_kg: 0,
    has_estimated_mass: false,
    by_collector: [
      {
        collector_id: 'collector-1',
        name: 'Người thu gom',
        collected_l: 20,
        delivered_l: 0,
        variance_l: 20,
        collected_kg: 18.2,
        delivered_kg: 0,
        variance_kg: 18.2,
        has_estimated_mass: false,
        transactions,
        status: 'FLAGGED',
      },
    ],
    undelivered_transactions: transactions,
  };
}

function historicalRow(id: string, daysBefore: number, merchant = merchantId) {
  return {
    id,
    merchantId: merchant,
    actualKg: 18 + daysBefore / 10,
    actualLiters: 20 + daysBefore / 10,
    massSource: 'SCALE',
    densityFactor: null,
    collectedAt: new Date(candidateTime.getTime() - daysBefore * 24 * 60 * 60 * 1_000),
  };
}

function createService(
  currentTransactions: ReturnType<typeof transaction>[],
  history: ReturnType<typeof historicalRow>[],
) {
  const queryRaw = jest.fn().mockResolvedValue([reconciliationRow(currentTransactions)]);
  const findMany = jest.fn().mockResolvedValue(history);
  const prisma = {
    $queryRaw: queryRaw,
    collectionTransaction: { findMany },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  } as unknown as ConfigService;
  const stations = {
    listFillAlertCandidates: jest.fn().mockResolvedValue([]),
  } as unknown as StationsService;
  return { service: new AdminService(prisma, config, stations), queryRaw, findMany };
}

function fillCandidate(
  stationId: string,
  forecastStatus: 'FULL' | 'CRITICAL' | 'WATCH',
): StationFillAlertCandidate {
  return {
    station_id: stationId,
    station_name: `Trạm ${stationId}`,
    severity: forecastStatus === 'WATCH' ? 'MEDIUM' : 'HIGH',
    forecast_status: forecastStatus,
    estimated_days_until_full:
      forecastStatus === 'FULL' ? 0 : forecastStatus === 'CRITICAL' ? 2 : 5,
    reason_codes:
      forecastStatus === 'FULL'
        ? ['STATION_ALREADY_FULL']
        : forecastStatus === 'CRITICAL'
          ? ['FULL_WITHIN_3_DAYS']
          : ['FULL_WITHIN_7_DAYS'],
    message: `Cảnh báo ${forecastStatus}`,
    trigger: 'CAPACITY',
    storage_age_days: null,
    max_storage_days: 14,
  };
}

function createAlertService(
  persistedAlerts: Array<Record<string, unknown>>,
  candidates: StationFillAlertCandidate[],
) {
  const queryRaw = jest.fn().mockResolvedValue(persistedAlerts);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const config = { get: jest.fn() } as unknown as ConfigService;
  const listFillAlertCandidates = jest.fn().mockResolvedValue(candidates);
  const stations = { listFillAlertCandidates } as unknown as StationsService;
  return { service: new AdminService(prisma, config, stations), queryRaw, listFillAlertCandidates };
}

describe('AdminService reconciliation anomaly integration', () => {
  it('adds anomaly data while preserving existing transaction response fields', async () => {
    const candidate = transaction();
    const { service } = createService(
      [candidate],
      Array.from({ length: 6 }, (_, index) => historicalRow(`history-${index}`, index + 1)),
    );

    const result = await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });
    const returned = (
      result.by_collector as Array<{ transactions: Array<Record<string, unknown>> }>
    )[0].transactions[0];

    expect(returned).toMatchObject({
      id: candidate.id,
      merchant_name: candidate.merchant_name,
      liters: candidate.liters,
      kilograms: candidate.kilograms,
      mass_source: candidate.mass_source,
      grade: candidate.grade,
      suspected_adulteration: candidate.suspected_adulteration,
      collected_at: candidate.collected_at,
    });
    expect(returned).not.toHaveProperty('merchant_id');
    expect(returned).toHaveProperty('anomaly.score');
    expect(returned).toHaveProperty('anomaly.level');
    expect(returned).toHaveProperty('anomaly.reasons');
    expect(returned).toHaveProperty('anomaly.explanation');
    expect(returned).toHaveProperty('anomaly.historySize', 6);
  });

  it('excludes the transaction itself, future rows and other merchants from history', async () => {
    const candidate = transaction();
    const validHistory = Array.from({ length: 5 }, (_, index) =>
      historicalRow(`history-${index}`, index + 1),
    );
    const { service } = createService(
      [candidate],
      [
        ...validHistory,
        { ...historicalRow(candidate.id, 1), collectedAt: candidateTime },
        { ...historicalRow('future', 1), collectedAt: new Date(candidateTime.getTime() + 60_000) },
        historicalRow('other-merchant', 1, otherMerchantId),
      ],
    );

    const result = await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });
    const anomaly = (
      result.undelivered_transactions as Array<{
        anomaly: { historySize: number; explanation: { historyCount: number } };
      }>
    )[0].anomaly;

    expect(anomaly.historySize).toBe(5);
    expect(anomaly.explanation.historyCount).toBe(5);
  });

  it('returns a safe normal result when merchant history is below the minimum', async () => {
    const { service } = createService(
      [transaction()],
      [historicalRow('history-1', 1), historicalRow('history-2', 2)],
    );

    const result = await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });
    const anomaly = (
      result.undelivered_transactions as Array<{
        anomaly: { score: number; level: string; historySize: number };
      }>
    )[0].anomaly;

    expect(anomaly).toMatchObject({ score: 0, level: 'NORMAL', historySize: 2 });
  });

  it('loads all merchant history in one batch instead of querying per transaction', async () => {
    const { service, queryRaw, findMany } = createService(
      [
        transaction('candidate-1'),
        transaction('candidate-2', otherMerchantId, '2026-08-20T10:00:00.000Z'),
      ],
      [],
    );

    await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ merchantId: { in: [merchantId, otherMerchantId] } }),
      }),
    );
  });
});

describe('AdminService station fill forecast alerts integration', () => {
  const persistedMedium = {
    id: 'persisted-medium',
    type: 'DELIVERY_VARIANCE',
    severity: 'MEDIUM',
    message: 'Cảnh báo cũ mức trung bình',
    details: { delivery_id: 'delivery-1' },
    created_at: new Date('2026-08-20T10:00:00.000Z'),
    resolved_at: null,
  };

  it('keeps persisted alert fields, removes duplicate station alerts and orders HIGH before MEDIUM', async () => {
    const candidates = [
      fillCandidate('watch-station', 'WATCH'),
      fillCandidate('critical-station', 'CRITICAL'),
      fillCandidate('critical-station', 'CRITICAL'),
      fillCandidate('full-station', 'FULL'),
    ];
    const { service, listFillAlertCandidates } = createAlertService([persistedMedium], candidates);

    const result = await service.listAlerts({ page: 1, limit: 20, include_inactive: false });

    expect(listFillAlertCandidates).toHaveBeenCalledTimes(1);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 4 });
    expect(result.data.map((alert) => alert.severity)).toEqual([
      'HIGH',
      'HIGH',
      'MEDIUM',
      'MEDIUM',
    ]);
    expect(
      result.data.filter((alert) => alert.id === 'station-fill:critical-station'),
    ).toHaveLength(1);
    expect(result.data).toContainEqual(
      expect.objectContaining({
        id: persistedMedium.id,
        type: persistedMedium.type,
        message: persistedMedium.message,
        details: persistedMedium.details,
        created_at: persistedMedium.created_at,
        resolved_at: persistedMedium.resolved_at,
      }),
    );
    expect(result.data).toContainEqual(
      expect.objectContaining({
        id: 'station-fill:full-station',
        type: 'STATION_FILL_FORECAST',
        severity: 'HIGH',
        details: expect.objectContaining({
          station_id: 'full-station',
          station_name: 'Trạm full-station',
          forecast_status: 'FULL',
          estimated_days_until_full: 0,
          reason_codes: ['STATION_ALREADY_FULL'],
        }),
      }),
    );
  });

  it('does not add dynamic forecast alerts to resolved or persisted-type queries', async () => {
    const { service, listFillAlertCandidates } = createAlertService(
      [persistedMedium],
      [fillCandidate('full-station', 'FULL')],
    );

    const resolvedResult = await service.listAlerts({
      page: 1,
      limit: 20,
      include_inactive: false,
      resolved: true,
    });
    const typedResult = await service.listAlerts({
      page: 1,
      limit: 20,
      include_inactive: false,
      type: AlertType.DELIVERY_VARIANCE,
    });

    expect(listFillAlertCandidates).not.toHaveBeenCalled();
    expect(resolvedResult.data).toHaveLength(1);
    expect(typedResult.data).toHaveLength(1);
  });
});

describe('AdminService anomaly feedback loop', () => {
  const targetId = '00000000-0000-4000-8000-000000000001';
  const targetDate = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const history = Array.from({ length: 6 }, (_, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index + 1}`,
    merchantId,
    actualKg: 18.2,
    actualLiters: 20,
    collectedAt: new Date(targetDate.getTime() - (index + 1) * 24 * 60 * 60 * 1_000),
  }));
  const row = {
    id: targetId,
    merchantId,
    actualLiters: 60,
    actualKg: 100,
    massSource: 'SCALE',
    densityFactor: null,
    quality: 'PASS',
    grade: 'A',
    collectedAt: targetDate,
    merchant: { businessName: 'Quán bất thường' },
    collector: { displayName: 'Người thu gom' },
  };

  function createAnomalyService(
    feedback: Array<Record<string, unknown>> = [],
    candidateRow = row,
    historyRows = history,
  ) {
    const candidateFindMany = jest.fn().mockResolvedValue([candidateRow]);
    const feedbackFindMany = jest.fn().mockResolvedValue(feedback);
    const findUnique = jest.fn().mockResolvedValue(row);
    const upsert = jest.fn().mockResolvedValue({
      id: 'feedback-1',
      transactionId: targetId,
      verdict: 'CONFIRMED_ANOMALY',
      note: 'Đã đối chiếu',
      reviewerUserId: 'admin-1',
      riskScoreSnapshot: 80,
      riskLevelSnapshot: 'REVIEW',
      reasonsSnapshot: [],
      createdAt: targetDate,
      updatedAt: targetDate,
    });
    const prisma = {
      collectionTransaction: { findMany: candidateFindMany, findUnique },
      anomalyFeedback: { findMany: feedbackFindMany, upsert },
    } as unknown as PrismaService;
    candidateFindMany.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select?.merchant ? [candidateRow] : historyRows,
    );
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    } as unknown as ConfigService;
    const stations = {
      listFillAlertCandidates: jest.fn().mockResolvedValue([]),
    } as unknown as StationsService;
    return {
      service: new AdminService(prisma, config, stations),
      candidateFindMany,
      feedbackFindMany,
      findUnique,
      upsert,
    };
  }

  it('returns explainable anomaly items with a structured reason and feedback', async () => {
    const { service, candidateFindMany, feedbackFindMany } = createAnomalyService();
    const result = await service.listAiAnomalies({
      window_days: 90,
      page: 1,
      limit: 20,
      include_inactive: false,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      transaction_id: targetId,
      merchant_name: 'Quán bất thường',
      risk_level: 'REVIEW',
      reason_codes: expect.arrayContaining([
        expect.objectContaining({ code: 'MASS_OR_VOLUME_OUTLIER' }),
      ]),
      feedback: null,
    });
    expect(candidateFindMany).toHaveBeenCalledTimes(2);
    expect(feedbackFindMany).toHaveBeenCalledTimes(1);
  });

  it('upserts feedback with the current score and reasons snapshot', async () => {
    const { service, upsert, findUnique } = createAnomalyService();
    const result = await service.updateAiAnomalyFeedback(
      targetId,
      { verdict: AnomalyFeedbackVerdict.CONFIRMED_ANOMALY, note: 'Đã kiểm tra' },
      'admin-1',
    );

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: targetId } }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transactionId: targetId },
        create: expect.objectContaining({ reviewerUserId: 'admin-1', riskLevelSnapshot: 'REVIEW' }),
        update: expect.objectContaining({ reviewerUserId: 'admin-1' }),
      }),
    );
    expect(result).toMatchObject({ verdict: 'CONFIRMED_ANOMALY', reviewer_user_id: 'admin-1' });
  });

  it('calculates performance rates only from reviewed anomaly items', async () => {
    const feedback = [
      {
        id: 'feedback-1',
        transactionId: targetId,
        verdict: 'FALSE_POSITIVE',
        note: null,
        reviewerUserId: 'admin-1',
        riskScoreSnapshot: 80,
        riskLevelSnapshot: 'REVIEW',
        reasonsSnapshot: [],
        createdAt: targetDate,
        updatedAt: targetDate,
      },
    ];
    const { service } = createAnomalyService(feedback);
    const result = await service.aiAnomalyPerformance({ window_days: 90 });

    expect(result).toMatchObject({
      total_alerts: 1,
      reviewed_count: 1,
      unreviewed_count: 0,
      confirmed_count: 0,
      false_positive_count: 1,
      unsure_count: 0,
      confirmed_rate_percent: 0,
      false_positive_rate_percent: 100,
    });
  });

  it('lists a measured 20 liter and 50 kilogram transaction as a density anomaly', async () => {
    const physicalCandidate = {
      ...row,
      actualLiters: 20,
      actualKg: 50,
      massSource: 'SCALE',
      densityFactor: null,
    };
    const estimatedHistory = Array.from({ length: 6 }, (_, index) => ({
      ...historicalRow(`estimated-${index}`, index + 1),
      actualKg: 18.2,
      actualLiters: 20,
      massSource: 'ESTIMATED_FROM_VOLUME',
    }));
    const { service } = createAnomalyService([], physicalCandidate, estimatedHistory);

    const result = await service.listAiAnomalies({
      window_days: 90,
      page: 1,
      limit: 20,
      include_inactive: false,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      transaction_id: targetId,
      risk_level: 'REVIEW',
      reason_codes: expect.arrayContaining([
        expect.objectContaining({
          code: 'DENSITY_OUTLIER',
          evidence: expect.objectContaining({
            actual_density: 2.5,
            mass_source: 'SCALE',
            source: 'DOMAIN_DENSITY_BASELINE',
          }),
        }),
      ]),
    });
    expect((result.data[0].reason_codes[0] as { description: string }).description).toEqual(
      expect.any(String),
    );
  });
});

describe('AdminService pickup forecast performance', () => {
  it('loads one bounded batch and returns an empty, insufficient result without fake points', async () => {
    const findPickupForecastBacktestObservations = jest.fn().mockResolvedValue([]);
    const prisma = { findPickupForecastBacktestObservations } as unknown as PrismaService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const stations = { listFillAlertCandidates: jest.fn() } as unknown as StationsService;
    const service = new AdminService(prisma, config, stations);

    const result = await service.pickupForecastPerformance({ window_days: 90 });

    expect(findPickupForecastBacktestObservations).toHaveBeenCalledTimes(1);
    expect(findPickupForecastBacktestObservations.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(findPickupForecastBacktestObservations.mock.calls[0]?.[1]).toBeInstanceOf(Date);
    expect(result).toMatchObject({
      window_days: 90,
      sample_count: 0,
      reliability: 'INSUFFICIENT',
      mae_liters: null,
      wape_pct: null,
      bias_liters: null,
      accuracy_pct: null,
      points: [],
    });
  });

  it('evaluates only observations inside the requested window and preserves rolling-origin details', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1_000;
    const findPickupForecastBacktestObservations = jest.fn().mockResolvedValue([
      {
        merchant_id: merchantId,
        merchant_name: 'Quán thử nghiệm',
        collected_at: new Date(now - 2 * dayMs),
        actual_liters: 10,
        declared_estimated_liters: null,
        container_capacity_liters: 30,
      },
      {
        merchant_id: merchantId,
        merchant_name: 'Quán thử nghiệm',
        collected_at: new Date(now - dayMs),
        actual_liters: 10,
        declared_estimated_liters: null,
        container_capacity_liters: 30,
      },
      {
        merchant_id: merchantId,
        merchant_name: 'Quán thử nghiệm',
        collected_at: new Date(now + dayMs),
        actual_liters: 999,
        declared_estimated_liters: null,
        container_capacity_liters: 30,
      },
    ]);
    const prisma = { findPickupForecastBacktestObservations } as unknown as PrismaService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const stations = { listFillAlertCandidates: jest.fn() } as unknown as StationsService;
    const service = new AdminService(prisma, config, stations);

    const result = await service.pickupForecastPerformance({ window_days: 30 });

    expect(result.sample_count).toBe(1);
    expect(result.points[0]).toMatchObject({ actual_liters: 10, history_sample_size: 1 });
    expect(result.points.some((point) => point.actual_liters === 999)).toBe(false);
  });
});

describe('admin alert resolution query contract', () => {
  it('parses query string false as false and true as true', () => {
    expect(
      adminAlertListQuerySchema.parse({ page: '1', limit: '20', resolved: 'false' }).resolved,
    ).toBe(false);
    expect(
      adminAlertListQuerySchema.parse({ page: '1', limit: '20', resolved: 'true' }).resolved,
    ).toBe(true);
    expect(adminAlertListQuerySchema.parse({ page: '1', limit: '20' }).resolved).toBeUndefined();
  });
});
