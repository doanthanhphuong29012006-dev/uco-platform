process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const containerId = '60000000-0000-4000-8000-0000000000ab';

describe('Admin cancel container transit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let collectorToken: string;
  let merchantToken: string;
  let merchantId: string;

  async function login(zaloId: string, phone: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: zaloId, phone })
      .expect(201);
    return response.body.access_token as string;
  }

  async function resetTransitState(): Promise<void> {
    await prisma.collectionOrder.updateMany({
      where: { containerId, status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.collectionTransaction.deleteMany({ where: { containerId } });
    await prisma.container.update({
      where: { id: containerId },
      data: { state: 'IN_TRANSIT', merchantId, lastSeenAt: new Date() },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const merchant = await prisma.merchant.findFirst({ where: { user: { zaloId: 'zalo_merchant_01' } } });
    if (!merchant) throw new Error('Seed merchant for cancel-transit tests was not found');
    merchantId = merchant.id;
    await prisma.merchant.update({ where: { id: merchantId }, data: { approvalStatus: 'APPROVED' } });
    await prisma.container.upsert({
      where: { id: containerId },
      update: { merchantId, wardId: merchant.wardId, state: 'IN_TRANSIT', status: 'ACTIVE', deletedAt: null, isActive: true, capacityLiters: 30 },
      create: { id: containerId, merchantId, wardId: merchant.wardId, qrCode: 'ECO-UCO-TEST-CANCEL-AB', state: 'IN_TRANSIT', status: 'ACTIVE', capacityLiters: 30 },
    });

    adminToken = await login('zalo_admin_01', '0990000001');
    collectorToken = await login('zalo_collector_01', '0910000001');
    merchantToken = await login('zalo_merchant_01', '0900000001');
  });

  beforeEach(async () => {
    await resetTransitState();
  });

  afterAll(async () => {
    await prisma.collectionOrder.updateMany({
      where: { containerId, status: { in: ['READY', 'ASSIGNED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.collectionTransaction.deleteMany({ where: { containerId } });
    await prisma.auditLog.deleteMany({ where: { entityId: containerId } });
    await prisma.alert.deleteMany({ where: { details: { path: ['container_id'], equals: containerId } } });
    await prisma.container.delete({ where: { id: containerId } });
    await app.close();
  });

  it('moves an IN_TRANSIT container to AT_MERCHANT and preserves its merchant', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Collector ended shift' })
      .expect(201);

    expect(response.body.state).toBe('AT_MERCHANT');
    expect(response.body.merchant.id).toBe(merchantId);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'CANCEL_TRANSIT', entityId: containerId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect((audit?.details as { after: { state: string; merchant_id: string; note: string } }).after).toMatchObject({
      state: 'AT_MERCHANT',
      merchant_id: merchantId,
      note: 'Collector ended shift',
    });
    const alert = await prisma.alert.findFirst({ where: { type: 'CONTAINER_TRANSIT_CANCELLED' }, orderBy: { createdAt: 'desc' } });
    expect(alert).toMatchObject({ severity: 'MEDIUM' });
  });

  it('rejects an AT_MERCHANT container with CONTAINER_NOT_IN_TRANSIT', async () => {
    await prisma.container.update({ where: { id: containerId }, data: { state: 'AT_MERCHANT' } });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(response.body.code).toBe('CONTAINER_NOT_IN_TRANSIT');
    expect(response.body.details.state).toBe('AT_MERCHANT');
  });

  it('rejects the second cancel-transit call with CONTAINER_NOT_IN_TRANSIT', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(response.body.code).toBe('CONTAINER_NOT_IN_TRANSIT');
  });

  it('keeps unsubmitted transaction actual_liters and quality unchanged', async () => {
    const transactionId = '70000000-0000-4000-8000-000000000007';
    const clientUuid = `cancel-transit-${Date.now()}`;
    await prisma.collectionTransaction.create({
      data: {
        id: transactionId,
        clientUuid,
        containerId,
        merchantId,
        collectorId: '50000000-0000-4000-8000-000000000001',
        actualLiters: 12.5,
        quality: 'FLAG',
        photos: [],
      },
    });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(response.body.affected_transaction_ids).toContain(transactionId);
    const transaction = await prisma.collectionTransaction.findUnique({ where: { id: transactionId } });
    expect(transaction?.quality).toBe('FLAG');
    expect(transaction?.stationDeliveryId).toBeNull();
    expect(Number(transaction?.actualLiters)).toBe(12.5);
  });

  it('rejects a COLLECTOR with FORBIDDEN', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('allows the merchant to create a new order after transit is cancelled', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/cancel-transit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders/ready')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ container_id: containerId, expected_liters: 10 })
      .expect(201);
    expect(response.body).toMatchObject({ container_id: containerId, status: 'READY' });
  });
});
