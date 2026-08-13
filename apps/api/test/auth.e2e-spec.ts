process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth and RBAC (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in with mock Zalo and returns the current user', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: 'zalo_merchant_01', phone: '0900000001' })
      .expect(201);

    expect(login.body.user).toMatchObject({
      zalo_id: 'zalo_merchant_01',
      role: 'MERCHANT',
      merchantId: expect.any(String),
    });
    expect(login.body.access_token).toEqual(expect.any(String));
    expect(login.body.refresh_token).toEqual(expect.any(String));

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(200);

    expect(me.body).toMatchObject({
      zalo_id: 'zalo_merchant_01',
      role: 'MERCHANT',
      merchantId: expect.any(String),
    });
  });

  it('returns 403 in the standard error format for a disallowed role', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: 'zalo_merchant_01', phone: '0900000001' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/admin-check')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(403);

    expect(response.body).toEqual({
      code: 'FORBIDDEN',
      message: 'Insufficient role',
      details: null,
    });
  });

  it('returns real database-backed mock accounts with collector wards', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/dev-accounts')
      .expect(200);

    const collector = response.body.find((account: { zalo_id: string }) => account.zalo_id === 'zalo_collector_01');
    expect(collector).toMatchObject({ role: 'COLLECTOR' });
    expect(collector.wards.length).toBeGreaterThan(0);
    expect(response.body.every((account: { zalo_id: string }) => !account.zalo_id.includes(':'))).toBe(true);
  });

  it('rejects a mock access token passed as a Zalo id', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: 'mock-access-token:zalo_merchant_01', phone: '0900000001' })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'INVALID_ZALO_ID' });
  });

  it('rotates refresh tokens and rejects reuse of the old token', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/zalo')
      .send({ zalo_id: 'zalo_merchant_01', phone: '0900000001' })
      .expect(201);

    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token })
      .expect(201);

    expect(rotated.body.refresh_token).not.toBe(login.body.refresh_token);

    const reuse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token })
      .expect(401);

    expect(reuse.body).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired refresh token',
      details: null,
    });
  });
});
