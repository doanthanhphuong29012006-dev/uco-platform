process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ContainerState, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

describe('isolated order and route concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let collectorToken: string;
  let collectorId: string;
  const fixtureMerchantIds: string[] = [];

  async function createMerchantFixture() {
    const suffix = randomUUID().slice(0, 8);
    const ward = await prisma.ward.findFirst({ where: { deletedAt: null, status: 'ACTIVE', isActive: true }, select: { id: true } });
    if (!ward) throw new Error('Concurrency E2E requires an active ward');
    const user = await prisma.user.create({ data: { zaloId: `concurrency_${suffix}`, phone: `097${Date.now().toString().slice(-7)}`, name: 'Concurrency fixture', role: Role.MERCHANT } });
    const merchant = await prisma.merchant.create({ data: { userId: user.id, wardId: ward.id, businessName: `Concurrency ${suffix}`, address: 'Isolated concurrency fixture', approvalStatus: 'APPROVED' } });
    await prisma.$executeRaw`UPDATE "merchants" SET "location" = ST_SetSRID(ST_MakePoint(106.685, 10.782), 4326)::geography WHERE "id" = ${merchant.id}::uuid`;
    const container = await prisma.container.create({ data: { merchantId: merchant.id, wardId: ward.id, qrCode: `ECO-CON-${suffix}`, capacityLiters: 30, state: ContainerState.AT_MERCHANT } });
    fixtureMerchantIds.push(merchant.id);
    return { merchantId: merchant.id, userId: user.id, containerId: container.id, containerCode: container.qrCode, token: jwt.sign({ sub: user.id, role: Role.MERCHANT }) };
  }

  async function createOrder(fixture: Awaited<ReturnType<typeof createMerchantFixture>>) {
    const response = await request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${fixture.token}`).send({ container_id: fixture.containerId, expected_liters: 5 });
    if (response.status !== 201) throw new Error(`create order failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.id as string;
  }

  function collectionPayload(orderId: string, containerCode: string, clientUuid = randomUUID()) {
    return { client_uuid: clientUuid, order_id: orderId, container_code: containerCode, actual_liters: 5, quality: 'PASS', grade: 'A', collector_selected_grade: 'A', collector_grade_confirmed: true, geo: { lat: 10.782, lng: 106.685 }, photos: ['https://example.com/concurrency.jpg'] };
  }

  async function cleanupFixtures() {
    const merchants = fixtureMerchantIds.splice(0);
    if (merchants.length === 0) return;
    const orders = await prisma.collectionOrder.findMany({ where: { merchantId: { in: merchants } }, select: { id: true } });
    const orderIds = orders.map((order) => order.id);
    const routes = orderIds.length ? await prisma.collectionRouteStop.findMany({ where: { orderId: { in: orderIds } }, select: { routeId: true } }) : [];
    const routeIds = [...new Set(routes.map((route) => route.routeId))];
    if (routeIds.length) await prisma.collectionRouteStop.deleteMany({ where: { routeId: { in: routeIds } } });
    if (routeIds.length) await prisma.collectionRoute.deleteMany({ where: { id: { in: routeIds } } });
    const transactionIds = orderIds.length
      ? (await prisma.collectionTransaction.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((row) => row.id)
      : [];
    if (transactionIds.length) {
      await prisma.alert.deleteMany({ where: { transactionId: { in: transactionIds } } });
      await prisma.anomalyFeedback.deleteMany({ where: { transactionId: { in: transactionIds } } });
      await prisma.collectionTransaction.deleteMany({ where: { id: { in: transactionIds } } });
    }
    if (orderIds.length) await prisma.collectionOrder.deleteMany({ where: { id: { in: orderIds } } });
    const containers = await prisma.container.findMany({ where: { merchantId: { in: merchants } }, select: { id: true } });
    if (containers.length) await prisma.container.deleteMany({ where: { id: { in: containers.map((container) => container.id) } } });
    const rows = await prisma.merchant.findMany({ where: { id: { in: merchants } }, select: { userId: true } });
    await prisma.merchant.deleteMany({ where: { id: { in: merchants } } });
    const userIds = rows.map((row) => row.userId);
    if (userIds.length) await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/zalo').send({ zalo_id: 'zalo_collector_01', phone: '0910000001' }).expect(201);
    collectorToken = login.body.access_token as string;
    collectorId = (await prisma.collector.findFirstOrThrow({ where: { user: { zaloId: 'zalo_collector_01' } }, select: { id: true } })).id;
  });

  afterEach(async () => { await cleanupFixtures(); });
  afterAll(async () => { await app.close(); });

  it('allows only one READY order when two requests race for one container', async () => {
    const fixture = await createMerchantFixture();
    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${fixture.token}`).send({ container_id: fixture.containerId, expected_liters: 5 }),
      request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${fixture.token}`).send({ container_id: fixture.containerId, expected_liters: 5 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await prisma.collectionOrder.count({ where: { merchantId: fixture.merchantId, status: 'READY', deletedAt: null } })).toBe(1);
  });

  it('serializes two collection UUIDs for the same order', async () => {
    const fixture = await createMerchantFixture();
    const orderId = await createOrder(fixture);
    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', `Bearer ${collectorToken}`).send(collectionPayload(orderId, fixture.containerCode)),
      request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', `Bearer ${collectorToken}`).send(collectionPayload(orderId, fixture.containerCode)),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status >= 400 && response.status < 500)).toHaveLength(1);
    expect(await prisma.collectionTransaction.count({ where: { orderId, deletedAt: null } })).toBe(1);
    expect((await prisma.collectionOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COLLECTED');
  });

  it('keeps cancel and collect mutually exclusive', async () => {
    const fixture = await createMerchantFixture();
    const orderId = await createOrder(fixture);
    const responses = await Promise.all([
      request(app.getHttpServer()).post(`/api/v1/orders/${orderId}/cancel`).set('Authorization', `Bearer ${fixture.token}`).send({}),
      request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', `Bearer ${collectorToken}`).send(collectionPayload(orderId, fixture.containerCode)),
    ]);
    expect(responses.filter((response) => response.status === 200 || response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status >= 400 && response.status < 500)).toHaveLength(1);
    const order = await prisma.collectionOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(['CANCELLED', 'COLLECTED']).toContain(order.status);
    expect(await prisma.collectionTransaction.count({ where: { orderId, deletedAt: null } })).toBeLessThanOrEqual(1);
  });

  it('does not deadlock start/cancelRoute or cancelRoute/collect', async () => {
    const fixture = await createMerchantFixture();
    const orderId = await createOrder(fixture);
    const startAndCancel = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/routes/start').set('Authorization', `Bearer ${collectorToken}`).send({ client_uuid: randomUUID(), lat: 10.782, lng: 106.685 }),
      request(app.getHttpServer()).post('/api/v1/routes/current/cancel').set('Authorization', `Bearer ${collectorToken}`).send({ reason: 'race test' }),
    ]);
    expect(startAndCancel.every((response) => response.status < 500)).toBe(true);
    const active = await prisma.collectionRoute.findFirst({ where: { collectorId, status: 'ACTIVE' }, include: { stops: true } });
    if (active?.stops.some((stop) => stop.orderId === orderId)) {
      const race = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/routes/current/cancel').set('Authorization', `Bearer ${collectorToken}`).send({ reason: 'race test' }),
        request(app.getHttpServer()).post('/api/v1/collections').set('Authorization', `Bearer ${collectorToken}`).send(collectionPayload(orderId, fixture.containerCode)),
      ]);
      expect(race.every((response) => response.status < 500)).toBe(true);
    }
    expect(await prisma.collectionTransaction.count({ where: { orderId, deletedAt: null } })).toBeLessThanOrEqual(1);
  });
});
