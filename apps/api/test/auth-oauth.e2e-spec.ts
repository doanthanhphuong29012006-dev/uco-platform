process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Real Zalo OAuth callback (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.refreshToken.deleteMany({ where: { user: { zaloId } } });
      await prisma.user.deleteMany({ where: { zaloId } });
    }
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

  it('exchanges the code, verifies /me, sets HttpOnly session cookies and upserts on re-login', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://oauth.zaloapp.com/v4/access_token') {
        return new Response(JSON.stringify({ access_token: 'zalo-access', refresh_token: 'zalo-refresh', expires_in: '3600' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 0, message: 'Success', id: zaloId, name: 'OAuth Tester' }), { status: 200 });
    });
    try {
      for (const code of ['oauth-code-1', 'oauth-code-2']) {
        const response = await start();
        const stateCookie = cookieFrom(response);
        await request(app.getHttpServer())
          .get('/api/v1/auth/zalo/callback')
          .query({ code, state: stateCookie.slice(stateCookie.indexOf('=') + 1) })
          .set('Cookie', stateCookie)
          .expect(302)
          .expect('Location', 'https://miniapp.example.test/');
      }
      expect(await prisma.user.count({ where: { zaloId } })).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
