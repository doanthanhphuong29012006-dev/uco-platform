import type { ConfigService } from '@nestjs/config';
import { RealZaloAuthProvider } from './real-zalo-auth.provider';

function provider() {
  const config = {
    get: jest.fn((name: string) => ({ ZALO_APP_ID: '123456789', ZALO_APP_SECRET: 'server-only-secret' }[name])),
  } as unknown as ConfigService;
  return new RealZaloAuthProvider(config);
}

describe('RealZaloAuthProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exchanges a PKCE authorization code using the documented Zalo v4 contract', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'zalo-access', refresh_token: 'zalo-refresh', expires_in: '3600' }), { status: 200 }));

    await expect(provider().exchangeCode('oauth-code', 'a'.repeat(43))).resolves.toEqual({ accessToken: 'zalo-access', refreshToken: 'zalo-refresh', expiresIn: 3600 });
    expect(fetchMock).toHaveBeenCalledWith('https://oauth.zaloapp.com/v4/access_token', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: 'server-only-secret' },
      body: expect.any(URLSearchParams),
    }));
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('app_id')).toBe('123456789');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('a'.repeat(43));
  });

  it('loads the verified Zalo profile from the documented /me endpoint', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 0, message: 'Success', id: 'zalo-user-1', name: 'Nguyen Van A', picture: { data: { url: 'https://example.test/avatar' } } }), { status: 200 }));

    await expect(provider().verify('zalo-access')).resolves.toEqual({ zaloId: 'zalo-user-1', phone: null, name: 'Nguyen Van A' });
    expect(fetchMock).toHaveBeenCalledWith('https://graph.zalo.me/v2.0/me?fields=id,name,picture', expect.objectContaining({ headers: { access_token: 'zalo-access' } }));
  });

  it('maps an expired or revoked Zalo access token to an authentication error', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 452, message: 'Session key invalid' }), { status: 401 }));
    await expect(provider().verify('expired-token')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_ZALO_ACCESS_TOKEN' }) });
  });
});
