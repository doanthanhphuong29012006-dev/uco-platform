import assert from 'node:assert/strict';
import test from 'node:test';
import { useAuthStore } from '../src/stores/auth-store';
import { tokenStorage } from '../src/lib/storage';
import { fetchWithTimeout } from '../src/lib/api';

test('API requests time out instead of leaving authentication hydration pending forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise<Response>(() => undefined);
  try {
    await assert.rejects(
      fetchWithTimeout('https://api.example.test/auth/me', {}, 10),
      (error: unknown) => {
        const candidate = error as { code?: string; status?: number };
        return candidate.code === 'REQUEST_TIMEOUT' && candidate.status === 0;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test('authenticated collector invite acceptance exchanges the session and routes by the refreshed role', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/collector-invites/accept')) {
      assert.equal(JSON.parse(String(init?.body)).code, 'collector-invite-fixture');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer existing-access-fixture');
      return new Response(JSON.stringify({
        access_token: 'collector-access-fixture',
        refresh_token: 'collector-refresh-fixture',
        user: { id: 'user-collector', zalo_id: 'zalo-collector', phone: '0900000000', name: 'Collector', role: 'COLLECTOR', merchantId: null, collectorId: 'collector-1', merchantApprovalStatus: null, merchantRejectionReason: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/auth/me')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer collector-access-fixture');
      return new Response(JSON.stringify({ id: 'user-collector', zalo_id: 'zalo-collector', phone: '0900000000', name: 'Collector', role: 'COLLECTOR', merchantId: null, collectorId: 'collector-1', merchantApprovalStatus: null, merchantRejectionReason: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected auth URL: ${url}`);
  };

  tokenStorage.setTokens('existing-access-fixture', 'existing-refresh-fixture');
  useAuthStore.setState({ user: { id: 'user-collector', zalo_id: 'zalo-collector', phone: '0900000000', name: 'Collector', role: 'MERCHANT', merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null }, hydrated: true, busy: false, error: null });
  try {
    await useAuthStore.getState().acceptCollectorInvite('collector-invite-fixture');
    assert.equal(useAuthStore.getState().user?.role, 'COLLECTOR');
    assert.equal(useAuthStore.getState().user?.collectorId, 'collector-1');
    assert.equal(tokenStorage.getAccessToken(), 'collector-access-fixture');
  } finally {
    tokenStorage.clear();
    useAuthStore.setState({ user: null, hydrated: false, busy: false, error: null });
    globalThis.fetch = originalFetch;
  }
});
