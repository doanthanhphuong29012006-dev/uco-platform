import { INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Merchant onboarding and collector provisioning (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const zaloId = `zalo_onboarding_${randomUUID().slice(0, 8)}`;
  const phone = `098${Date.now().toString().slice(-7)}`;
  const wardId = '10000000-0000-4000-8000-000000000001';
  let merchantId: string;
  let userId: string;
  let containerId: string;

  async function login(zalo_id: string, loginPhone: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/zalo').send({ zalo_id, phone: loginPhone }).expect(201);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (merchantId) await prisma.collectionOrder.deleteMany({ where: { merchantId } }).catch(() => undefined);
    if (containerId) await prisma.container.delete({ where: { id: containerId } }).catch(() => undefined);
    if (merchantId) await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => undefined);
    if (userId) {
      await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { actorUserId: userId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await app.close();
  });

  it('đăng ký tạo merchant PENDING', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/merchants/register').send({
      zalo_id: zaloId, name: 'Quán thử onboarding', address: '1 Nguyễn Huệ, TP.HCM', phone,
      business_type: 'Quán ăn', lat: 10.7818, lng: 106.6851, ward_id: wardId,
    }).expect(201);
    merchantId = response.body.merchant.id as string;
    userId = response.body.merchant.user_id as string;
    expect(response.body.status).toBe('PENDING');
    expect(response.body.merchant.approval_status).toBe('PENDING');
  });

  it('merchant PENDING bị chặn tạo đơn bằng 403', async () => {
    const loginResponse = await login(zaloId, phone);
    const response = await request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${loginResponse.body.access_token}`).send({}).expect(403);
    expect(response.body.code).toBe('MERCHANT_NOT_APPROVED');
  });

  it('sau khi admin approve thì merchant tạo đơn thành công', async () => {
    const container = await prisma.container.create({ data: { merchantId, qrCode: `ONBOARD-${randomUUID().slice(0, 8)}`, capacityLiters: 30, state: 'AT_MERCHANT', status: 'ACTIVE' } });
    containerId = container.id;
    await prisma.$executeRaw`UPDATE "merchants" SET "location" = ST_SetSRID(ST_MakePoint(106.6851, 10.7818), 4326)::geography WHERE "id" = ${merchantId}::uuid`;
    const admin = await login('zalo_admin_01', '0990000001');
    await request(app.getHttpServer()).post(`/api/v1/admin/merchants/${merchantId}/approve`).set('Authorization', `Bearer ${admin.body.access_token}`).expect(201);
    const merchant = await login(zaloId, phone);
    const order = await request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${merchant.body.access_token}`).send({ container_id: containerId, expected_liters: 12 }).expect(201);
    expect(order.body.status).toBe('READY');
  });

  it('đăng ký trùng zalo_id trả MERCHANT_ALREADY_REGISTERED', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/merchants/register').send({
      zalo_id: zaloId, name: 'Trùng hồ sơ', address: '2 Lê Lợi, TP.HCM', phone: '0970000000',
      business_type: 'Quán ăn', lat: 10.7818, lng: 106.6851, ward_id: wardId,
    }).expect(409);
    expect(response.body.code).toBe('MERCHANT_ALREADY_REGISTERED');
  });
});
