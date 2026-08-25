import request from 'supertest';
import { createZaloLocationRelayServer } from './zalo-location-relay';

describe('Zalo location demo relay', () => {
  const config = {
    appSecret: 'backend-secret-test',
    relayToken: 'relay-token-that-is-at-least-32-characters',
  };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
  });

  it('rejects unauthenticated requests without forwarding tokens', async () => {
    const server = createZaloLocationRelayServer(config, fetchMock as typeof fetch);

    await request(server)
      .post('/zalo/location')
      .send({ access_token: 'access-token-test', location_token: 'location-token-test' })
      .expect(401, { error: 'UNAUTHORIZED' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges tokens from an authenticated request and normalizes coordinates', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 0, data: { latitude: '21.0333', longitude: '105.85', timestamp: 'ignored' } }),
    });
    const server = createZaloLocationRelayServer(config, fetchMock as typeof fetch);

    const response = await request(server)
      .post('/zalo/location')
      .set('authorization', `Bearer ${config.relayToken}`)
      .send({ access_token: 'access-token-test', location_token: 'location-token-test' })
      .expect(200);

    expect(response.body).toEqual({ error: 0, data: { latitude: 21.0333, longitude: 105.85 } });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.zalo.me/v2.0/me/info',
      expect.objectContaining({
        method: 'GET',
        headers: {
          access_token: 'access-token-test',
          code: 'location-token-test',
          secret_key: config.appSecret,
        },
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain('access-token-test');
    expect(JSON.stringify(response.body)).not.toContain('location-token-test');
    expect(JSON.stringify(response.body)).not.toContain(config.appSecret);
  });

  it('returns only safe provider diagnostics for a rejected token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 202, message: 'invalid token', internal: 'ignored' }),
    });
    const server = createZaloLocationRelayServer(config, fetchMock as typeof fetch);

    await request(server)
      .post('/zalo/location')
      .set('authorization', `Bearer ${config.relayToken}`)
      .send({ access_token: 'access-token-test', location_token: 'location-token-test' })
      .expect(200, { error: 202, message: 'invalid token' });
  });
});
