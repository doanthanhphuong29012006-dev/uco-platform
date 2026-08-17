process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { paymentPeriodFor } from '../src/modules/payments/payment-period';

const collectorUserId = '40000000-0000-4000-8000-000000000201';
const collectorId = '50000000-0000-4000-8000-000000000001';
const merchantOneId = '20000000-0000-4000-8000-000000000001';
const merchantTwoId = '20000000-0000-4000-8000-000000000002';
const merchantThreeId = '20000000-0000-4000-8000-000000000003';
const merchantFourId = '20000000-0000-4000-8000-000000000004';
const merchantFiveId = '20000000-0000-4000-8000-000000000005';
const containerTwoId = '60000000-0000-4000-8000-000000000002';
const containerFourId = '60000000-0000-4000-8000-000000000004';
const containerSevenId = '60000000-0000-4000-8000-000000000007';
const containerEightId = '60000000-0000-4000-8000-000000000009';
const containerOneId = '60000000-0000-4000-8000-000000000001';
const containerThreeId = '60000000-0000-4000-8000-000000000003';
const containerFiveId = '60000000-0000-4000-8000-000000000005';
const containerSixId = '60000000-0000-4000-8000-000000000006';

describe('Collections idempotency and geo validation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let paymentsService: PaymentsService;

  async function login(zaloId: string, phone: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: zaloId, phone })
      .expect(201);
    return response.body.access_token as string;
  }

  async function createOrder(token: string, containerId: string, expectedLiters?: number) {
    return request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', 'Bearer ' + token)
      .send({ container_id: containerId, ...(expectedLiters === undefined ? {} : { expected_liters: expectedLiters }) })
      .expect(201);
  }

  async function prepareContainer(containerId: string) {
    await prisma.collectionOrder.updateMany({
      where: { containerId, status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.container.update({ where: { id: containerId }, data: { state: 'AT_MERCHANT', lastSeenAt: null } });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    paymentsService = app.get(PaymentsService);

    await prisma.collectionOrder.updateMany({
      where: { status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.container.updateMany({
      where: { id: { in: [containerOneId, containerTwoId, containerThreeId, containerFourId, containerFiveId, containerSixId, containerSevenId, containerEightId] } },
      data: { state: 'AT_MERCHANT', lastSeenAt: null },
    });
    await prisma.user.update({ where: { id: collectorUserId }, data: { role: Role.COLLECTOR } });
    await prisma.collector.update({ where: { id: collectorId }, data: { status: 'ACTIVE', maxCapacityLiters: 100 } });
  });

  afterAll(async () => {
    const now = Date.now();
    await prisma.merchant.update({ where: { id: merchantOneId }, data: { avgDailyLiters: 20, lastCollectedAt: new Date(now) } });
    await prisma.merchant.update({ where: { id: merchantTwoId }, data: { avgDailyLiters: 18, lastCollectedAt: new Date(now - 3 * 24 * 60 * 60 * 1000) } });
    await prisma.merchant.update({ where: { id: merchantThreeId }, data: { avgDailyLiters: 25, lastCollectedAt: new Date(now - 10 * 24 * 60 * 60 * 1000) } });
    await prisma.merchant.update({ where: { id: merchantFourId }, data: { avgDailyLiters: 15, lastCollectedAt: new Date(now) } });
    await prisma.merchant.update({ where: { id: merchantFiveId }, data: { avgDailyLiters: 22, lastCollectedAt: new Date(now - 3 * 24 * 60 * 60 * 1000) } });
    await app.close();
  });

  it('inserts once, replays safely, applies side effects and keeps avg_daily_liters unchanged on replay', async () => {
    const merchantToken = await login('zalo_merchant_04', '0900000004');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerSevenId, 20);
    const clientUuid = randomUUID();
    const payload = {
      client_uuid: clientUuid,
      order_id: order.body.id,
      container_code: 'ECO-UCO-Q3-P7-007',
      actual_liters: 18.5,
      quality: 'PASS',
      geo: { lat: 10.78095, lng: 106.68425 },
      photos: ['https://example.com/collection-1.jpg'],
      collected_at: '2026-08-11T13:00:00Z',
    };

    const first = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send(payload)
      .expect(201);
    const avgAfterFirst = (await prisma.merchant.findUnique({ where: { id: merchantFourId }, select: { avgDailyLiters: true } }))?.avgDailyLiters;
    const firstCount = await prisma.collectionTransaction.count({ where: { clientUuid } });
    const firstOrder = await prisma.collectionOrder.findUnique({ where: { id: order.body.id } });
    const firstContainer = await prisma.container.findUnique({ where: { id: containerSevenId } });
    expect(first.body).toMatchObject({ client_uuid: clientUuid, actual_liters: 18.5, quality: 'PASS' });
    expect(firstCount).toBe(1);
    expect(firstOrder?.status).toBe('COLLECTED');
    expect(firstContainer?.state).toBe('IN_TRANSIT');

    const replay = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send(payload)
      .expect(200)
      .expect('X-Idempotent-Replay', 'true');
    const replayCount = await prisma.collectionTransaction.count({ where: { clientUuid } });
    const avgAfterReplay = (await prisma.merchant.findUnique({ where: { id: merchantFourId }, select: { avgDailyLiters: true } }))?.avgDailyLiters;
    expect(replay.body).toEqual(first.body);
    expect(replayCount).toBe(1);
    expect(avgAfterReplay?.toString()).toBe(avgAfterFirst?.toString());
  });

  it('handles five concurrent retries with one inserted transaction and no 500 responses', async () => {
    const merchantToken = await login('zalo_merchant_05', '0900000005');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerEightId, 20);
    const clientUuid = randomUUID();
    const payload = {
      client_uuid: clientUuid,
      order_id: order.body.id,
      container_code: 'ECO-UCO-Q3-P7-009',
      actual_liters: 18,
      quality: 'PASS',
      geo: { lat: 10.78155, lng: 106.68375 },
      photos: [],
      collected_at: '2026-08-11T13:01:00Z',
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', 'Bearer ' + collectorToken).send(payload),
      ),
    );
    const count = await prisma.collectionTransaction.count({ where: { clientUuid } });
    expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(count).toBe(1);
  });

  it('rejects liters above the 110 percent capacity limit', async () => {
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerTwoId, 20);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-002',
        actual_liters: 999,
        quality: 'PASS',
        geo: { lat: 10.78255, lng: 106.68475 },
        photos: [],
      })
      .expect(422);
    expect(response.body.code).toBe('INVALID_LITERS');
  });

  it('records a far geo point as FLAG and creates one GEO_MISMATCH alert', async () => {
    const merchantToken = await login('zalo_merchant_02', '0900000002');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerFourId, 20);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-004',
        actual_liters: 18,
        quality: 'PASS',
        geo: { lat: 10.828, lng: 106.7009 },
        photos: [],
      })
      .expect(201);
    const alerts = await prisma.alert.count({ where: { transactionId: response.body.id, type: 'GEO_MISMATCH' } });
    const alert = await prisma.alert.findFirst({ where: { transactionId: response.body.id, type: 'GEO_MISMATCH' } });
    expect(response.body.quality).toBe('FLAG');
    expect(alerts).toBe(1);
    expect(alert?.severity).toBe('HIGH');
  });

  it('creates a MEDIUM COLLECTION_LITERS_DEVIATION alert for 17 reported and 30 collected liters', async () => {
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerOneId, 17);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-001',
        actual_liters: 30,
        quality: 'PASS',
        geo: { lat: 10.78255, lng: 106.68475 },
        photos: [],
      })
      .expect(201);
    const alert = await prisma.alert.findFirst({ where: { transactionId: response.body.id, type: 'COLLECTION_LITERS_DEVIATION' } });
    expect(alert).toMatchObject({ type: 'COLLECTION_LITERS_DEVIATION', severity: 'MEDIUM' });
    expect(alert?.message).toContain('17 L');
    expect(alert?.message).toContain('30 L');
    expect(alert?.message).toContain('76.5%');
    expect(response.body.quality).toBe('PASS');
  });

  it('does not create a deviation alert when 20 reported and 22 collected liters are within 30 percent', async () => {
    const merchantToken = await login('zalo_merchant_02', '0900000002');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerThreeId, 20);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-003',
        actual_liters: 22,
        quality: 'PASS',
        geo: { lat: 10.78195, lng: 106.68535 },
        photos: [],
      })
      .expect(201);
    expect(await prisma.alert.count({ where: { transactionId: response.body.id, type: 'COLLECTION_LITERS_DEVIATION' } })).toBe(0);
  });

  it('does not create a deviation alert when an order has no expected liters', async () => {
    const merchantToken = await login('zalo_merchant_03', '0900000003');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerFiveId);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-005',
        actual_liters: 30,
        quality: 'PASS',
        geo: { lat: 10.78305, lng: 106.68615 },
        photos: [],
      })
      .expect(201);
    expect(await prisma.alert.count({ where: { transactionId: response.body.id, type: 'COLLECTION_LITERS_DEVIATION' } })).toBe(0);
  });

  it('keeps a deviation transaction PASS and allows it to be finalized as a payment', async () => {
    const merchantToken = await login('zalo_merchant_03', '0900000003');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerSixId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-006',
        actual_liters: 20,
        quality: 'PASS',
        geo: { lat: 10.78305, lng: 106.68615 },
        photos: [],
      })
      .expect(201);
    expect(response.body.quality).toBe('PASS');
    const transaction = await prisma.collectionTransaction.findUniqueOrThrow({ where: { id: response.body.id } });
    const period = paymentPeriodFor(transaction.collectedAt);
    await paymentsService.run(period, '40000000-0000-4000-8000-000000000999');
    expect(await prisma.payment.findUnique({ where: { transactionId: response.body.id } })).not.toBeNull();
    await prisma.payment.delete({ where: { transactionId: response.body.id } });
  });

  it('records manually weighed mass as SCALE with no density factor', async () => {
    await prisma.container.update({ where: { id: containerOneId }, data: { state: 'AT_MERCHANT' } });
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerOneId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-001', actual_liters: 10, actual_kg: 9.2, quality: 'PASS', geo: { lat: 10.78255, lng: 106.68475 }, photos: [] })
      .expect(201);
    expect(response.body).toMatchObject({ actual_kg: 9.2, mass_source: 'SCALE', density_factor: null });
  });

  it('converts volume to estimated mass, stores the factor and creates a LOW alert', async () => {
    await prisma.container.update({ where: { id: containerThreeId }, data: { state: 'AT_MERCHANT' } });
    const merchantToken = await login('zalo_merchant_02', '0900000002');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerThreeId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-003', actual_liters: 10, quality: 'PASS', geo: { lat: 10.78195, lng: 106.68535 }, photos: [] })
      .expect(201);
    expect(response.body).toMatchObject({ actual_kg: 9.1, mass_source: 'ESTIMATED_FROM_VOLUME', density_factor: 0.91 });
    expect(await prisma.alert.findFirst({ where: { transactionId: response.body.id, type: 'MASS_ESTIMATED_NOT_WEIGHED', severity: 'LOW' } })).not.toBeNull();
  });

  it('accepts kilogram-only collection input and derives liters with the stored density factor', async () => {
    await prepareContainer(containerOneId);
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerOneId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-001', actual_kg: 9.1, quality: 'PASS', geo: { lat: 10.78255, lng: 106.68475 }, photos: [] })
      .expect(201);
    expect(response.body).toMatchObject({ actual_liters: 10, actual_kg: 9.1, mass_source: 'SCALE', density_factor: 0.91 });
  });

  it('keeps both manually entered liters and kilograms without overwriting either value', async () => {
    await prepareContainer(containerTwoId);
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerTwoId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-002', actual_liters: 10, actual_kg: 8.7, quality: 'PASS', geo: { lat: 10.78255, lng: 106.68475 }, photos: [] })
      .expect(201);
    expect(response.body).toMatchObject({ actual_liters: 10, actual_kg: 8.7, mass_source: 'SCALE', density_factor: null });
  });

  it('rejects a collection when neither liters nor kilograms is provided', async () => {
    await prepareContainer(containerFourId);
    const merchantToken = await login('zalo_merchant_02', '0900000002');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerFourId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-004', quality: 'PASS', geo: { lat: 10.78255, lng: 106.68475 }, photos: [] })
      .expect(422);
    expect(response.body).toMatchObject({ code: 'INVALID_MASS_INPUT' });
    expect(response.body.message).toContain('Vui lòng nhập số kg hoặc số lít');
  });

  it('rejects kilogram-only input when its derived liters exceed container capacity', async () => {
    await prepareContainer(containerFiveId);
    const merchantToken = await login('zalo_merchant_03', '0900000003');
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const order = await createOrder(merchantToken, containerFiveId, 10);
    const response = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', 'Bearer ' + collectorToken)
      .send({ client_uuid: randomUUID(), order_id: order.body.id, container_code: 'ECO-UCO-Q3-P7-005', actual_kg: 31, quality: 'PASS', geo: { lat: 10.78255, lng: 106.68475 }, photos: [] })
      .expect(422);
    expect(response.body.code).toBe('INVALID_LITERS');
    expect(response.body.message).toContain('Số lít suy ra từ khối lượng');
  });

  it('returns collection history for the collector', async () => {
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const response = await request(app.getHttpServer()).get('/api/v1/collections/me?page=1&limit=20').set('Authorization', 'Bearer ' + collectorToken).expect(200);
    expect(response.body.data.length).toBeGreaterThanOrEqual(2);
    expect(response.body.meta.page).toBe(1);
  });
});
