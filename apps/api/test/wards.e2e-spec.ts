import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(30000);

describe('Ward management and per-ward QR sequences (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let wardId: string;
  let containerId: string;
  const code = `TEST-${randomUUID().slice(0, 6)}`.toUpperCase();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();
    prisma = app.get(PrismaService);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/zalo').send({ zalo_id: 'zalo_admin_01', phone: '0990000001' }).expect(201);
    adminToken = login.body.access_token as string;
  });

  afterAll(async () => {
    if (containerId) await prisma.container.delete({ where: { id: containerId } }).catch(() => undefined);
    if (wardId) await prisma.ward.delete({ where: { id: wardId } }).catch(() => undefined);
    await app.close();
  });

  it('tạo phường mới và sinh mã can theo đúng tiền tố phường', async () => {
    const createdWard = await request(app.getHttpServer()).post('/api/v1/admin/wards').set('Authorization', `Bearer ${adminToken}`).send({ code, name: 'Phường Test', district: 'Quận Test', city: 'Hà Nội', center_lat: 21.0333, center_lng: 105.85 }).expect(201);
    wardId = createdWard.body.id as string;
    expect(createdWard.body.code).toBe(code);
    const createdContainer = await request(app.getHttpServer()).post('/api/v1/admin/containers').set('Authorization', `Bearer ${adminToken}`).send({ ward_id: wardId, capacity_liters: 30 }).expect(201);
    containerId = createdContainer.body.id as string;
    expect(createdContainer.body.qr_code).toBe(`ECO-UCO-${code}-001`);
  });

  it('từ chối mã phường trùng', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/admin/wards').set('Authorization', `Bearer ${adminToken}`).send({ code, name: 'Trùng mã', district: 'Quận Test', city: 'Hà Nội' }).expect(409);
    expect(response.body.code).toBe('WARD_CODE_ALREADY_EXISTS');
  });

  it('không cho tắt phường còn quán đang hoạt động', async () => {
    const response = await request(app.getHttpServer()).patch('/api/v1/admin/wards/10000000-0000-4000-8000-000000000001').set('Authorization', `Bearer ${adminToken}`).send({ status: 'INACTIVE' }).expect(409);
    expect(response.body.code).toBe('WARD_HAS_ACTIVE_MERCHANTS');
  });
});
