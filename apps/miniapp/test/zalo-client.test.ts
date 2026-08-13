import assert from 'node:assert/strict';
import test from 'node:test';

test('browser outside Zalo uses the mock client for the full SDK surface', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  const { createZaloClient, isZaloEnvironment } = await import('../src/lib/zalo-client');
  assert.equal(isZaloEnvironment(), false);

  const client = createZaloClient(false);
  assert.equal(client.mode, 'mock');

  client.setSeedAccount({ zaloId: 'zalo_collector_01', phone: '0910000001' });
  assert.deepEqual(await client.login(), { zaloId: 'zalo_collector_01', phone: '0910000001' });
  assert.equal(await client.getAccessToken(), 'mock-access-token:zalo_collector_01');
  assert.deepEqual(await client.getLocation(), { lat: 10.7769, lng: 106.7009 });
  assert.equal(await client.scanQRCode(), '');
  await assert.rejects(() => client.chooseImage(), /Camera is unavailable in mock mode/);

  client.setStorage('zalo-client-test', 'mock-value');
  assert.equal(client.getStorage('zalo-client-test'), 'mock-value');
  client.removeStorage('zalo-client-test');
  assert.equal(client.getStorage('zalo-client-test'), null);
});
