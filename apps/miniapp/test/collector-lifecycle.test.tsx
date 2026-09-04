import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Reuse the workspace's existing jsdom test tooling; no browser/device calls.
const { JSDOM } = createRequire(new URL('../../admin/package.json', import.meta.url))('jsdom');

test('opening QR/entry, leaving and logout/login never collect a PREVIEW or ACTIVE order', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network request in isolated lifecycle test'); };
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://miniapp.example.test' });
  for (const key of ['window', 'document', 'navigator', 'localStorage']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(dom.window.navigator, 'onLine', { value: false, configurable: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ root: process.cwd(), configFile: resolve('vite.config.ts'), server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CollectorFlow } = await server.ssrLoadModule('/src/pages/CollectorFlow.tsx');
  const { api } = await server.ssrLoadModule('/src/lib/api.ts');
  const { useAuthStore } = await server.ssrLoadModule('/src/stores/auth-store.ts');
  const db = await server.ssrLoadModule('/src/lib/outbox-db.ts');
  const { startOutboxSyncWorker } = await server.ssrLoadModule('/src/lib/outbox-sync.ts');
  const { zaloClient } = await server.ssrLoadModule('/src/lib/zalo-client.ts');
  const storage = await server.ssrLoadModule('/src/lib/storage.ts');
  const user = { id: 'user-test', zalo_id: 'same-zalo', role: 'COLLECTOR', collectorId: 'collector-test', merchantId: null, merchantApprovalStatus: null, merchantRejectionReason: null, name: 'Collector', phone: null };
  const stop = { seq: 1, order_id: 'order-20l', merchant: { name: 'Quán 20 lít', address: 'Test', phone: '0901234567', lat: 21, lng: 105 }, container_code: 'CAN-TEST', expected_liters: 20, priority: 1, distance_m: 100, route_stop_status: 'PENDING' };
  const container = { id: 'container', qr_code: 'CAN-TEST', capacity_liters: 30, state: 'AT_MERCHANT', merchant: stop.merchant };
  let mutations = 0;
  api.containerByQr = async () => container;
  api.startRoute = async () => { mutations++; throw new Error('Unexpected assignment'); };
  api.syncBatch = async () => { mutations++; return { results: [] }; };
  api.logout = async () => ({ success: true });
  api.loginWithZaloAccessToken = async () => ({ access_token: 'test-only-access', refresh_token: 'test-only-refresh', user });
  zaloClient.getLocation = async () => null;
  const tick = () => act(async () => { await new Promise((done) => setTimeout(done, 30)); });
  const click = async (text: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find((item: HTMLButtonElement) => item.textContent?.trim() === text) as HTMLButtonElement | undefined;
    assert.ok(button, `Missing button: ${text}`);
    await act(async () => button.click());
    await tick();
  };
  let root: ReturnType<typeof createRoot> | null = null;
  let queryClient: InstanceType<typeof QueryClient> | null = null;
  try {
    for (const persisted of [false, true]) {
      storage.pendingStationDeliveryStorage.clear('collector-test');
      api.currentRoute = async () => ({ stops: [stop], total_expected_liters: 20, remaining_capacity_l: 80, route_id: persisted ? 'route-test' : null, route_status: persisted ? 'ACTIVE' : 'PREVIEW', persisted, client_uuid: null, started_at: null });
      await useAuthStore.getState().loginWithZalo('test-zalo-access');
      const mount = async () => {
        queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        root = createRoot(dom.window.document.getElementById('root'));
        await act(async () => root!.render(createElement(QueryClientProvider, { client: queryClient! }, createElement(CollectorFlow))));
        for (let i = 0; i < 8; i++) await tick();
      };
      await mount();
      await click('Thu gom');
      assert.match(dom.window.document.body.textContent, /Quét mã can/);
      await click('Kiểm tra mã can');
      await click('Tiếp tục nhập giao dịch');
      assert.equal((await db.dexieOutboxStore.list()).length, 0);
      await click('Quay lại quét mã');
      await click('Quay lại tuyến');
      assert.match(dom.window.document.body.textContent, /Quán 20 lít/);
      const tel = dom.window.document.querySelector('a[href="tel:+84901234567"]');
      assert.ok(tel, 'direct-click phone fallback remains available');
      assert.equal(tel.getAttribute('onclick'), null);
      await click('Thu gom');
      await act(async () => root!.unmount()); root = null;
      queryClient!.clear();
      await useAuthStore.getState().signOut();
      await useAuthStore.getState().loginWithZalo('test-zalo-access');
      await mount();
      assert.match(dom.window.document.body.textContent, /Quán 20 lít/);
      assert.doesNotMatch(dom.window.document.body.textContent, /Đã hoàn thành tuyến/);
      assert.equal((await db.dexieOutboxStore.list()).length, 0);
      assert.equal(mutations, 0);
      await act(async () => root!.unmount()); root = null;
      queryClient!.clear();
      if (persisted) {
        storage.pendingStationDeliveryStorage.clear('collector-test');
        await db.ecoOilDb.routeCache.clear(); // fake-indexeddb only, never a device database.
        api.currentRoute = async () => { throw new Error('API timeout test'); };
        await mount();
        assert.match(dom.window.document.body.textContent, /Chưa tải được tuyến/);
        assert.doesNotMatch(dom.window.document.body.textContent, /Đã hoàn thành tuyến|0 \/ 0/);
        await act(async () => root!.unmount()); root = null;
        queryClient!.clear();
      }
    }
  } finally {
    if (root) await act(async () => root!.unmount());
    queryClient?.clear();
    startOutboxSyncWorker()();
    db.ecoOilDb.close();
    await server.close();
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
