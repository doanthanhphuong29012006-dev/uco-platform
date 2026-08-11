process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const collectorUserId = '40000000-0000-4000-8000-000000000201';
const collectorId = '50000000-0000-4000-8000-000000000001';
const stationId = '30000000-0000-4000-8000-000000000001';
const containers = [
  { id: '60000000-0000-4000-8000-000000000001', merchant: 'zalo_merchant_01', phone: '0900000001', code: 'ECO-UCO-Q3P7-001', lat: 10.78255, lng: 106.68475 },
  { id: '60000000-0000-4000-8000-000000000002', merchant: 'zalo_merchant_01', phone: '0900000001', code: 'ECO-UCO-Q3P7-002', lat: 10.78255, lng: 106.68475 },
  { id: '60000000-0000-4000-8000-000000000003', merchant: 'zalo_merchant_02', phone: '0900000002', code: 'ECO-UCO-Q3P7-003', lat: 10.78195, lng: 106.68535 },
  { id: '60000000-0000-4000-8000-000000000004', merchant: 'zalo_merchant_02', phone: '0900000002', code: 'ECO-UCO-Q3P7-004', lat: 10.78195, lng: 106.68535 },
  { id: '60000000-0000-4000-8000-000000000005', merchant: 'zalo_merchant_03', phone: '0900000003', code: 'ECO-UCO-Q3P7-005', lat: 10.78305, lng: 106.68615 },
  { id: '60000000-0000-4000-8000-000000000006', merchant: 'zalo_merchant_03', phone: '0900000003', code: 'ECO-UCO-Q3P7-006', lat: 10.78305, lng: 106.68615 },
  { id: '60000000-0000-4000-8000-000000000007', merchant: 'zalo_merchant_04', phone: '0900000004', code: 'ECO-UCO-Q3P7-007', lat: 10.78095, lng: 106.68425 },
];

describe('Sync batch and station delivery reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let collectorToken: string;

  async function login(zaloId: string, phone: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/zalo').send({ zalo_id: zaloId, phone }).expect(201);
    return response.body.access_token as string;
  }

  async function orderFor(container: (typeof containers)[number]) {
    const token = await login(container.merchant, container.phone);
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${token}`)
      .send({ container_id: container.id, expected_liters: 10 })
      .expect(201);
    return response.body.id as string;
  }

  function collection(orderId: string, container: (typeof containers)[number], clientUuid = randomUUID(), actualLiters = 10) {
    return {
      client_uuid: clientUuid,
      order_id: orderId,
      container_code: container.code,
      actual_liters: actualLiters,
      quality: 'PASS',
      geo: { lat: container.lat, lng: container.lng },
      photos: ['https://example.com/sync.jpg'],
      collected_at: '2026-08-11T13:00:00Z',
    };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    collectorToken = await login('zalo_collector_01', '0910000001');

    await prisma.collectionOrder.updateMany({
      where: { status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.container.updateMany({
      where: { id: { in: containers.map((container) => container.id) } },
      data: { state: 'AT_MERCHANT', lastSeenAt: null },
    });
    await prisma.collector.update({ where: { id: collectorId }, data: { status: 'ACTIVE', maxCapacityLiters: 100 } });
    await prisma.user.update({ where: { id: collectorUserId }, data: { role: Role.COLLECTOR } });
    await prisma.station.update({ where: { id: stationId }, data: { capacityLiters: 1000, currentVolumeLiters: 0 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates three transactions in a batch and replays the same batch without adding rows', async () => {
    const items = [];
    for (const container of containers.slice(0, 3)) {
      items.push(collection(await orderFor(container), container));
    }
    const before = await prisma.collectionTransaction.count();
    const first = await request(app.getHttpServer()).post('/api/v1/sync/batch').set('Authorization', `Bearer ${collectorToken}`).send({ items }).expect(200);
    expect(first.body.summary).toEqual({ created: 3, duplicate: 0, failed: 0 });
    expect(first.body.results.every((result: { status: string }) => result.status === 'created')).toBe(true);
    const afterFirst = await prisma.collectionTransaction.count();
    expect(afterFirst).toBe(before + 3);

    const replay = await request(app.getHttpServer()).post('/api/v1/sync/batch').set('Authorization', `Bearer ${collectorToken}`).send({ items }).expect(200);
    expect(replay.body.summary).toEqual({ created: 0, duplicate: 3, failed: 0 });
    expect(await prisma.collectionTransaction.count()).toBe(afterFirst);
    expect((await prisma.collectionTransaction.findMany({ where: { clientUuid: { in: items.map((item) => item.client_uuid) } } })).every((row) => row.syncedAt !== null)).toBe(true);
  });

  it('continues after one invalid item and creates the other two', async () => {
    const itemOne = collection(await orderFor(containers[3]), containers[3], randomUUID(), 999);
    const itemTwo = collection(await orderFor(containers[4]), containers[4]);
    const itemThree = collection(await orderFor(containers[5]), containers[5]);
    const response = await request(app.getHttpServer()).post('/api/v1/sync/batch').set('Authorization', `Bearer ${collectorToken}`).send({ items: [itemOne, itemTwo, itemThree] }).expect(200);
    expect(response.body.summary).toEqual({ created: 2, duplicate: 0, failed: 1 });
    expect(response.body.results.find((result: { client_uuid: string }) => result.client_uuid === itemOne.client_uuid).error.code).toBe('INVALID_LITERS');
  });

  it('returns one created and one duplicate for the same client UUID in one batch', async () => {
    const item = collection(await orderFor(containers[6]), containers[6]);
    const response = await request(app.getHttpServer()).post('/api/v1/sync/batch').set('Authorization', `Bearer ${collectorToken}`).send({ items: [item, item] }).expect(200);
    expect(response.body.summary).toEqual({ created: 1, duplicate: 1, failed: 0 });
    expect(await prisma.collectionTransaction.count({ where: { clientUuid: item.client_uuid } })).toBe(1);
  });

  it('reconciles a matching delivery and flags a 10 percent variance', async () => {
    const createdItems = await prisma.collectionTransaction.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, actualLiters: true } });
    const firstDelivery = await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), station_id: stationId, transaction_ids: createdItems.map((row) => row.id), actual_liters: 30, delivered_at: '2026-08-11T14:00:00Z' })
      .expect(201);
    expect(firstDelivery.body.status).toBe('OK');
    expect(firstDelivery.body.expected_liters).toBe(30);
    expect(firstDelivery.body.variance_pct).toBe(0);
    expect((await prisma.station.findUnique({ where: { id: stationId }, select: { currentVolumeLiters: true } }))?.currentVolumeLiters.toNumber()).toBe(30);
    expect(await prisma.alert.count({ where: { stationDeliveryId: firstDelivery.body.id } })).toBe(0);

    const secondItems = await prisma.collectionTransaction.findMany({ where: { stationDeliveryId: null }, orderBy: { createdAt: 'desc' }, take: 2, select: { id: true } });
    const flagged = await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), station_id: stationId, transaction_ids: secondItems.map((row) => row.id), actual_liters: 22 })
      .expect(201);
    expect(flagged.body.status).toBe('FLAGGED');
    expect(flagged.body.variance_pct).toBeCloseTo(0.1, 5);
    expect(await prisma.alert.count({ where: { stationDeliveryId: flagged.body.id, type: 'DELIVERY_VARIANCE', severity: 'HIGH' } })).toBe(1);

    const replayConflict = await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), station_id: stationId, transaction_ids: createdItems.map((row) => row.id), actual_liters: 30 })
      .expect(409);
    expect(replayConflict.body.code).toBe('TRANSACTION_ALREADY_DELIVERED');
  });
});
