import { INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import type { OilPrice } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { paymentPeriodFor } from '../src/modules/payments/payment-period';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('Weekly merchant payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let paymentsService: PaymentsService;
  let adminToken: string;
  let merchantAToken: string;
  let originalPrice: OilPrice;
  let newPriceId: string | undefined;

  const suffix = randomUUID().slice(0, 8);
  const merchantAUserId = randomUUID();
  const merchantBUserId = randomUUID();
  const merchantAId = randomUUID();
  const merchantBId = randomUUID();
  const transactionAId = randomUUID();
  const transactionBId = randomUUID();
  const flaggedTransactionId = randomUUID();
  const transactionIds = [transactionAId, transactionBId, flaggedTransactionId];
  const period = '2030-W02';
  const boundaryCollectedAt = new Date('2030-01-06T17:30:00.000Z'); // Monday 00:30 in Vietnam.

  async function login(zaloId: string, phone: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/zalo').send({ zalo_id: zaloId, phone }).expect(201);
    return response.body.access_token as string;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    paymentsService = app.get(PaymentsService);
    adminToken = await login('zalo_admin_01', '0990000001');

    const openPrice = await prisma.oilPrice.findFirst({ where: { effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
    if (!openPrice) throw new Error('Payment e2e requires the seeded open oil price');
    originalPrice = openPrice;
    await prisma.oilPrice.update({ where: { id: openPrice.id }, data: { unitPrice: 6000 } });

    await prisma.user.createMany({
      data: [
        { id: merchantAUserId, zaloId: `zalo_payment_a_${suffix}`, phone: `0961${suffix}`, name: 'Quán thanh toán A', role: 'MERCHANT' },
        { id: merchantBUserId, zaloId: `zalo_payment_b_${suffix}`, phone: `0962${suffix}`, name: 'Quán thanh toán B', role: 'MERCHANT' },
      ],
    });
    await prisma.merchant.createMany({
      data: [
        { id: merchantAId, userId: merchantAUserId, wardId: '10000000-0000-4000-8000-000000000001', businessName: 'Quán thanh toán A', approvalStatus: 'APPROVED' },
        { id: merchantBId, userId: merchantBUserId, wardId: '10000000-0000-4000-8000-000000000001', businessName: 'Quán thanh toán B', approvalStatus: 'APPROVED' },
      ],
    });
    await prisma.collectionTransaction.createMany({
      data: [
        { id: transactionAId, clientUuid: randomUUID(), containerId: '60000000-0000-4000-8000-000000000001', merchantId: merchantAId, collectorId: '50000000-0000-4000-8000-000000000001', actualLiters: 10, grade: 'A', quality: 'PASS', collectedAt: boundaryCollectedAt },
        { id: transactionBId, clientUuid: randomUUID(), containerId: '60000000-0000-4000-8000-000000000001', merchantId: merchantBId, collectorId: '50000000-0000-4000-8000-000000000001', actualLiters: 5.5, grade: 'C', quality: 'PASS', collectedAt: new Date('2030-01-08T03:00:00.000Z') },
        { id: flaggedTransactionId, clientUuid: randomUUID(), containerId: '60000000-0000-4000-8000-000000000001', merchantId: merchantAId, collectorId: '50000000-0000-4000-8000-000000000001', actualLiters: 9, grade: 'A', quality: 'FLAG', collectedAt: new Date('2030-01-09T03:00:00.000Z') },
      ],
    });
    merchantAToken = await login(`zalo_payment_a_${suffix}`, `0961${suffix}`);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.payment.deleteMany({ where: { transactionId: { in: transactionIds } } }).catch(() => undefined);
    await prisma.collectionTransaction.deleteMany({ where: { id: { in: transactionIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { action: { in: ['RUN_PAYMENT_PERIOD', 'CREATE_OIL_PRICE', 'MARK_PAYMENT_PAID'] }, actorUserId: '40000000-0000-4000-8000-000000000999' } }).catch(() => undefined);
    if (newPriceId) await prisma.oilPrice.delete({ where: { id: newPriceId } }).catch(() => undefined);
    if (originalPrice) await prisma.oilPrice.update({ where: { id: originalPrice.id }, data: { unitPrice: originalPrice.unitPrice, effectiveTo: null } }).catch(() => undefined);
    await prisma.merchant.deleteMany({ where: { id: { in: [merchantAId, merchantBId] } } }).catch(() => undefined);
    await prisma.refreshToken.deleteMany({ where: { userId: { in: [merchantAUserId, merchantBUserId] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [merchantAUserId, merchantBUserId] } } }).catch(() => undefined);
    await app.close();
  });

  it('assigns Monday 00:30 Vietnam to the new ISO week', () => {
    expect(paymentPeriodFor(boundaryCollectedAt)).toBe(period);
  });

  it('runs a period twice without duplicating payments', async () => {
    const first = await request(app.getHttpServer()).post(`/api/v1/admin/payments/run?period=${period}`).set('Authorization', `Bearer ${adminToken}`).expect(201);
    expect(first.body).toEqual({ created: 2, skipped: 0, total_amount: 93000 });
    const countAfterFirst = await prisma.payment.count({ where: { transactionId: { in: transactionIds } } });

    const second = await request(app.getHttpServer()).post(`/api/v1/admin/payments/run?period=${period}`).set('Authorization', `Bearer ${adminToken}`).expect(201);
    expect(second.body).toEqual({ created: 0, skipped: 2, total_amount: 0 });
    expect(await prisma.payment.count({ where: { transactionId: { in: transactionIds } } })).toBe(countAfterFirst);
  });

  it('does not create a payment for a FLAG transaction', async () => {
    expect(await prisma.payment.findUnique({ where: { transactionId: flaggedTransactionId } })).toBeNull();
  });

  it('keeps snapshotted amounts unchanged after the oil price changes from 6000 to 7000', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { transactionId: transactionAId } });
    expect(before.unitPrice.toNumber()).toBe(6000);
    expect(before.amount.toNumber()).toBe(60000);

    const changed = await request(app.getHttpServer()).post('/api/v1/admin/oil-prices').set('Authorization', `Bearer ${adminToken}`).send({ unit_price: 7000, effective_from: '2030-02-01T00:00:00.000Z', note: 'Payment e2e price' }).expect(201);
    newPriceId = changed.body.id as string;
    const listed = await request(app.getHttpServer()).get(`/api/v1/admin/payments?period=${period}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    const oldPayment = (listed.body.data as Array<{ transaction_id: string; unit_price: number; amount: number }>).find((payment) => payment.transaction_id === transactionAId);
    expect(oldPayment).toMatchObject({ unit_price: 6000, amount: 60000 });
    const gradeCPayment = (listed.body.data as Array<{ transaction_id: string; unit_price: number; amount: number }>).find((payment) => payment.transaction_id === transactionBId);
    expect(gradeCPayment).toMatchObject({ unit_price: 6000, amount: 33000 });
  });

  it('calculates a payment from kilograms when the effective price unit is PER_KG', async () => {
    await prisma.collectionTransaction.update({ where: { id: transactionAId }, data: { actualKg: 10, massSource: 'SCALE', densityFactor: null } });
    await prisma.collectionTransaction.update({ where: { id: transactionBId }, data: { actualKg: 4.4, massSource: 'SCALE', densityFactor: null } });
    await prisma.payment.deleteMany({ where: { transactionId: transactionBId } });
    if (newPriceId) {
      await prisma.oilPrice.delete({ where: { id: newPriceId } });
      newPriceId = undefined;
    }
    await prisma.oilPrice.update({ where: { id: originalPrice.id }, data: { effectiveTo: null, unit: 'PER_KG', unitPrice: 1000 } });
    const result = await paymentsService.run(period, '40000000-0000-4000-8000-000000000999');
    expect(result.created).toBe(1);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: transactionBId } });
    expect(payment.unit).toBe('PER_KG');
    expect(payment.kilograms?.toNumber()).toBe(4.4);
    expect(payment.amount.toNumber()).toBe(4400);
    await prisma.oilPrice.update({ where: { id: originalPrice.id }, data: { unit: originalPrice.unit, unitPrice: originalPrice.unitPrice } });
  });

  it('never exposes merchant B payments through merchant A me endpoint', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/merchants/me/payments?period=${period}`).set('Authorization', `Bearer ${merchantAToken}`).expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].merchant_id).toBe(merchantAId);
    expect(response.body.data.some((payment: { merchant_id: string }) => payment.merchant_id === merchantBId)).toBe(false);
  });

  it('marks a pending payment paid once and rejects the second call', async () => {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: transactionAId } });
    await request(app.getHttpServer()).post(`/api/v1/admin/payments/${payment.id}/mark-paid`).set('Authorization', `Bearer ${adminToken}`).expect(201);
    const replay = await request(app.getHttpServer()).post(`/api/v1/admin/payments/${payment.id}/mark-paid`).set('Authorization', `Bearer ${adminToken}`).expect(409);
    expect(replay.body.code).toBe('PAYMENT_ALREADY_PAID');
  });

  it('throws NO_PRICE_CONFIGURED instead of using a hardcoded fallback', async () => {
    await expect(paymentsService.resolveUnitPrice(new Date('2000-01-01T00:00:00.000Z'))).rejects.toMatchObject({
      response: { code: 'NO_PRICE_CONFIGURED' },
    });
  });
});
