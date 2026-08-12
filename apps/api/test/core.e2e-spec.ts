process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const wardId = '10000000-0000-4000-8000-000000000001';
const testStationUserId = randomUUID();
const testStationZaloId = `zalo_station_test_${testStationUserId.slice(0, 8)}`;
const testStationPhone = `092${Date.now().toString().slice(-7)}`;
const seededContainerQr = 'ECO-UCO-Q3-P7-001';

describe('Core CRUD and PostGIS (e2e)', () => {
  let app: INestApplication;

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

    const prisma = app.get(PrismaService);
    await prisma.container.update({
      where: { id: '60000000-0000-4000-8000-000000000001' },
      data: { state: 'AT_MERCHANT', lastSeenAt: null },
    });
    await prisma.user.upsert({
      where: { id: testStationUserId },
      update: { role: Role.STATION, zaloId: testStationZaloId, phone: testStationPhone, name: 'Station Test' },
      create: { id: testStationUserId, role: Role.STATION, zaloId: testStationZaloId, phone: testStationPhone, name: 'Station Test' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows ADMIN to create a station and blocks MERCHANT', async () => {
    const adminToken = await login('zalo_admin_01', '0990000001');
    const created = await request(app.getHttpServer())
      .post('/api/v1/stations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        user_id: testStationUserId,
        name: 'Trạm Test CRUD',
        address: '1 Đường Test, Phường 7, Quận 3',
        lat: 10.7821,
        lng: 106.6852,
        ward_id: wardId,
      })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Trạm Test CRUD', lat: 10.7821, lng: 106.6852, status: 'ACTIVE' });

    const merchantToken = await login('zalo_merchant_01', '0900000001');
    const forbidden = await request(app.getHttpServer())
      .post('/api/v1/stations')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({
        user_id: testStationUserId,
        name: 'Should Fail',
        address: '1 Đường Test',
        lat: 10.7821,
        lng: 106.6852,
        ward_id: wardId,
      })
      .expect(403);
    expect(forbidden.body).toEqual({ code: 'FORBIDDEN', message: 'Insufficient role', details: null });
  });

  it('decodes seeded container QR data for a collector and returns 404 for an unknown code', async () => {
    const collectorToken = await login('zalo_collector_01', '0910000001');
    const found = await request(app.getHttpServer())
      .get(`/api/v1/containers/by-qr/${seededContainerQr}`)
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(200);
    expect(found.body).toMatchObject({ qr_code: seededContainerQr, state: 'AT_MERCHANT', merchant: { id: expect.any(String) } });

    const missing = await request(app.getHttpServer())
      .get('/api/v1/containers/by-qr/ECO-UCO-Q3-P7-MISSING')
      .set('Authorization', `Bearer ${collectorToken}`)
      .expect(404);
    expect(missing.body).toEqual({ code: 'NOT_FOUND', message: 'Container not found', details: null });
  });

  it('returns decoded numeric coordinates from merchant list', async () => {
    const adminToken = await login('zalo_admin_01', '0990000001');
    const response = await request(app.getHttpServer())
      .get('/api/v1/merchants?page=1&limit=20')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const merchant = response.body.data.find((item: { name: string }) => item.name === 'Quán Cơm Nhà Mình');
    expect(response.body.meta).toMatchObject({ page: 1, limit: 20, total: 5 });
    expect(merchant.lat).toBeCloseTo(10.78255, 5);
    expect(merchant.lng).toBeCloseTo(106.68475, 5);
    expect(typeof merchant.lat).toBe('number');
    expect(typeof merchant.lng).toBe('number');
  });
});
