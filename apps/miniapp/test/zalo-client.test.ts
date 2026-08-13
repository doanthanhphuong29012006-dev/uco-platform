import assert from 'node:assert/strict';
import test from 'node:test';

function setBrowserGeolocation(getCurrentPosition: (...args: unknown[]) => void): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { geolocation: { getCurrentPosition } },
  });
}

test('mock getLocation returns the real browser geolocation', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  setBrowserGeolocation((success) => success({ coords: { latitude: 21.0333, longitude: 105.85 } }));
  const { createZaloClient, isZaloEnvironment } = await import('../src/lib/zalo-client');
  assert.equal(isZaloEnvironment(), false);

  const client = createZaloClient(false);
  assert.equal(client.mode, 'mock');
  assert.deepEqual(await client.getLocation({ lat: 10, lng: 106 }), { lat: 21.0333, lng: 105.85 });
});

test('mock getLocation falls back to the supplied ward center without a hardcoded Saigon coordinate', async () => {
  setBrowserGeolocation((_success, failure) => failure(new Error('permission denied')));
  const { createZaloClient } = await import('../src/lib/zalo-client');
  const client = createZaloClient(false);
  const fallback = { lat: 21.0333, lng: 105.85 };
  assert.deepEqual(await client.getLocation(fallback), fallback);
  assert.notDeepEqual(await client.getLocation(fallback), { lat: 10.7769, lng: 106.7009 });
});

test('browser outside Zalo uses the mock client for the full SDK surface', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  setBrowserGeolocation((_success, failure) => failure(new Error('unsupported')));
  const { createZaloClient } = await import('../src/lib/zalo-client');
  const client = createZaloClient(false);

  client.setSeedAccount({ zaloId: 'zalo_collector_01', phone: '0910000001' });
  assert.deepEqual(await client.login(), { zaloId: 'zalo_collector_01', phone: '0910000001' });
  assert.equal(await client.getAccessToken(), 'mock-access-token:zalo_collector_01');
  assert.equal(await client.getLocation(), null);
  assert.equal(await client.scanQRCode(), '');
  await assert.rejects(() => client.chooseImage(), /Camera is unavailable in mock mode/);

  client.setStorage('zalo-client-test', 'mock-value');
  assert.equal(client.getStorage('zalo-client-test'), 'mock-value');
  client.removeStorage('zalo-client-test');
  assert.equal(client.getStorage('zalo-client-test'), null);
});
