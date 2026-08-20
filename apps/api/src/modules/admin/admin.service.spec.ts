import type { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';
import type { PrismaService } from '../../prisma/prisma.service';

const merchantId = '20000000-0000-4000-8000-000000000001';
const otherMerchantId = '20000000-0000-4000-8000-000000000002';
const candidateTime = new Date('2026-08-20T09:00:00.000Z');

function transaction(id = 'candidate-1', merchant = merchantId, collectedAt = candidateTime.toISOString()) {
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
    collectedAt: new Date(candidateTime.getTime() - daysBefore * 24 * 60 * 60 * 1_000),
  };
}

function createService(currentTransactions: ReturnType<typeof transaction>[], history: ReturnType<typeof historicalRow>[]) {
  const queryRaw = jest.fn().mockResolvedValue([reconciliationRow(currentTransactions)]);
  const findMany = jest.fn().mockResolvedValue(history);
  const prisma = {
    $queryRaw: queryRaw,
    collectionTransaction: { findMany },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  } as unknown as ConfigService;
  return { service: new AdminService(prisma, config), queryRaw, findMany };
}

describe('AdminService reconciliation anomaly integration', () => {
  it('adds anomaly data while preserving existing transaction response fields', async () => {
    const candidate = transaction();
    const { service } = createService(
      [candidate],
      Array.from({ length: 6 }, (_, index) => historicalRow(`history-${index}`, index + 1)),
    );

    const result = await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });
    const returned = (result.by_collector as Array<{ transactions: Array<Record<string, unknown>> }>)[0].transactions[0];

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
    const validHistory = Array.from({ length: 5 }, (_, index) => historicalRow(`history-${index}`, index + 1));
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
    const anomaly = (result.undelivered_transactions as Array<{ anomaly: { historySize: number; explanation: { historyCount: number } } }>)[0]
      .anomaly;

    expect(anomaly.historySize).toBe(5);
    expect(anomaly.explanation.historyCount).toBe(5);
  });

  it('returns a safe normal result when merchant history is below the minimum', async () => {
    const { service } = createService(
      [transaction()],
      [historicalRow('history-1', 1), historicalRow('history-2', 2)],
    );

    const result = await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });
    const anomaly = (result.undelivered_transactions as Array<{ anomaly: { score: number; level: string; historySize: number } }>)[0]
      .anomaly;

    expect(anomaly).toMatchObject({ score: 0, level: 'NORMAL', historySize: 2 });
  });

  it('loads all merchant history in one batch instead of querying per transaction', async () => {
    const { service, queryRaw, findMany } = createService(
      [transaction('candidate-1'), transaction('candidate-2', otherMerchantId, '2026-08-20T10:00:00.000Z')],
      [],
    );

    await service.reconciliation({ date: new Date('2026-08-20T00:00:00.000Z') });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ merchantId: { in: [merchantId, otherMerchantId] } }) }),
    );
  });
});
