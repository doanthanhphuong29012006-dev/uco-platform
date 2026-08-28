import request from 'supertest';
import {
  createZaloProfileRelayServer,
  ZALO_PROFILE_RELAY_PATH,
  ZALO_PROFILE_RELAY_SECRET_HEADER,
  ZALO_PROFILE_URL,
} from './zalo-profile-relay';

describe('Zalo profile relay', () => {
  const relaySecret = 'relay-secret-that-is-at-least-32-characters-long';
  const accessToken = 'zalo-access-token-that-must-never-be-logged';

  it('keeps the health check public', async () => {
    const server = createZaloProfileRelayServer({ relaySecret }, jest.fn() as typeof fetch);

    await request(server).get('/health').expect(200, { status: 'ok' });
  });

  it('rejects missing and invalid relay secrets without forwarding the access token', async () => {
    const fetchMock = jest.fn();
    const server = createZaloProfileRelayServer({ relaySecret }, fetchMock as typeof fetch);

    await request(server).post(ZALO_PROFILE_RELAY_PATH).send({ access_token: accessToken }).expect(401, { error: 'UNAUTHORIZED' });
    await request(server).post(ZALO_PROFILE_RELAY_PATH).set(ZALO_PROFILE_RELAY_SECRET_HEADER, 'wrong-secret').send({ access_token: accessToken }).expect(403, { error: 'FORBIDDEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls only the fixed Zalo profile endpoint and logs safe diagnostics', async () => {
    const logs: unknown[] = [];
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      error: -501,
      message: `IP restriction ${accessToken} ${relaySecret}`,
      secret_value: relaySecret,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const server = createZaloProfileRelayServer({ relaySecret }, fetchMock as typeof fetch, (entry) => logs.push(entry));

    const response = await request(server)
      .post(ZALO_PROFILE_RELAY_PATH)
      .set(ZALO_PROFILE_RELAY_SECRET_HEADER, relaySecret)
      .send({ access_token: accessToken, upstream_url: 'https://attacker.example/' })
      .expect(200);

    expect(response.body).toEqual({ error: -501, message: expect.stringContaining('IP restriction') });
    expect(fetchMock).toHaveBeenCalledWith(ZALO_PROFILE_URL, expect.objectContaining({
      method: 'GET',
      headers: { access_token: accessToken },
    }));
    expect(JSON.stringify(response.body)).not.toContain(relaySecret);
    expect(JSON.stringify(logs)).not.toContain(accessToken);
    expect(JSON.stringify(logs)).not.toContain(relaySecret);
    expect(logs).toEqual([expect.objectContaining({
      event: 'zalo_profile_upstream_error',
      status: 200,
      content_type: 'application/json',
      response_keys: ['error', 'message', 'secret_value'],
      provider_error: -501,
    })]);
  });

  it('rejects non-JSON and oversized request bodies before calling Zalo', async () => {
    const fetchMock = jest.fn();
    const server = createZaloProfileRelayServer({ relaySecret }, fetchMock as typeof fetch);

    await request(server)
      .post(ZALO_PROFILE_RELAY_PATH)
      .set(ZALO_PROFILE_RELAY_SECRET_HEADER, relaySecret)
      .set('content-type', 'text/plain')
      .send(JSON.stringify({ access_token: accessToken }))
      .expect(415, { error: 'UNSUPPORTED_CONTENT_TYPE' });
    await request(server)
      .post(ZALO_PROFILE_RELAY_PATH)
      .set(ZALO_PROFILE_RELAY_SECRET_HEADER, relaySecret)
      .send({ access_token: 'x'.repeat(9_000) })
      .expect(413, { error: 'BODY_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
