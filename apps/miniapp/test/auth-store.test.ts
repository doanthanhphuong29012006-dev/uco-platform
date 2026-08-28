import assert from 'node:assert/strict';
import test from 'node:test';
import { useAuthStore } from '../src/stores/auth-store';
import { tokenStorage } from '../src/lib/storage';

test('OAuth exchange then /me bootstraps the authenticated store without a third-party cookie', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const replaced: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href: 'https://uco-platform-miniapp.vercel.app/?zalo_code=one-time-code' },
      history: { replaceState: (_state: unknown, _title: string, next: string) => replaced.push(next) },
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/zalo/exchange')) {
      assert.equal(JSON.parse(String(init?.body)).code, 'one-time-code');
      return new Response(JSON.stringify({
        access_token: 'access-token-fixture',
        refresh_token: 'refresh-token-fixture',
        user: { id: 'user-1', zalo_id: 'zalo-new', phone: null, name: 'New user', role: 'MERCHANT', merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/auth/me')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access-token-fixture');
      return new Response(JSON.stringify({ id: 'user-1', zalo_id: 'zalo-new', phone: null, name: 'New user', role: 'MERCHANT', merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected auth URL: ${url}`);
  };

  try {
    await useAuthStore.getState().hydrate();
    assert.equal(useAuthStore.getState().user?.id, 'user-1');
    assert.equal(useAuthStore.getState().user?.merchantId, null);
    assert.equal(useAuthStore.getState().hydrated, true);
    assert.deepEqual(replaced, ['/']);
    assert.equal(tokenStorage.getAccessToken(), 'access-token-fixture');
  } finally {
    tokenStorage.clear();
    useAuthStore.setState({ user: null, hydrated: false, busy: false, error: null });
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});
