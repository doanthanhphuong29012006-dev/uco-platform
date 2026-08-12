process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ContainerState, OrderStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const fixtures = [
  { zaloId: 'zalo_merchant_01', phone: '0900000001', containerId: '60000000-0000-4000-8000-000000000001', code: 'ECO-UCO-Q3P7-001', lat: 10.78255, lng: 106.68475, expected: 10 },
  { zaloId: 'zalo_merchant_02', phone: '0900000002', containerId: '60000000-0000-4000-8000-000000000003', code: 'ECO-UCO-Q3P7-003', lat: 10.78195, lng: 106.68535, expected: 12 },
  { zaloId: 'zalo_merchant_03', phone: '0900000003', containerId: '60000000-0000-4000-8000-000000000005', code: 'ECO-UCO-Q3P7-005', lat: 10.78305, lng: 106.68615, expected: 8 },
] as const;

describe('Full merchant-to-station working shift (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let collectorToken: string;
  const orderIds: string[] = [];
  const transactionIds: string[] = [];
  const clientUuids: string[] = [];
  const totalLiters = fixtures.reduce((sum, fixture) => sum + fixture.expected, 0);

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

    // Keep this end-to-end scenario isolated from other suites sharing uco_test.
    await prisma.alert.deleteMany();
    await prisma.collectionTransaction.deleteMany();
    await prisma.stationDelivery.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.collectionOrder.deleteMany();
    await prisma.station.updateMany({ data: { currentVolumeLiters: 0 } });

    collectorToken = await login('zalo_collector_01', '0910000001');

    await prisma.collectionOrder.updateMany({
      where: { status: { in: [OrderStatus.READY, OrderStatus.ASSIGNED] } },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    await prisma.container.updateMany({
      where: { id: { in: fixtures.map((fixture) => fixture.containerId) } },
      data: { state: ContainerState.AT_MERCHANT, lastSeenAt: null },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('completes merchant request, collector route/collections, station delivery and admin reconciliation', async () => {
    for (const fixture of fixtures) {
      const merchantToken = await login(fixture.zaloId, fixture.phone);
      const order = await request(app.getHttpServer())
        .post('/api/v1/orders/ready')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ container_id: fixture.containerId, expected_liters: fixture.expected })
        .expect(201);
      orderIds.push(order.body.id as string);
    }

    const route = await request(app.getHttpServer())
      .get('/api/v1/routes/current?lat=10.7818&lng=106.6851')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);
    expect(route.body.stops).toHaveLength(3);
    expect(route.body.stops.map((stop: { priority: number }) => stop.priority)).toEqual(
      [...route.body.stops.map((stop: { priority: number }) => stop.priority)].sort((a, b) => b - a),
    );
    expect(route.body.stops.map((stop: { order_id: string }) => stop.order_id).sort()).toEqual([...orderIds].sort());

    const collectedAt = new Date().toISOString();
    for (const stop of route.body.stops as Array<{ order_id: string; container_code: string; expected_liters: number; merchant: { lat: number; lng: number } }>) {
      const container = await request(app.getHttpServer())
        .get(`/api/v1/containers/by-qr/${stop.container_code}`)
        .set('Authorization', `Bearer ${collectorToken}`)
        .expect(200);
      expect(container.body.qr_code).toBe(stop.container_code);

      const clientUuid = randomUUID();
      clientUuids.push(clientUuid);
      const payload = {
        client_uuid: clientUuid,
        order_id: stop.order_id,
        container_code: stop.container_code,
        actual_liters: stop.expected_liters,
        quality: 'PASS',
        geo: { lat: container.body.merchant.lat ?? stop.merchant.lat, lng: container.body.merchant.lng ?? stop.merchant.lng },
        photos: ['https://example.com/full-flow.jpg'],
        collected_at: collectedAt,
      };
      const first = await request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', `Bearer ${collectorToken}`).send(payload).expect(201);
      transactionIds.push(first.body.id as string);
      if (transactionIds.length === 1) {
        await request(app.getHttpServer())
          .post('/api/v1/collections')
          .set('Authorization', `Bearer ${collectorToken}`)
          .send(payload)
          .expect(200)
          .expect('X-Idempotent-Replay', 'true');
      }
    }

    const stationChoice = await request(app.getHttpServer())
      .get(`/api/v1/stations/recommend?lat=10.7818&lng=106.6851&liters=${totalLiters}`)
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);
    expect(stationChoice.body.length).toBeGreaterThan(0);
    const stationId = stationChoice.body[0].id as string;

    await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), station_id: stationId, transaction_ids: transactionIds, actual_liters: totalLiters, delivered_at: collectedAt })
      .expect(201);

    const adminToken = await login('zalo_admin_01', '0990000001');
    const today = new Date().toISOString().slice(0, 10);
    const reconciliation = await request(app.getHttpServer())
      .get(`/api/v1/admin/reconciliation?date=${today}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reconciliation.body.variance_l).toBe(0);
    expect(reconciliation.body.undelivered_transactions.filter((item: { id: string }) => transactionIds.includes(item.id))).toEqual([]);
    if (process.env.FULL_FLOW_CLEAN === '1') {
      expect(reconciliation.body.undelivered_transactions).toEqual([]);
    }

    const [orders, transactions, containers] = await Promise.all([
      prisma.collectionOrder.findMany({ where: { id: { in: orderIds } }, select: { status: true } }),
      prisma.collectionTransaction.findMany({ where: { clientUuid: { in: clientUuids } }, select: { actualLiters: true } }),
      prisma.container.findMany({ where: { id: { in: fixtures.map((fixture) => fixture.containerId) } }, select: { state: true } }),
    ]);
    expect(orders.every((order) => order.status === OrderStatus.COLLECTED)).toBe(true);
    expect(containers.filter((container) => container.state === ContainerState.AT_STATION)).toHaveLength(3);
    expect(transactions.reduce((sum, transaction) => sum + Number(transaction.actualLiters), 0)).toBe(totalLiters);
    expect(reconciliation.body.collected_liters).toBe(totalLiters);
    expect(reconciliation.body.delivered_liters).toBe(totalLiters);
  });
});
