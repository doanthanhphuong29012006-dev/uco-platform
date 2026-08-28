process.env.NODE_ENV = 'test';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { ZALO_OAUTH_HANDOFF_TTL_SECONDS } from '../src/modules/auth/auth.constants';

describe('Real Zalo OAuth callback (e2e)', () => {
  let app: INestApplication;
  const users = new Map<string, Record<string, unknown>>();
  const refreshTokens: Record<string, unknown>[] = [];
  const handoffTtls = new Map<string, number>();
  const fakePrisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; zaloId?: string } }) => {
        if (where.id) return [...users.values()].find((user) => user.id === where.id) ?? null;
        if (where.zaloId) return users.get(where.zaloId) ?? null;
        return null;
      }),
      upsert: jest.fn(async ({ where, create, update }: { where: { zaloId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const current = users.get(where.zaloId);
        const user = { ...(current ?? create), ...(current ? update : {}), id: current?.id ?? `user-${where.zaloId}` };
        const result = {
          ...user,
          merchant: { id: 'merchant-oauth-test', approvalStatus: 'APPROVED', rejectionReason: null },
          collector: null,
          station: null,
        };
        users.set(where.zaloId, result);
        return result;
      }),
    },
    $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      refreshToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          refreshTokens.push(data);
          return data;
        }),
      },
    })),
  };
  const handoffs = new Map<string, string>();
  const redis = {
    setOneTime: jest.fn(async (key: string, value: string, ttlSeconds: number) => {
      handoffs.set(key, value);
      handoffTtls.set(key, ttlSeconds);
    }),
    consumeOneTime: jest.fn(async (key: string) => {
      const value = handoffs.get(key) ?? null;
      handoffs.delete(key);
      return value;
    }),
  };
  const zaloId = `oauth-test-${Date.now()}`;

  beforeAll(async () => {
    const config = new ConfigService({
      ...process.env,
      ZALO_AUTH_MODE: 'real',
      ZALO_APP_ID: '123456789',
      ZALO_APP_SECRET: 'test-server-secret',
      ZALO_OAUTH_CALLBACK_URL: 'https://api.example.test/api/v1/auth/zalo/callback',
      ZALO_OAUTH_SUCCESS_REDIRECT_URL: 'https://miniapp.example.test/',
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function start() {
    return request(app.getHttpServer()).get('/api/v1/auth/zalo/start').expect(302);
  }

  function cookieFrom(response: request.Response): string {
    return response.headers['set-cookie'][0].split(';', 1)[0];
  }

  it('creates the documented permission URL with state and PKCE challenge', async () => {
    const response = await start();
    const location = new URL(response.headers.location);
    expect(location.origin + location.pathname).toBe('https://oauth.zaloapp.com/v4/permission');
    expect(location.searchParams.get('app_id')).toBe('123456789');
    expect(location.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/v1/auth/zalo/callback');
    expect(location.searchParams.get('state')).toBe(cookieFrom(response).split('=')[1]);
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a callback with the wrong CSRF state', async () => {
    const response = await start();
    await request(app.getHttpServer())
      .get('/api/v1/auth/zalo/callback?code=oauth-code&state=wrong-state')
      .set('Cookie', cookieFrom(response))
      .expect(401)
      .expect((result) => expect(result.body.code).toBe('INVALID_ZALO_OAUTH_STATE'));
  });

  it('handles a user denying authorization without exchanging a token', async () => {
    const response = await start();
    await request(app.getHttpServer())
      .get('/api/v1/auth/zalo/callback')
      .query({ state: cookieFrom(response).split('=')[1], error: 'access_denied', error_description: 'User denied access' })
      .set('Cookie', cookieFrom(response))
      .expect(401)
      .expect((result) => expect(result.body.code).toBe('ZALO_AUTHORIZATION_DENIED'));
  });

  it('exchanges the code, verifies /me, and hands the session to the frontend once', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://oauth.zaloapp.com/v4/access_token') {
        return new Response(JSON.stringify({ access_token: 'zalo-access', refresh_token: 'zalo-refresh', expires_in: '3600' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 0, message: 'Success', id: zaloId, name: 'OAuth Tester' }), { status: 200 });
    });
    try {
      const handoffCodes: string[] = [];
      for (const code of ['oauth-code-1', 'oauth-code-2']) {
        const response = await start();
        const stateCookie = cookieFrom(response);
        await request(app.getHttpServer())
          .get('/api/v1/auth/zalo/callback')
          .query({ code, state: stateCookie.slice(stateCookie.indexOf('=') + 1) })
          .set('Cookie', stateCookie)
          .expect(302)
          .expect((result) => {
            const location = new URL(result.headers.location);
            expect(location.origin + location.pathname).toBe('https://miniapp.example.test/');
            expect(location.searchParams.get('access_token')).toBeNull();
            expect(location.searchParams.get('refresh_token')).toBeNull();
            expect(location.searchParams.get('zalo_code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
            handoffCodes.push(location.searchParams.get('zalo_code')!);
            expect(String(result.headers['set-cookie'])).not.toContain('zalo-access');
            expect(String(result.headers['set-cookie'])).not.toContain('zalo-refresh');
          });
      }
      expect(redis.setOneTime).toHaveBeenCalledTimes(2);
      for (const [key, userId, ttl] of redis.setOneTime.mock.calls) {
        expect(key).toMatch(/^auth:zalo:oauth-handoff:[a-f0-9]{64}$/);
        expect(userId).toBe('user-' + zaloId);
        expect(ttl).toBe(ZALO_OAUTH_HANDOFF_TTL_SECONDS);
        expect(handoffTtls.get(key)).toBe(ttl);
      }
      for (const handoffCode of handoffCodes) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/zalo/exchange')
          .send({ code: handoffCode })
          .expect(201)
          .expect((result) => {
            expect(result.body.access_token).toEqual(expect.any(String));
            expect(result.body.refresh_token).toEqual(expect.any(String));
          });
      }
      await request(app.getHttpServer())
        .post('/api/v1/auth/zalo/exchange')
        .send({ code: handoffCodes[0] })
        .expect(401)
        .expect((result) => expect(result.body.code).toBe('ZALO_OAUTH_HANDOFF_INVALID'));
      await request(app.getHttpServer())
        .post('/api/v1/auth/zalo/exchange')
        .send({ code: 'expired-or-unknown-one-time-code' })
        .expect(401)
        .expect((result) => expect(result.body.code).toBe('ZALO_OAUTH_HANDOFF_INVALID'));
      expect(users.size).toBe(1);
      expect(refreshTokens).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
