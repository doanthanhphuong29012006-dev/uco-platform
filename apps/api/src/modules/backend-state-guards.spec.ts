import type { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import type { CollectionCreateInput } from '@eco-oil/validation';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin/admin.service';
import { CollectionsService } from './collections/collections.service';
import { OrdersService } from './orders/orders.service';
import { PaymentsService } from './payments/payments.service';
import type { StationsService } from './stations/stations.service';

const config = { get: (_key: string, fallback?: unknown) => fallback } as ConfigService;
const merchant = { id: 'merchant', status: 'ACTIVE', approvalStatus: 'APPROVED', wardId: 'ward', lastCollectedAt: null };
const container = { id: 'container', merchantId: merchant.id, status: 'ACTIVE', state: 'AT_MERCHANT', capacityLiters: 30, deletedAt: null };

describe('createReady validates the container after acquiring its lock', () => {
  function setup(lockedContainer: Record<string, unknown> | null) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: container.id }]),
      container: { findUnique: jest.fn().mockResolvedValue(lockedContainer) },
      collectionOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'order', ...data })),
      },
      collectorWard: { findFirst: jest.fn().mockResolvedValue({ collectorId: 'collector' }) },
    };
    const prisma = {
      merchant: { findUnique: jest.fn().mockResolvedValue(merchant) },
      container: { count: jest.fn().mockResolvedValue(1), findUnique: jest.fn().mockResolvedValue(container) },
      $transaction: (fn: (db: typeof tx) => unknown) => fn(tx),
    };
    return { service: new OrdersService(prisma as unknown as PrismaService), tx };
  }

  it.each([
    ['unassigned', { ...container, merchantId: null }],
    ['reassigned', { ...container, merchantId: 'other' }],
    ['in transit', { ...container, state: 'IN_TRANSIT' }],
    ['inactive', { ...container, status: 'INACTIVE' }],
    ['deleted', { ...container, deletedAt: new Date() }],
    ['missing', null],
  ])('rejects a container that became %s after the initial read', async (_name, current) => {
    const { service, tx } = setup(current);
    await expect(service.createReady({ sub: 'user', role: Role.MERCHANT }, { container_id: container.id }))
      .rejects.toMatchObject({ response: { code: 'CONTAINER_NO_LONGER_AVAILABLE' } });
    expect(tx.collectionOrder.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.container.findUnique.mock.invocationCallOrder[0]);
  });

  it('uses the current capacity for the default volume', async () => {
    const { service } = setup({ ...container, capacityLiters: 15 });
    const result = await service.createReady({ sub: 'user', role: Role.MERCHANT }, { container_id: container.id });
    expect(result.expected_liters).toBe(15);
    expect(result.status).toBe('READY');
  });

  it('rejects an explicit volume that exceeds the current capacity', async () => {
    const { service, tx } = setup({ ...container, capacityLiters: 15 });
    await expect(service.createReady({ sub: 'user', role: Role.MERCHANT }, { container_id: container.id, expected_liters: 20 }))
      .rejects.toMatchObject({ response: { code: 'EXPECTED_LITERS_EXCEEDS_CAPACITY' } });
    expect(tx.collectionOrder.create).not.toHaveBeenCalled();
  });
});

describe('payment confirmation lock', () => {
  it('allows only one confirmation and one audit when two calls race', async () => {
    let status = 'PENDING';
    let tail = Promise.resolve();
    const update = jest.fn().mockImplementation(async () => {
      status = 'PAID';
      return {
        id: 'payment', merchantId: 'merchant', transactionId: 'transaction', period: '2026-W37', status,
        liters: new Prisma.Decimal(10), kilograms: null, unitPrice: new Prisma.Decimal(100),
        unit: 'PER_LITER', amount: new Prisma.Decimal(1000), paidAt: new Date(), createdAt: new Date(),
        merchant: { businessName: 'Shop' }, transaction: { collectedAt: new Date() },
      };
    });
    const audit = jest.fn().mockResolvedValue({});
    const locks: string[] = [];
    const prisma = {
      $transaction: async (fn: (db: unknown) => Promise<unknown>) => {
        let release: (() => void) | undefined;
        const tx = {
          // Model a row lock held until transaction completion, not a no-op mock.
          $queryRaw: async (sql: TemplateStringsArray) => {
            locks.push(sql.join('?'));
            const previous = tail;
            tail = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            return [{ id: 'payment' }];
          },
          payment: { findUnique: async () => ({ id: 'payment', status }), update },
          auditLog: { create: audit },
        };
        try { return await fn(tx); } finally { release?.(); }
      },
    };
    const service = new PaymentsService(prisma as unknown as PrismaService);
    const results = await Promise.allSettled([service.markPaid('payment', 'admin1'), service.markPaid('payment', 'admin2')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { response: { code: 'PAYMENT_ALREADY_PAID' } } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(locks).toHaveLength(2);
    expect(locks.every((sql) => sql.includes('FROM "payments"') && sql.includes('FOR UPDATE'))).toBe(true);
  });
});

describe('cancel transit rechecks state under the container lock', () => {
  function setup(stateAfterLock: string) {
    let state = 'IN_TRANSIT';
    const tx = {
      $queryRaw: jest.fn().mockImplementation(async () => { state = stateAfterLock; return [{ id: container.id }]; }),
      container: {
        findUnique: jest.fn().mockImplementation(async () => ({ ...container, state, merchant: { businessName: 'Shop' } })),
        update: jest.fn().mockImplementation(async () => ({ ...container, merchant: null })),
      },
      collectionTransaction: { findMany: jest.fn().mockResolvedValue([{ id: 'pending-transaction' }]) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      alert: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: (fn: (db: typeof tx) => unknown) => fn(tx) };
    return { service: new AdminService(prisma as unknown as PrismaService, config, {} as StationsService), tx };
  }

  it('does not overwrite a delivery committed while waiting for the lock', async () => {
    const { service, tx } = setup('AT_STATION');
    await expect(service.cancelContainerTransit(container.id, {}, 'admin'))
      .rejects.toMatchObject({ response: { code: 'CONTAINER_NOT_IN_TRANSIT', details: { state: 'AT_STATION' } } });
    expect(tx.container.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.container.findUnique.mock.invocationCallOrder[0]);
  });

  it('still allows cancellation when the locked state is IN_TRANSIT', async () => {
    const { service, tx } = setup('IN_TRANSIT');
    const result = await service.cancelContainerTransit(container.id, {}, 'admin');
    expect(result.affected_transaction_ids).toEqual(['pending-transaction']);
    expect(tx.container.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'AT_MERCHANT' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('collection UUID replay is bound to the original order', () => {
  function setup(orderStatus: 'COLLECTED' | 'READY', replayOrderId: string | null) {
    const replay = { id: 'transaction', order_id: replayOrderId, client_uuid: 'same-key', actual_liters: 10, actual_kg: 9.1 };
    const tx = {
      collector: { findUnique: jest.fn().mockResolvedValue({ id: 'collector', status: 'ACTIVE', collectorWards: [{ wardId: 'ward' }] }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockImplementation(async (sql: TemplateStringsArray) => {
        const query = sql.join('?');
        if (query.includes('WHERE ct."client_uuid"')) return [replay];
        if (query.includes('ST_Distance')) return [{ distanceM: 0 }];
        return []; // Order lock; INSERT conflict with an existing client UUID.
      }),
      collectionOrder: {
        findUnique: jest.fn().mockResolvedValue({ id: 'order-B', status: orderStatus, merchant, merchantId: merchant.id, containerId: container.id, container: { ...container, qrCode: 'QR' } }),
        update: jest.fn(),
      },
      collectionTransaction: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: (fn: (db: typeof tx) => unknown) => fn(tx) };
    return { service: new CollectionsService(prisma as unknown as PrismaService, config), tx };
  }
  const user = { sub: 'user', role: Role.COLLECTOR };
  const input = { order_id: 'order-B', client_uuid: 'same-key', container_code: 'QR', actual_liters: 10, quality: 'PASS', grade: 'A', suspected_adulteration: false, photos: [], geo: { lat: 10, lng: 106 } } as CollectionCreateInput;

  it.each(['COLLECTED', 'READY'] as const)('rejects another order on the %s replay path without modifying sync state', async (status) => {
    const { service, tx } = setup(status, 'order-A');
    await expect(service.processOne(user, input, true)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(tx.collectionTransaction.update).not.toHaveBeenCalled();
    expect(tx.collectionOrder.update).not.toHaveBeenCalled();
  });

  it.each(['COLLECTED', 'READY'] as const)('preserves retries for the same order on the %s replay path', async (status) => {
    const { service } = setup(status, input.order_id);
    const result = await service.processOne(user, input, true);
    expect(result.replayed).toBe(true);
    expect(result.data.order_id).toBe(input.order_id);
  });

  it('rejects a legacy UUID not associated with an order', async () => {
    const { service } = setup('COLLECTED', null);
    await expect(service.processOne(user, input, true)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});
