process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

describe('isolated merchant/admin HTTP flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let adminToken: string;
  let adminRefreshToken: string;
  let merchantToken: string;
  let merchantUserId: string;
  let merchantId: string;
  let secondUserId: string;
  let containerId: string;

  beforeAll(async () => {
    if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD must be supplied as a test-only environment variable');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/login')
      .send({ zalo_id: 'zalo_admin_01', phone: '0990000001', password: process.env.ADMIN_PASSWORD })
      .expect(201);
    adminToken = adminLogin.body.access_token as string;
    adminRefreshToken = adminLogin.body.refresh_token as string;

    const suffix = randomUUID().slice(0, 8);
    const merchantUser = await prisma.user.create({
      data: { zaloId: `merchant_http_${suffix}`, phone: `096${Date.now().toString().slice(-7)}`, name: 'HTTP merchant fixture', role: Role.MERCHANT },
    });
    merchantUserId = merchantUser.id;
    merchantToken = jwt.sign({ sub: merchantUser.id, role: Role.MERCHANT });
    const secondUser = await prisma.user.create({
      data: { zaloId: `merchant_http_other_${suffix}`, phone: `095${Date.now().toString().slice(-7)}`, name: 'HTTP rollback fixture', role: Role.MERCHANT },
    });
    secondUserId = secondUser.id;
  });

  afterAll(async () => {
    if (adminRefreshToken) {
      await request(app.getHttpServer()).post('/api/v1/auth/logout').send({ refresh_token: adminRefreshToken }).catch(() => undefined);
    }
    if (containerId) await prisma.container.deleteMany({ where: { id: containerId } });
    if (merchantId) {
      await prisma.auditLog.deleteMany({ where: { entityId: merchantId } });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
    }
    const userIds = [merchantUserId, secondUserId].filter(Boolean);
    if (userIds.length) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.close();
  });

  it('registers without ward, rejects merchant approval, then approves and assigns/revokes a container', async () => {
    const ward = await prisma.ward.findFirstOrThrow({ where: { deletedAt: null, status: 'ACTIVE', isActive: true }, select: { id: true } });
    const registration = await request(app.getHttpServer())
      .post('/api/v1/merchants/me')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ name: 'Quán HTTP chưa có phường', address: 'Địa chỉ fixture', phone: '0931234567', business_type: 'Restaurant', lat: 10.782, lng: 106.685 })
      .expect(201);
    merchantId = registration.body.id ?? registration.body.merchant?.id;
    expect(merchantId).toEqual(expect.any(String));
    expect(registration.body.approval_status ?? registration.body.merchant?.approval_status).toBe('PENDING');
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { wardId: true } })).wardId).toBeNull();

    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/approve`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ ward_id: ward.id })
      .expect(403);

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ward_id: ward.id })
      .expect(201);
    expect(approved.body.approval_status ?? approved.body.merchant?.approval_status).toBe('APPROVED');
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { wardId: true, approvalStatus: true } }))).toEqual({ wardId: ward.id, approvalStatus: 'APPROVED' });

    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/containers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ward_id: ward.id, capacity_liters: 30 })
      .expect(201);
    containerId = created.body.id;
    expect(containerId).toEqual(expect.any(String));

    const assigned = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ merchant_id: merchantId })
      .expect(201);
    expect(assigned.body.merchant?.id).toBe(merchantId);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/unassign`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(403);
    const unassigned = await request(app.getHttpServer())
      .post(`/api/v1/admin/containers/${containerId}/unassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(unassigned.body.merchant_id ?? null).toBeNull();
  });

  it('rolls back an admin merchant update when the phone conflicts', async () => {
    const before = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { businessName: true, user: { select: { phone: true } } } });
    await request(app.getHttpServer())
      .patch(`/api/v1/merchants/${merchantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Tên không được lưu', phone: (await prisma.user.findUniqueOrThrow({ where: { id: secondUserId }, select: { phone: true } })).phone })
      .expect(409);
    const after = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { businessName: true, user: { select: { phone: true } } } });
    expect(after).toEqual(before);
  });
});
