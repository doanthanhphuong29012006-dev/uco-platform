process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const containerId = '60000000-0000-4000-8000-000000000007';

describe('Admin container return to merchant (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let collectorToken: string;
  let approvedMerchantId: string;
  let secondMerchantId: string;
  let originalState: string;
  let originalMerchantId: string | null;
  let originalMerchantApproval: string;

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
    prisma = app.get(PrismaService);

    const container = await prisma.container.findUnique({ where: { id: containerId } });
    if (!container) throw new Error(`Seed container ${containerId} was not found`);
    originalState = container.state;
    originalMerchantId = container.merchantId;

    const approvedMerchant = await prisma.merchant.findFirst({
      where: { user: { zaloId: 'zalo_merchant_01' } },
    });
    const secondMerchant = await prisma.merchant.findFirst({
      where: { user: { zaloId: 'zalo_merchant_02' } },
    });
    if (!approvedMerchant || !secondMerchant) throw new Error('Seed merchants for container return tests were not found');
    approvedMerchantId = approvedMerchant.id;
    secondMerchantId = secondMerchant.id;
    originalMerchantApproval = secondMerchant.approvalStatus;

    await prisma.merchant.update({ where: { id: approvedMerchantId }, data: { approvalStatus: 'APPROVED' } });
    adminToken = await login('zalo_admin_01', '0990000001');
    collectorToken = await login('zalo_collector_01', '0910000001');
  });

  beforeEach(async () => {
    await prisma.merchant.update({ where: { id: approvedMerchantId }, data: { approvalStatus: 'APPROVED' } });
    await prisma.merchant.update({ where: { id: secondMerchantId }, data: { approvalStatus: 'APPROVED' } });
    await prisma.container.update({
      where: { id: containerId },
      data: { state: 'AT_STATION', merchantId: approvedMerchantId, lastSeenAt: null },
    });
  });

  afterAll(async () => {
    await prisma.container.update({
      where: { id: containerId },
      data: { state: originalState as 'AT_MERCHANT' | 'IN_TRANSIT' | 'AT_STATION', merchantId: originalMerchantId },
    });
    await prisma.merchant.update({
      where: { id: secondMerchantId },
      data: { approvalStatus: originalMerchantApproval as 'PENDING' | 'APPROVED' | 'REJECTED' },
    });
    await app.close();
  });

  it('returns an AT_STATION container to its approved merchant and writes RETURN_CONTAINER audit log', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Đã nhận tại kho' })
      .expect(201);

    expect(response.body.state).toBe('AT_MERCHANT');
    expect(response.body.merchant.id).toBe(approvedMerchantId);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'RETURN_CONTAINER', entityId: containerId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect((audit?.details as { before: { state: string }; after: { state: string } }).before.state).toBe('AT_STATION');
    expect((audit?.details as { before: { state: string }; after: { state: string } }).after.state).toBe('AT_MERCHANT');
  });

  it('rejects a second return after the container is AT_MERCHANT', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(response.body.code).toBe('CONTAINER_NOT_AT_STATION');
    expect(response.body.details.state).toBe('AT_MERCHANT');
  });

  it('rejects an AT_MERCHANT container with CONTAINER_NOT_AT_STATION', async () => {
    await prisma.container.update({ where: { id: containerId }, data: { state: 'AT_MERCHANT' } });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(response.body.code).toBe('CONTAINER_NOT_AT_STATION');
  });

  it('rejects an unapproved merchant destination', async () => {
    await prisma.merchant.update({ where: { id: secondMerchantId }, data: { approvalStatus: 'PENDING' } });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ merchant_id: secondMerchantId })
      .expect(400);
    expect(response.body.code).toBe('MERCHANT_NOT_APPROVED');
  });

  it('rejects a collector with 403', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/return-to-merchant`)
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });
});
