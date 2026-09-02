import assert from 'node:assert/strict';
import test from 'node:test';
import { clearZaloOAuthCode, consumeZaloOAuthCode, readZaloOAuthCode } from '../src/lib/oauth-callback';

function browserUrl(value: string): { href: string } {
  return { href: `https://uco-platform-miniapp.vercel.app${value}` };
}

test('frontend callback consumes the opaque code and removes it with replaceState', async () => {
  const location = browserUrl('/?return=home&zalo_code=one-time-code');
  const replaced: string[] = [];
  const session = await consumeZaloOAuthCode(
    async (code) => {
      assert.equal(code, 'one-time-code');
      return { user: 'current-user' };
    },
    location,
    { replaceState: (_state, _title, next) => replaced.push(String(next)) },
  );

  assert.deepEqual(session, { user: 'current-user' });
  assert.deepEqual(replaced, ['/?return=home']);
  assert.equal(readZaloOAuthCode(browserUrl('/?return=home')), null);
});

test('failed callback clears the consumed code so a fresh login can retry', async () => {
  const location = browserUrl('/?zalo_code=expired-code');
  const replaced: string[] = [];

  await assert.rejects(
    consumeZaloOAuthCode(async () => { throw new Error('expired'); }, location, { replaceState: (_state, _title, next) => replaced.push(String(next)) }),
    /expired/,
  );
  assert.deepEqual(replaced, ['/']);

  const retryLocation = browserUrl('/?zalo_code=fresh-code');
  let called = false;
  await assert.doesNotReject(consumeZaloOAuthCode(async (code) => {
    called = code === 'fresh-code';
    return true;
  }, retryLocation, { replaceState: () => undefined }));
  assert.equal(called, true);
});

test('temporary network failure preserves the OAuth code for a safe retry', async () => {
  const location = browserUrl('/?return=home&zalo_code=retryable-code');
  const replaced: string[] = [];

  await assert.rejects(
    consumeZaloOAuthCode(
      async () => { throw new TypeError('fetch failed'); },
      location,
      { replaceState: (_state, _title, next) => replaced.push(String(next)) },
    ),
    /fetch failed/,
  );

  assert.deepEqual(replaced, []);
  assert.equal(readZaloOAuthCode(location), 'retryable-code');
});

test('callback exchange works without relying on a third-party cookie', async () => {
  const location = browserUrl('/?zalo_code=cookie-independent-code');
  const session = await consumeZaloOAuthCode(async (code) => {
    assert.equal(code, 'cookie-independent-code');
    return { access_token: 'frontend-only-session-token' };
  }, location, { replaceState: () => undefined });

  assert.deepEqual(session, { access_token: 'frontend-only-session-token' });
});

test('cleanup is a no-op without a callback code and never handles access tokens in the URL', () => {
  const location = browserUrl('/?legacy_token=must-not-be-used');
  const replaced: string[] = [];
  clearZaloOAuthCode(location, { replaceState: (_state, _title, next) => replaced.push(String(next)) });
  assert.deepEqual(replaced, []);
  assert.equal(readZaloOAuthCode(location), null);
});
