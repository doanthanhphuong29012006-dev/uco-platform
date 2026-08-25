import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZaloLocationProvider } from './zalo-location.provider';

describe('ZaloLocationProvider', () => {
  const input = { access_token: 'access-token-test', location_token: 'location-token-test' };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('exchanges a location token and returns valid coordinates', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 0, data: { latitude: '21.0333', longitude: '105.85' } }),
    });
    const provider = new ZaloLocationProvider(new ConfigService({ ZALO_APP_SECRET: 'backend-secret-test' }));

    await expect(provider.resolve(input)).resolves.toEqual({ lat: 21.0333, lng: 105.85 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.zalo.me/v2.0/me/info',
      expect.objectContaining({
        method: 'GET',
        headers: {
          access_token: input.access_token,
          code: input.location_token,
          secret_key: 'backend-secret-test',
        },
      }),
    );
  });

  it('rejects when the backend secret is missing', async () => {
    const provider = new ZaloLocationProvider(new ConfigService({}));

    await expect(provider.resolve(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZALO_APP_SECRET_NOT_CONFIGURED' }),
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an expired or invalid Zalo token to a stable unauthorized error', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 202, message: 'invalid location token' }),
    });
    const provider = new ZaloLocationProvider(new ConfigService({ ZALO_APP_SECRET: 'backend-secret-test' }));

    await expect(provider.resolve(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZALO_LOCATION_TOKEN_INVALID' }),
      status: 401,
    });
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'zalo_location_exchange_rejected',
      status: 401,
      provider_error: 202,
      provider_message: 'invalid location token',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(input.access_token);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(input.location_token);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('backend-secret-test');
    warnSpy.mockRestore();
  });

  it('maps network failures to a bounded provider error', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));
    const provider = new ZaloLocationProvider(new ConfigService({ ZALO_APP_SECRET: 'backend-secret-test' }));

    await expect(provider.resolve(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZALO_LOCATION_PROVIDER_UNAVAILABLE' }),
      status: 502,
    });
  });

  it('aborts a provider request after the configured timeout', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url: string, options: RequestInit) => new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const provider = new ZaloLocationProvider(new ConfigService({ ZALO_APP_SECRET: 'backend-secret-test' }));
    const result = provider.resolve(input);
    const assertion = expect(result).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZALO_LOCATION_PROVIDER_UNAVAILABLE' }),
      status: 502,
    });

    await jest.advanceTimersByTimeAsync(5_000);
    await assertion;
    jest.useRealTimers();
  });

  it('rejects malformed or out-of-range coordinates', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 0, data: { latitude: '91', longitude: '105.85' } }),
    });
    const provider = new ZaloLocationProvider(new ConfigService({ ZALO_APP_SECRET: 'backend-secret-test' }));

    await expect(provider.resolve(input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_ZALO_LOCATION_RESPONSE' }),
      status: 502,
    });
  });
});
