process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CollectionRouteStatus, CollectionRouteStopStatus, ContainerState, OrderStatus, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

type Fixture = { zaloId: string; phone: string; userId: string; merchantId: string; containerId: string; code: string; token: string; lat: number; lng: number; expected: number };

describe('Full merchant-to-station working shift (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let collectorToken: string;
  let adminToken: string;
  let fixtures: Fixture[] = [];
  const orderIds: string[] = [];
  const transactionIds: string[] = [];
  const clientUuids: string[] = [];
  const routeIds: string[] = [];
  const deliveryClientUuids: string[] = [];
  let totalLiters = 0;

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
    jwt = app.get(JwtService);

    collectorToken = await login('zalo_collector_01', '0910000001');
    const ward = await prisma.ward.findFirst({ where: { deletedAt: null, status: 'ACTIVE', isActive: true }, select: { id: true } });
    if (!ward) throw new Error('Full-flow requires an active test ward');
    const admin = await prisma.user.findUnique({ where: { zaloId: 'zalo_admin_01' }, select: { id: true, role: true } });
    if (!admin || admin.role !== Role.ADMIN) throw new Error('Full-flow requires the seeded admin identity');
    adminToken = jwt.sign({ sub: admin.id, role: Role.ADMIN });
    for (const [index, expected] of [10, 12, 8].entries()) {
      const suffix = randomUUID().slice(0, 8);
      const user = await prisma.user.create({ data: { zaloId: `full_flow_${suffix}`, phone: `098${Date.now().toString().slice(-7)}${index}`, name: `Full flow ${index}`, role: Role.MERCHANT } });
      const merchant = await prisma.merchant.create({ data: { userId: user.id, wardId: ward.id, businessName: `Full flow ${suffix}`, address: 'Isolated E2E address', approvalStatus: 'APPROVED' } });
      const lat = 10.782 + index / 10_000;
      const lng = 106.684 + index / 10_000;
      await prisma.$executeRaw`UPDATE "merchants" SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography WHERE "id" = ${merchant.id}::uuid`;
      const container = await prisma.container.create({ data: { merchantId: merchant.id, wardId: ward.id, qrCode: `ECO-FULL-${suffix}`, capacityLiters: 30, state: ContainerState.AT_MERCHANT } });
      fixtures.push({ zaloId: user.zaloId!, phone: user.phone!, userId: user.id, merchantId: merchant.id, containerId: container.id, code: container.qrCode, token: jwt.sign({ sub: user.id, role: Role.MERCHANT }), lat, lng, expected });
    }
    totalLiters = fixtures.reduce((sum, fixture) => sum + fixture.expected, 0);
  });

  afterAll(async () => {
    const routeIdSet = [...new Set(routeIds)];
    const transactionIdSet = [...new Set(transactionIds)];
    const orderIdSet = [...new Set(orderIds)];
    const userIdSet = fixtures.map((fixture) => fixture.userId);
    if (deliveryClientUuids.length) await prisma.stationDelivery.deleteMany({ where: { clientUuid: { in: deliveryClientUuids } } }).catch(() => undefined);
    if (transactionIdSet.length) await prisma.payment.deleteMany({ where: { transactionId: { in: transactionIdSet } } }).catch(() => undefined);
    if (transactionIdSet.length) await prisma.alert.deleteMany({ where: { transactionId: { in: transactionIdSet } } }).catch(() => undefined);
    if (transactionIdSet.length) await prisma.anomalyFeedback.deleteMany({ where: { transactionId: { in: transactionIdSet } } }).catch(() => undefined);
    if (routeIdSet.length) await prisma.collectionRouteStop.deleteMany({ where: { routeId: { in: routeIdSet } } }).catch(() => undefined);
    if (transactionIdSet.length) await prisma.collectionTransaction.deleteMany({ where: { id: { in: transactionIdSet } } }).catch(() => undefined);
    if (routeIdSet.length) await prisma.collectionRoute.deleteMany({ where: { id: { in: routeIdSet } } }).catch(() => undefined);
    if (orderIdSet.length) await prisma.collectionOrder.deleteMany({ where: { id: { in: orderIdSet } } }).catch(() => undefined);
    if (fixtures.length) await prisma.container.deleteMany({ where: { id: { in: fixtures.map((fixture) => fixture.containerId) } } }).catch(() => undefined);
    if (fixtures.length) await prisma.merchant.deleteMany({ where: { id: { in: fixtures.map((fixture) => fixture.merchantId) } } }).catch(() => undefined);
    if (userIdSet.length) await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIdSet } } }).catch(() => undefined);
    if (userIdSet.length) await prisma.refreshToken.deleteMany({ where: { userId: { in: userIdSet } } }).catch(() => undefined);
    if (userIdSet.length) await prisma.user.deleteMany({ where: { id: { in: userIdSet } } }).catch(() => undefined);
    await app.close();
  });

  it('completes merchant request, collector route/collections, station delivery and admin reconciliation', async () => {
    for (const fixture of fixtures) {
      const merchantToken = fixture.token;
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
    expect(route.body.stops.every((stop: { priority: number }) => Number.isFinite(stop.priority))).toBe(true);
    expect(route.body.stops.map((stop: { order_id: string }) => stop.order_id).sort()).toEqual([...orderIds].sort());

    const startedRoute = await request(app.getHttpServer())
      .post('/api/v1/routes/start')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), lat: 10.7818, lng: 106.6851 })
      .expect(201);
    routeIds.push(startedRoute.body.route_id as string);
    expect(startedRoute.body.persisted).toBe(true);
    expect(startedRoute.body.stops.map((stop: { order_id: string }) => stop.order_id).sort()).toEqual([...orderIds].sort());

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
        grade: 'A',
        collector_selected_grade: 'A',
        collector_grade_confirmed: true,
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

    await request(app.getHttpServer())
      .post('/api/v1/routes/current/complete')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200)
      .expect((response) => expect(response.body.route_status).toBe('COMPLETED'));

    const stationChoice = await request(app.getHttpServer())
      .get(`/api/v1/stations/recommend?lat=10.7818&lng=106.6851&liters=${totalLiters}`)
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);
    expect(stationChoice.body.length).toBeGreaterThan(0);
    const stationId = stationChoice.body[0].id as string;

    const deliveryClientUuid = randomUUID();
    deliveryClientUuids.push(deliveryClientUuid);
    const delivery = await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: deliveryClientUuid, station_id: stationId, transaction_ids: transactionIds, actual_liters: totalLiters, delivered_at: collectedAt })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: deliveryClientUuid, station_id: stationId, transaction_ids: transactionIds, actual_liters: totalLiters, delivered_at: collectedAt })
      .expect(200)
      .expect('X-Idempotent-Replay', 'true');
    expect(replay.body.id).toBe(delivery.body.id);

    const today = new Date().toISOString().slice(0, 10);
    const reconciliation = await request(app.getHttpServer())
      .get(`/api/v1/admin/reconciliation?date=${today}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reconciliation.body.undelivered_transactions.filter((item: { id: string }) => transactionIds.includes(item.id))).toEqual([]);
    if (process.env.FULL_FLOW_CLEAN === '1') {
      expect(reconciliation.body.undelivered_transactions).toEqual([]);
    }

    const [orders, transactions, containers, routeStops, routes] = await Promise.all([
      prisma.collectionOrder.findMany({ where: { id: { in: orderIds } }, select: { status: true } }),
      prisma.collectionTransaction.findMany({ where: { clientUuid: { in: clientUuids } }, select: { actualLiters: true } }),
      prisma.container.findMany({ where: { id: { in: fixtures.map((fixture) => fixture.containerId) } }, select: { state: true } }),
      prisma.collectionRouteStop.findMany({ where: { routeId: { in: routeIds } }, select: { status: true } }),
      prisma.collectionRoute.findMany({ where: { id: { in: routeIds }, status: CollectionRouteStatus.COMPLETED }, select: { status: true } }),
    ]);
    expect(orders.every((order) => order.status === OrderStatus.COLLECTED)).toBe(true);
    expect(containers.filter((container) => container.state === ContainerState.AT_STATION)).toHaveLength(3);
    expect(routeStops).toHaveLength(3);
    expect(routeStops.every((stop) => stop.status === CollectionRouteStopStatus.COLLECTED)).toBe(true);
    expect(routes).toHaveLength(1);
    expect(transactions.reduce((sum, transaction) => sum + Number(transaction.actualLiters), 0)).toBe(totalLiters);
    const persistedDelivery = await prisma.stationDelivery.findUniqueOrThrow({ where: { clientUuid: deliveryClientUuid }, select: { actualLiters: true } });
    expect(Number(persistedDelivery.actualLiters)).toBe(totalLiters);
  });
});
