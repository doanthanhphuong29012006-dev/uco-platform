import { INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Container provisioning and merchant empty state (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const wardId = '10000000-0000-4000-8000-000000000001';
  const zaloId = `zalo_container_${randomUUID().slice(0, 8)}`;
  const phone = `098${Date.now().toString().slice(-7)}`;
  let merchantId: string;
  let userId: string;
  let containerId: string;
  let orderId: string;

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
    const registered = await request(app.getHttpServer()).post('/api/v1/merchants/register').send({ zalo_id: zaloId, name: 'Quán test cấp can', address: '1 Nguyễn Huệ', phone, business_type: 'QUAN_AN', lat: 10.7769, lng: 106.7009, ward_id: wardId }).expect(201);
    merchantId = registered.body.merchant.id as string;
    userId = registered.body.merchant.user_id as string;
    const admin = await login('zalo_admin_01', '0990000001');
    await request(app.getHttpServer()).post(`/api/v1/admin/merchants/${merchantId}/approve`).set('Authorization', `Bearer ${admin.body.access_token}`).expect(201);
  });

  afterAll(async () => {
    if (orderId) await prisma.collectionOrder.delete({ where: { id: orderId } }).catch(() => undefined);
    if (containerId) await prisma.container.delete({ where: { id: containerId } }).catch(() => undefined);
    if (merchantId) await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => undefined);
    if (userId) {
      await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { actorUserId: userId } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('merchant đã duyệt nhưng chưa có can trả NO_CONTAINER_ASSIGNED', async () => {
    const merchant = await login(zaloId, phone);
    const response = await request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${merchant.body.access_token}`).send({}).expect(422);
    expect(response.body.code).toBe('NO_CONTAINER_ASSIGNED');
  });

  it('admin tạo và gán can, merchant tạo đơn thành công', async () => {
    const admin = await login('zalo_admin_01', '0990000001');
    const created = await request(app.getHttpServer()).post('/api/v1/admin/containers').set('Authorization', `Bearer ${admin.body.access_token}`).send({ ward_code: 'Q3-P7', capacity_liters: 30 }).expect(201);
    containerId = created.body.id as string;
    expect(created.body.qr_code).toMatch(/^ECO-UCO-Q3P7-\d{4}$/);
    expect(created.body.merchant).toBeNull();
    await request(app.getHttpServer()).post(`/api/v1/admin/containers/${containerId}/assign`).set('Authorization', `Bearer ${admin.body.access_token}`).send({ merchant_id: merchantId }).expect(201);
    const merchant = await login(zaloId, phone);
    const order = await request(app.getHttpServer()).post('/api/v1/orders/ready').set('Authorization', `Bearer ${merchant.body.access_token}`).send({ container_id: containerId, expected_liters: 10 }).expect(201);
    orderId = order.body.id as string;
    expect(order.body.status).toBe('READY');
  });

  it('không cho gán can đang thuộc quán khác', async () => {
    const other = await prisma.merchant.findFirst({ where: { user: { zaloId: 'zalo_merchant_02' } } });
    expect(other).not.toBeNull();
    const admin = await login('zalo_admin_01', '0990000001');
    const response = await request(app.getHttpServer()).post(`/api/v1/admin/containers/${containerId}/assign`).set('Authorization', `Bearer ${admin.body.access_token}`).send({ merchant_id: other?.id }).expect(409);
    expect(response.body.code).toBe('CONTAINER_ALREADY_ASSIGNED');
  });
});
