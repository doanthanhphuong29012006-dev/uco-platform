import assert from 'node:assert/strict';
import test from 'node:test';

class EventHub {
  visibilityState = 'visible';
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const current = this.listeners.get(type) ?? new Set<() => void>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  await assert.rejects(() => client.chooseImage(), /media picker is unavailable in mock mode/);
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

test('real client normalizes raw, JSON and URL container QR payloads', async () => {
  const payloads = [
    '  ECO-UCO-Q3P7-001  ',
    '{"container_code":"ECO-UCO-Q3P7-002"}',
    'https://eco-oil.example/containers/ECO-UCO-Q3P7-003',
  ];
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: payloads.shift() ?? '' }),
      chooseImage: async () => ({ filePaths: [] }),
    }),
  );

  assert.equal(await client.scanQRCode(), 'ECO-UCO-Q3P7-001');
  assert.equal(await client.scanQRCode(), 'ECO-UCO-Q3P7-002');
  assert.equal(await client.scanQRCode(), 'ECO-UCO-Q3P7-003');
});

test('real client uses distinct native camera and album sources before compressing', async () => {
  const calls: Array<{
    count: number;
    sourceType: Array<'camera' | 'album'>;
    cameraType?: 'back' | 'front';
    success?: (result: { filePaths: string[] }) => void;
    fail?: (error: { code: number; message?: string }) => void;
  }> = [];
  const compressedPaths: string[] = [];
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async (args) => {
        calls.push(args);
        return { filePaths: [`zalo://${args.sourceType[0]}.jpg`] };
      },
    }),
    async (filePath) => {
      compressedPaths.push(filePath);
      return { url: `data:${filePath}`, width: 1280, height: 720 };
    },
  );

  await client.chooseImage('camera');
  await client.chooseImage('album');

  assert.deepEqual(calls.map(({ success: _success, fail: _fail, ...args }) => args), [
    { count: 1, sourceType: ['camera'], cameraType: 'back' },
    { count: 1, sourceType: ['album'] },
  ]);
  assert.deepEqual(compressedPaths, ['zalo://camera.jpg', 'zalo://album.jpg']);
});

test('real client settles from the official chooseImage success callback', async () => {
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async ({ success }) => {
        success?.({ filePaths: ['zalo://callback.jpg'] });
        return new Promise(() => undefined);
      },
    }),
    async (filePath) => ({ url: filePath, width: 10, height: 10 }),
  );

  assert.deepEqual(await client.chooseImage('camera'), { url: 'zalo://callback.jpg', width: 10, height: 10 });
});

test('real client settles immediately from the official chooseImage fail callback', async () => {
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async ({ fail }) => {
        fail?.({ code: -2003, message: 'User cancel' });
        return new Promise(() => undefined);
      },
    }),
  );

  await assert.rejects(() => client.chooseImage('album'), { code: -2003 });
});

test('empty filePaths from the official success callback is treated as cancel', async () => {
  const { RealZaloClient, MediaPickerCancelledError } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async ({ success }) => {
        success?.({ filePaths: [] });
        return new Promise(() => undefined);
      },
    }),
  );

  await assert.rejects(() => client.chooseImage('album'), MediaPickerCancelledError);
});

test('returning from a hidden picker settles an unresolved SDK promise as cancel', async () => {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  const { RealZaloClient, MediaPickerCancelledError } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async () => new Promise(() => undefined),
    }),
    undefined,
    () => ({ document: documentHub, window: windowHub }),
  );

  const pending = client.chooseImage('camera');
  await wait(0);
  documentHub.visibilityState = 'hidden';
  documentHub.emit('visibilitychange');
  documentHub.visibilityState = 'visible';
  documentHub.emit('visibilitychange');

  await assert.rejects(pending, MediaPickerCancelledError);
  assert.equal(documentHub.listenerCount() + windowHub.listenerCount(), 0);
});

test('success during the return grace period wins over lifecycle cancel', async () => {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  let callback: ((result: { filePaths: string[] }) => void) | undefined;
  const { RealZaloClient } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async ({ success }) => {
        callback = success;
        return new Promise(() => undefined);
      },
    }),
    async (filePath) => ({ url: filePath, width: 10, height: 10 }),
    () => ({ document: documentHub, window: windowHub }),
  );

  const pending = client.chooseImage('album');
  await wait(0);
  documentHub.visibilityState = 'hidden';
  documentHub.emit('visibilitychange');
  documentHub.visibilityState = 'visible';
  documentHub.emit('visibilitychange');
  setTimeout(() => callback?.({ filePaths: ['zalo://late-success.jpg'] }), 100);

  assert.deepEqual(await pending, { url: 'zalo://late-success.jpg', width: 10, height: 10 });
  assert.equal(documentHub.listenerCount() + windowHub.listenerCount(), 0);
});

test('a lifecycle cancel releases the client so the picker can be opened again', async () => {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  let calls = 0;
  const { RealZaloClient, MediaPickerCancelledError } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async ({ success }) => {
        calls += 1;
        if (calls === 2) success?.({ filePaths: ['zalo://second.jpg'] });
        return new Promise(() => undefined);
      },
    }),
    async (filePath) => ({ url: filePath, width: 10, height: 10 }),
    () => ({ document: documentHub, window: windowHub }),
  );

  const first = client.chooseImage('camera');
  await wait(0);
  documentHub.visibilityState = 'hidden';
  documentHub.emit('visibilitychange');
  documentHub.visibilityState = 'visible';
  documentHub.emit('visibilitychange');
  await assert.rejects(first, MediaPickerCancelledError);

  assert.deepEqual(await client.chooseImage('camera'), { url: 'zalo://second.jpg', width: 10, height: 10 });
  assert.equal(calls, 2);
});

test('explicit cleanup cancels the pending picker and removes lifecycle listeners', async () => {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  const { RealZaloClient, MediaPickerCancelledError } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async () => new Promise(() => undefined),
    }),
    undefined,
    () => ({ document: documentHub, window: windowHub }),
  );

  const pending = client.chooseImage('camera');
  await wait(0);
  client.cancelMediaPicker();

  await assert.rejects(pending, MediaPickerCancelledError);
  assert.equal(documentHub.listenerCount() + windowHub.listenerCount(), 0);
});

test('cancelled camera/library results release the picker outcome without adding an empty photo', async () => {
  const { pickZaloPhoto } = await import('../src/lib/media-picker');
  const photo = { url: 'data:image/jpeg;base64,photo', width: 10, height: 10 };

  assert.deepEqual(await pickZaloPhoto('camera', async () => photo), { kind: 'selected', photo });
  assert.deepEqual(await pickZaloPhoto('album', async () => photo), { kind: 'selected', photo });
  assert.deepEqual(await pickZaloPhoto('camera', async () => ({ url: '', width: 0, height: 0 })), { kind: 'cancelled' });
  assert.deepEqual(await pickZaloPhoto('album', async () => { throw { code: -2003 }; }), { kind: 'cancelled' });
  assert.deepEqual(await pickZaloPhoto('album', async () => { throw { code: -201 }; }), { kind: 'permission-denied' });
});

test('after an empty camera result, the native picker can be opened again', async () => {
  const paths = [[], ['zalo://camera-again.jpg']];
  const { RealZaloClient, MediaPickerCancelledError } = await import('../src/lib/zalo-client');
  const client = new RealZaloClient(
    undefined,
    undefined,
    undefined,
    async () => ({
      scanQRCode: async () => ({ content: '' }),
      chooseImage: async () => ({ filePaths: paths.shift() ?? [] }),
    }),
    async (filePath) => ({ url: filePath, width: 10, height: 10 }),
  );

  await assert.rejects(() => client.chooseImage('camera'), MediaPickerCancelledError);
  assert.deepEqual(await client.chooseImage('camera'), { url: 'zalo://camera-again.jpg', width: 10, height: 10 });
});

test('native cancel codes are distinct from permission denial', async () => {
  const { isMediaPickerCancelled, isZaloPermissionDenied } = await import('../src/lib/zalo-client');

  assert.equal(isMediaPickerCancelled({ code: -2003, message: 'User cancel' }), true);
  assert.equal(isMediaPickerCancelled({ code: -606, message: 'User cancel' }), true);
  assert.equal(isMediaPickerCancelled({ code: -101 }), true);
  assert.equal(isMediaPickerCancelled({ code: -201 }), false);
  assert.equal(isZaloPermissionDenied({ code: -201 }), true);
});

test('permission helper recognizes only Zalo denial code -201', async () => {
  const { isZaloPermissionDenied } = await import('../src/lib/zalo-client');

  assert.equal(isZaloPermissionDenied({ code: -201 }), true);
  assert.equal(isZaloPermissionDenied({ code: '-201' }), true);
  assert.equal(isZaloPermissionDenied({ code: -1401 }), false);
  assert.equal(isZaloPermissionDenied(new Error('camera failed')), false);
});
