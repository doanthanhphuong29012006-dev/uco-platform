process.env.NODE_ENV = 'test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setApiGlobalPrefix } from '../src/main';
import { ZALO_VERIFIER_PATH } from '../src/verification/zalo-verification.constants';

describe('Zalo domain verification (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    setApiGlobalPrefix(app);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the verifier at the root without authentication or API prefix', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${ZALO_VERIFIER_PATH}`)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/^text\/html;\s*charset=utf-8$/);
    expect(response.text).toBe('<!DOCTYPE html>\n<html lang="en">\n\n<head>\n    <meta property="zalo-platform-site-verification" content="Ujw03lZo6XOpXymhruLl4nVounNxX3bDE30n" />\n</head>\n\n<body>\nThere Is No Limit To What You Can Accomplish Using Zalo!\n</body>\n\n</html>');
    await request(app.getHttpServer()).get(`/api/v1/${ZALO_VERIFIER_PATH}`).expect(404);
  });

  it('serves the public health check under the API prefix', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(response.body).toMatchObject({ status: 'ok', service: 'eco-oil-api', db: 'ok' });
    expect(['ok', 'disabled']).toContain(response.body.redis);
    await request(app.getHttpServer()).get('/health').expect(404);
  });
});
