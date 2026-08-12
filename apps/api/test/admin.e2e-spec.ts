process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const merchantId = '20000000-0000-4000-8000-000000000004';
const collectorUserId = '40000000-0000-4000-8000-000000000201';
const containerId = '60000000-0000-4000-8000-000000000007';
const stationId = '30000000-0000-4000-8000-000000000001';
const adminUserId = '40000000-0000-4000-8000-000000000999';

describe('Admin KPIs, reconciliation and access control (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let collectorToken: string;
  let transactionId: string;
  let alertId: string;

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
    adminToken = await login('zalo_admin_01', '0990000001');
    collectorToken = await login('zalo_collector_01', '0910000001');

    await prisma.collectionOrder.updateMany({
      where: { containerId, status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.container.update({ where: { id: containerId }, data: { state: 'AT_MERCHANT', lastSeenAt: null } });
    await prisma.collector.update({ where: { userId: collectorUserId }, data: { status: 'ACTIVE' } });
    await prisma.station.update({ where: { id: stationId }, data: { capacityLiters: 1000, currentVolumeLiters: 0 } });

    const merchantToken = await login('zalo_merchant_04', '0900000004');
    const order = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerId, expected_liters: 10 })
      .expect(201);
    const collection = await request(app.getHttpServer())
      .post('/api/v1/collections')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({
        client_uuid: randomUUID(),
        order_id: order.body.id,
        container_code: 'ECO-UCO-Q3-P7-007',
        actual_liters: 10,
        quality: 'PASS',
        geo: { lat: 10.78095, lng: 106.68425 },
        photos: ['https://example.com/admin.jpg'],
        collected_at: '2026-08-11T10:00:00Z',
      })
      .expect(201);
    transactionId = collection.body.id as string;
    const alert = await prisma.alert.create({
      data: {
        transactionId,
        type: 'GEO_MISMATCH',
        severity: 'HIGH',
        message: 'Admin e2e alert',
        details: { source: 'admin-e2e' },
      },
    });
    alertId = alert.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns complete daily buckets and totals matching the database aggregate', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/overview?from=2026-08-01&to=2026-08-11')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(response.body.daily_liters).toHaveLength(11);
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-12T00:00:00.000Z');
    const aggregate = await prisma.collectionTransaction.aggregate({
      where: { deletedAt: null, collectedAt: { gte: from, lt: to } },
      _sum: { actualLiters: true },
    });
    expect(response.body.totals.liters).toBe(Number(aggregate._sum.actualLiters ?? 0));
  });

  it('shows a collected transaction as undelivered until station delivery, then removes it', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/admin/reconciliation?date=2026-08-11')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(before.body.undelivered_transactions.some((item: { id: string }) => item.id === transactionId)).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/station-deliveries')
      .set('Authorization', `Bearer ${collectorToken}`)
      .send({ client_uuid: randomUUID(), station_id: stationId, transaction_ids: [transactionId], actual_liters: 10, delivered_at: '2026-08-11T11:00:00Z' })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/admin/reconciliation?date=2026-08-11')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.undelivered_transactions.some((item: { id: string }) => item.id === transactionId)).toBe(false);
  });

  it('protects all admin routes from collector tokens', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/overview')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(403);
    expect(response.body).toEqual({ code: 'FORBIDDEN', message: 'Insufficient role', details: null });
  });

  it('returns alert pagination and merchant performance', async () => {
    const alerts = await request(app.getHttpServer())
      .get('/api/v1/admin/alerts?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(alerts.body).toHaveProperty('data');
    expect(alerts.body).toHaveProperty('meta.total');

    const performance = await request(app.getHttpServer())
      .get(`/api/v1/admin/merchants/${merchantId}/performance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(performance.body.merchant_id).toBe(merchantId);
    expect(performance.body.total_liters).toBeGreaterThanOrEqual(10);
  });

  it('resolves an alert and writes an audit log', async () => {
    const resolved = await request(app.getHttpServer())
      .patch(`/api/v1/admin/alerts/${alertId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(resolved.body.id).toBe(alertId);
    expect(resolved.body.resolved_at).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { actorUserId: adminUserId, entityType: 'Alert', entityId: alertId, action: 'RESOLVE_ALERT' } })).toBe(1);
  });
});
