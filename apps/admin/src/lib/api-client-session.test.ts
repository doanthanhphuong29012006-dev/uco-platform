import { ApiError, createApiClient } from '@eco-oil/api-client';
import { afterEach, expect, test, vi } from 'vitest';

const storage = () => {
  let access = 'access-old';
  let refresh = 'refresh-old';
  return {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    setTokens: (nextAccess: string, nextRefresh: string) => { access = nextAccess; refresh = nextRefresh; },
    clear: vi.fn(() => { access = ''; refresh = ''; }),
    values: () => ({ access, refresh }),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('giữ phiên khi Admin me gặp lỗi mạng hoặc 5xx', async () => {
  const tokenStorage = storage();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')));
  await expect(createApiClient({ baseUrl: '/api/v1', storage: tokenStorage }).request('/auth/me')).rejects.toThrow('offline');
  expect(tokenStorage.values()).toEqual({ access: 'access-old', refresh: 'refresh-old' });

  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: 'down' }), { status: 503 })));
  await expect(createApiClient({ baseUrl: '/api/v1', storage: tokenStorage }).request('/auth/me')).rejects.toBeInstanceOf(ApiError);
  expect(tokenStorage.values()).toEqual({ access: 'access-old', refresh: 'refresh-old' });
});

test('refresh thành công thì thử lại me và thay token', async () => {
  const tokenStorage = storage();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'expired' }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'admin-1', role: 'ADMIN' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await expect(createApiClient({ baseUrl: '/api/v1', storage: tokenStorage }).request('/auth/me')).resolves.toEqual({ id: 'admin-1', role: 'ADMIN' });
  expect(tokenStorage.values()).toEqual({ access: 'access-new', refresh: 'refresh-new' });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('refresh gặp 5xx giữ phiên thay vì xóa token', async () => {
  const tokenStorage = storage();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'expired' }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'refresh unavailable' }), { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  await expect(createApiClient({ baseUrl: '/api/v1', storage: tokenStorage }).request('/auth/me')).rejects.toMatchObject({ status: 503 });
  expect(tokenStorage.values()).toEqual({ access: 'access-old', refresh: 'refresh-old' });
  expect(tokenStorage.clear).not.toHaveBeenCalled();
});
