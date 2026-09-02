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

test('browser production uses BrowserZaloClient and returns real browser geolocation', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  setBrowserGeolocation((success) => success({ coords: { latitude: 21.0333, longitude: 105.85 } }));
  const { createZaloClient, isZaloEnvironment } = await import('../src/lib/zalo-client');
  assert.equal(isZaloEnvironment(), false);

  const client = createZaloClient(false);
  assert.equal(client.mode, 'browser');
  assert.deepEqual(await client.getLocation({ lat: 10, lng: 106 }), { lat: 21.0333, lng: 105.85 });
});

test('browser-like Zalo globals do not activate the native runtime', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      zmp: {},
      zmpSdk: {},
      ZaloMiniApp: {},
      ZaloMiniAppSDK: {},
      ZaloJavaScriptInterface: {},
    },
  });
  const { isZaloEnvironment } = await import('../src/lib/zalo-client');
  assert.equal(isZaloEnvironment(), false);
});

test('browser location reports permission denial instead of disguising a ward center as GPS', async () => {
  setBrowserGeolocation((_success, failure) =>
    failure({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 }),
  );
  const { createZaloClient } = await import('../src/lib/zalo-client');
  const client = createZaloClient(false);
  await assert.rejects(
    () => client.getLocation({ lat: 21.0333, lng: 105.85 }),
    /Quyền vị trí đã bị từ chối/,
  );
});

test('browser client opens tel and Google Maps and delegates QR/camera/gallery capabilities', async () => {
  const opened: string[] = [];
  const browserWindow = {
    location: { href: 'https://example.test' },
    open: (url?: string | URL) => {
      opened.push(String(url));
      return {} as Window;
    },
  };
  const picked: string[] = [];
  const { BrowserZaloClient } = await import('../src/lib/zalo-client');
  const client = new BrowserZaloClient(
    async () => ({ lat: 21.0333, lng: 105.85 }),
    async () => '{"container_code":"ECO-QR-BROWSER"}',
    async (source) => {
      picked.push(source);
      return { url: `data:${source}`, width: 10, height: 10 };
    },
    browserWindow as never,
    null,
  );

  await client.openPhone('0901 000 001');
  assert.equal(browserWindow.location.href, 'tel:0901000001');
  await client.openDirections({ lat: 21.0333, lng: 105.85 });
  assert.match(opened[0], /^https:\/\/www\.google\.com\/maps\/dir/);
  assert.equal(await client.scanQRCode(), 'ECO-QR-BROWSER');
  await client.chooseImage('camera');
  await client.chooseImage('album');
  assert.deepEqual(picked, ['camera', 'album']);
});

test('documented ZMP capabilities identify a real Zalo runtime without private globals', async () => {
  const { isZaloEnvironment } = await import('../src/lib/zalo-client');
  const runtime = {
    navigator: { userAgent: 'Mozilla/5.0' },
    ZaloMiniAppSDK: { getLocation() {}, scanQRCode() {}, openPhone() {} },
  };
  assert.equal(isZaloEnvironment(runtime as never), true);
});

test('browser GPS maps timeout separately from permission denial', async () => {
  setBrowserGeolocation((_success, failure) => failure({ code: 3, PERMISSION_DENIED: 1, TIMEOUT: 3 }));
  const { browserLocation } = await import('../src/lib/zalo-client');
  await assert.rejects(() => browserLocation(10), /không phản hồi trong thời gian/);
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

test('temporary focus loss does not falsely cancel a native image picker', async () => {
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

  const pending = client.chooseImage('camera');
  await wait(0);
  documentHub.visibilityState = 'hidden';
  documentHub.emit('visibilitychange');
  documentHub.visibilityState = 'visible';
  documentHub.emit('visibilitychange');

  callback?.({ filePaths: ['zalo://after-focus.jpg'] });
  assert.deepEqual(await pending, { url: 'zalo://after-focus.jpg', width: 10, height: 10 });
  assert.equal(documentHub.listenerCount() + windowHub.listenerCount(), 0);
});

test('late native success after returning from picker is accepted', async () => {
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

test('native picker timeout releases the client so it can be opened again', async () => {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  let calls = 0;
  const { RealZaloClient } = await import('../src/lib/zalo-client');
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
    10,
  );

  const first = client.chooseImage('camera');
  await assert.rejects(first, /không phản hồi/);

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

test('browser QR scanner returns an actionable unsupported-camera error', async () => {
  const { BrowserQrScannerError, scanBrowserQrCode } = await import('../src/lib/browser-qr-scanner');
  await assert.rejects(
    scanBrowserQrCode({ document: null, mediaDevices: null }),
    (error: unknown) => error instanceof BrowserQrScannerError
      && error.code === 'CAMERA_UNSUPPORTED'
      && /chọn ảnh QR|nhập mã/i.test(error.message),
  );
});

test('mock device client is enabled only by an explicit mode', async () => {
  const { createZaloClient } = await import('../src/lib/zalo-client');
  assert.equal(createZaloClient('mock').mode, 'mock');
  assert.equal(createZaloClient(false).mode, 'browser');
});
