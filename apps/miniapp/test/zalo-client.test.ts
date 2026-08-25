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
  let navigated = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { open: () => { navigated = true; } },
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
  await client.openPhone('0900000001');
  await client.openDirections({ lat: 21.0333, lng: 105.85 });
  assert.equal(navigated, false);

  client.setStorage('zalo-client-test', 'mock-value');
  assert.equal(client.getStorage('zalo-client-test'), 'mock-value');
  client.removeStorage('zalo-client-test');
  assert.equal(client.getStorage('zalo-client-test'), null);
});

test('real client calls native openPhone with the trimmed phone number', async () => {
  const calls: string[] = [];
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(async () => ({
    openPhone: async ({ phoneNumber }) => { calls.push(phoneNumber); },
    openWebview: async () => undefined,
  }));

  await client.openPhone('  +84900000001  ');

  assert.deepEqual(calls, ['+84900000001']);
});

test('real client opens encoded Google Maps directions in the configured webview', async () => {
  const calls: Array<{ url: string; config: { style: string; leftButton: string } }> = [];
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(async () => ({
    openPhone: async () => undefined,
    openWebview: async (args) => { calls.push(args); },
  }));

  await client.openDirections({ lat: 21.0333, lng: 105.85 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  assert.match(decodeURIComponent(calls[0].url), /21\.0333,105\.85/);
  assert.deepEqual(calls[0].config, { style: 'normal', leftButton: 'back' });
});

test('real client rejects empty phone and invalid coordinates before native calls', async () => {
  let nativeCalls = 0;
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(async () => ({
    openPhone: async () => { nativeCalls += 1; },
    openWebview: async () => { nativeCalls += 1; },
  }));

  await assert.rejects(() => client.openPhone('  '), /Số điện thoại/);
  await assert.rejects(() => client.openDirections({ lat: Number.NaN, lng: 105.85 }), /Tọa độ/);
  assert.equal(nativeCalls, 0);
});

test('real client exchanges the SDK access and location tokens exactly once', async () => {
  let accessTokenCalls = 0;
  let locationTokenCalls = 0;
  const exchanged: string[] = [];
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    async () => ({
      getAccessToken: async () => {
        accessTokenCalls += 1;
        return 'access-token-test';
      },
      getLocation: async () => {
        locationTokenCalls += 1;
        return { token: 'location-token-test' };
      },
    }),
    async (accessToken, locationToken) => {
      exchanged.push(accessToken, locationToken);
      return { lat: 21.0333, lng: 105.85 };
    },
  );

  assert.deepEqual(await client.getLocation(null), { lat: 21.0333, lng: 105.85 });
  assert.equal(accessTokenCalls, 1);
  assert.equal(locationTokenCalls, 1);
  assert.deepEqual(exchanged, ['access-token-test', 'location-token-test']);
});

test('real client rejects an empty SDK location token without browser geolocation', async () => {
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    async () => ({ getAccessToken: async () => 'access-token-test', getLocation: async () => ({ token: '' }) }),
    async () => ({ lat: 21.0333, lng: 105.85 }),
  );

  await assert.rejects(() => client.getLocation({ lat: 21.0333, lng: 105.85 }), /token vị trí Zalo/);
});
