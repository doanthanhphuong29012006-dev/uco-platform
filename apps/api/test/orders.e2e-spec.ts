process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const containerOneId = '60000000-0000-4000-8000-000000000001';
const containerTwoId = '60000000-0000-4000-8000-000000000003';
const containerThreeId = '60000000-0000-4000-8000-000000000005';
const merchantOneId = '20000000-0000-4000-8000-000000000001';
const merchantTwoId = '20000000-0000-4000-8000-000000000002';
const merchantThreeId = '20000000-0000-4000-8000-000000000003';
const multiWardId = '10000000-0000-4000-8000-000000000099';
const multiWardUserId = '40000000-0000-4000-8000-000000000099';
const multiWardMerchantId = '20000000-0000-4000-8000-000000000099';
const multiWardContainerId = '60000000-0000-4000-8000-000000000099';
const collectorOneId = '50000000-0000-4000-8000-000000000001';

describe('Orders and collector routes (e2e)', () => {
  let app: INestApplication;

  async function login(zaloId: string, phone: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: zaloId, phone })
      .expect(201);
    return response.body.access_token as string;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const prisma = app.get(PrismaService);
    await prisma.container.updateMany({
      where: { id: { in: [containerOneId, containerTwoId, containerThreeId] } },
      data: { state: 'AT_MERCHANT', lastSeenAt: null },
    });
    await prisma.collectionOrder.updateMany({
      where: { status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    const now = Date.now();
    await prisma.merchant.update({ where: { id: merchantOneId }, data: { avgDailyLiters: 20, lastCollectedAt: new Date(now) } });
    await prisma.merchant.update({ where: { id: merchantTwoId }, data: { avgDailyLiters: 18, lastCollectedAt: new Date(now - 3 * 24 * 60 * 60 * 1000) } });
    await prisma.merchant.update({ where: { id: merchantThreeId }, data: { avgDailyLiters: 25, lastCollectedAt: new Date(now - 10 * 24 * 60 * 60 * 1000) } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects expected liters above the assigned container capacity', async () => {
    const prisma = app.get(PrismaService);
    await prisma.collectionOrder.updateMany({
      where: { containerId: containerOneId, status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const tooMuch = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerOneId, expected_liters: 36 })
      .expect(400);
    expect(tooMuch.body.code).toBe('EXPECTED_LITERS_EXCEEDS_CAPACITY');
    expect(tooMuch.body.message).toContain('30');

    const valid = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerOneId, expected_liters: 30 })
      .expect(201);
    expect(valid.body.expected_liters).toBe(30);
    await prisma.collectionOrder.update({ where: { id: valid.body.id as string }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  });

  it('creates a READY order and blocks a duplicate for the same container', async () => {
    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const created = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerOneId, expected_liters: 25, note: 'Test order' })
      .expect(201);
    expect(created.body).toMatchObject({
      container_id: containerOneId,
      expected_liters: 25,
      status: 'READY',
      source: 'MANUAL',
    });

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerOneId, expected_liters: 25 })
      .expect(409);
    expect(duplicate.body.code).toBe('ORDER_ALREADY_OPEN');
    expect(duplicate.body.details).toMatchObject({ id: created.body.id, status: 'READY' });
  });

  it('sorts route stops by priority, applies capacity and enforces roles/ownership', async () => {
    const merchantOneToken = await login('zalo_merchant_01', '0900000001');
    const merchantTwoToken = await login('zalo_merchant_02', '0900000002');
    const merchantThreeToken = await login('zalo_merchant_03', '0900000003');

    const orderTwo = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantTwoToken}`)
      .send({ container_id: containerTwoId, expected_liters: 5 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantThreeToken}`)
      .send({ container_id: containerThreeId, expected_liters: 30 })
      .expect(201);

    const collectorToken = await login('zalo_collector_01', '0910000001');
    const route = await request(app.getHttpServer())
      .get('/api/v1/routes/current?lat=10.7818&lng=106.6851')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);
    expect(route.body.total_expected_liters).toBeLessThanOrEqual(100);
    expect(route.body.total_expected_liters).toBe(60);
    expect(route.body.stops).toHaveLength(3);
    expect(route.body.stops.map((stop: { priority: number }) => stop.priority)).toEqual([89, 50, 19]);
    expect(route.body.stops.every((stop: { distance_m: number }) => stop.distance_m >= 0 && stop.distance_m < 5000)).toBe(true);

    const merchantRoute = await request(app.getHttpServer())
      .get('/api/v1/routes/current')
      .set('Authorization', `Bearer ${merchantOneToken}`)
      .expect(403);
    expect(merchantRoute.body).toEqual({ code: 'FORBIDDEN', message: 'Insufficient role', details: null });

    const forbiddenCancel = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderTwo.body.id}/cancel`)
      .set('Authorization', `Bearer ${merchantOneToken}`)
      .expect(403);
    expect(forbiddenCancel.body).toEqual({ code: 'FORBIDDEN', message: 'Order ownership required', details: null });
  });

  it('returns READY stops from every ward assigned through collector_wards', async () => {
    const prisma = app.get(PrismaService);
    await prisma.collectionOrder.updateMany({
      where: { status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.ward.upsert({
      where: { id: multiWardId },
      update: { code: 'TEST-MULTI', status: 'ACTIVE', isActive: true, deletedAt: null },
      create: {
        id: multiWardId,
        code: 'TEST-MULTI',
        name: 'Phường kiểm thử đa địa bàn',
        district: 'Quận kiểm thử',
        city: 'Hà Nội',
        centerLat: 21.0333,
        centerLng: 105.85,
      },
    });
    await prisma.collectorWard.upsert({
      where: { collectorId_wardId: { collectorId: collectorOneId, wardId: multiWardId } },
      update: {},
      create: { collectorId: collectorOneId, wardId: multiWardId },
    });
    await prisma.user.upsert({
      where: { id: multiWardUserId },
      update: { role: 'MERCHANT', name: 'Merchant đa phường', phone: '0900000099' },
      create: { id: multiWardUserId, zaloId: 'zalo_test_multi_ward', phone: '0900000099', name: 'Merchant đa phường', role: 'MERCHANT' },
    });
    await prisma.merchant.upsert({
      where: { id: multiWardMerchantId },
      update: { wardId: multiWardId, status: 'ACTIVE', approvalStatus: 'APPROVED', deletedAt: null },
      create: { id: multiWardMerchantId, userId: multiWardUserId, wardId: multiWardId, businessName: 'Quán kiểm thử đa phường', status: 'ACTIVE', approvalStatus: 'APPROVED' },
    });
    await prisma.container.upsert({
      where: { id: multiWardContainerId },
      update: { merchantId: multiWardMerchantId, wardId: multiWardId, state: 'AT_MERCHANT', status: 'ACTIVE', capacityLiters: 30, deletedAt: null },
      create: { id: multiWardContainerId, merchantId: multiWardMerchantId, wardId: multiWardId, qrCode: 'ECO-UCO-TEST-MULTI-099', state: 'AT_MERCHANT', status: 'ACTIVE', capacityLiters: 30 },
    });
    await prisma.collectionOrder.createMany({
      data: [
        { merchantId: merchantOneId, containerId: containerOneId, expectedLiters: 5, priority: 80, status: 'READY', source: 'MANUAL' },
        { merchantId: multiWardMerchantId, containerId: multiWardContainerId, expectedLiters: 5, priority: 70, status: 'READY', source: 'MANUAL' },
      ],
    });

    const collectorToken = await login('zalo_collector_01', '0910000001');
    const route = await request(app.getHttpServer())
      .get('/api/v1/routes/current?lat=21.0333&lng=105.8500')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);

    expect(route.body.stops).toHaveLength(2);
    expect(route.body.stops.map((stop: { container_code: string }) => stop.container_code).sort()).toEqual([
      'ECO-UCO-Q3-P7-001',
      'ECO-UCO-TEST-MULTI-099',
    ].sort());

    await prisma.collectionOrder.updateMany({
      where: { merchantId: { in: [merchantOneId, multiWardMerchantId] }, status: 'READY' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.container.update({ where: { id: multiWardContainerId }, data: { status: 'INACTIVE', isActive: false, deletedAt: new Date() } });
    await prisma.merchant.update({ where: { id: multiWardMerchantId }, data: { status: 'INACTIVE', isActive: false, deletedAt: new Date() } });
    await prisma.ward.update({ where: { id: multiWardId }, data: { status: 'INACTIVE', isActive: false, deletedAt: new Date() } });
  });
});
