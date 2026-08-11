process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/uco_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'dev-secret';
process.env.ZALO_AUTH_MODE = 'mock';

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
});
