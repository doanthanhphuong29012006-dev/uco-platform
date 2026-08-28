import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RealZaloAuthProvider } from './real-zalo-auth.provider';

function provider() {
  const config = {
    get: jest.fn((name: string) => ({ ZALO_APP_ID: '123456789', ZALO_APP_SECRET: 'server-only-secret' }[name])),
  } as unknown as ConfigService;
  return new RealZaloAuthProvider(config);
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, '../../../../test/fixtures', name), 'utf8')) as unknown;
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
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(fixture('zalo-profile-with-avatar.json')), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(provider().verify('zalo-access')).resolves.toEqual({ zaloId: '1234567890', phone: null, name: 'Nguyen Van A', avatarUrl: 'https://example.test/zalo-avatar.jpg' });
    expect(fetchMock).toHaveBeenCalledWith('https://graph.zalo.me/v2.0/me?fields=id,name,picture', expect.objectContaining({ headers: { access_token: 'zalo-access' } }));
  });

  it('accepts the documented profile when avatar is not returned', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(fixture('zalo-profile-without-avatar.json')), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(provider().verify('zalo-access')).resolves.toEqual({ zaloId: '9876543210', phone: null, name: 'Tran Thi B' });
  });

  it('normalizes a numeric profile id to a string without coercing it through Number', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 0, id: 1234567890, name: '  User  ', picture: { data: { url: '' } } }), { status: 200 }));

    await expect(provider().verify('zalo-access')).resolves.toEqual({ zaloId: '1234567890', phone: null, name: 'User' });
  });

  it('maps an expired or revoked Zalo access token to an authentication error', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 452, message: 'Session key invalid' }), { status: 401 }));
    await expect(provider().verify('expired-token')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_ZALO_ACCESS_TOKEN' }) });
  });

  it('classifies profile API errors and logs only safe diagnostics', async () => {
    const accessToken = 'profile-access-token-that-must-not-be-logged';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 210, message: 'User not visible', secret: accessToken }), { status: 403, headers: { 'content-type': 'application/json' } }));

    await expect(provider().verify(accessToken)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ZALO_PROFILE_API_ERROR' }) });
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      event: 'zalo_profile_request_failed',
      status: 403,
      content_type: 'application/json',
      top_level_keys: ['error', 'message', 'secret'],
      provider_error: 210,
      provider_message: 'User not visible',
    }));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(accessToken);
  });

  it('classifies a profile response without an id as invalid', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 0, message: 'Success', name: 'No id' }), { status: 200 }));

    await expect(provider().verify('zalo-access')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ZALO_PROFILE_INVALID' }) });
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'zalo_profile_response_invalid', status: 200, top_level_keys: ['error', 'message', 'name'] }));
  });
});
