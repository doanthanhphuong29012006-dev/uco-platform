import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCollectorInvite, clearStoredCollectorInvite, getStoredCollectorInvite } from '../src/lib/collector-invite';

function sessionStorageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as unknown as Storage;
}

test('captures collector invite, removes it from URL, and preserves it for OAuth retry', () => {
  const session = sessionStorageMock();
  const replaced: string[] = [];
  const location = { href: 'https://miniapp.example.test/?collector_invite=invite-code-fixture&utm=campaign' };
  const history = { replaceState: (_state: unknown, _title: string, next: string) => replaced.push(next) };

  assert.equal(captureCollectorInvite(location, history, session), 'invite-code-fixture');
  assert.equal(getStoredCollectorInvite(session), 'invite-code-fixture');
  assert.deepEqual(replaced, ['/?utm=campaign']);
  clearStoredCollectorInvite(session);
  assert.equal(getStoredCollectorInvite(session), null);
});
