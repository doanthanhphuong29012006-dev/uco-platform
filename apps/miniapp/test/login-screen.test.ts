import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@eco-oil/shared-types';
import type { DevAccount } from '@eco-oil/shared-types';
import { getSeedLoginCredentials, shouldShowDevelopmentLogin } from '../src/components/login-screen-logic';

test('backend mock accounts are usable even when the Zalo SDK client is real', () => {
  const account: DevAccount = {
    zalo_id: 'zalo_collector_03',
    name: 'Lê Văn Thu Gom 3',
    role: Role.COLLECTOR,
    phone: '0910000003',
    wards: [{ id: 'ward-hb', code: 'HB-HK', name: 'Phường Hàng Bạc' }],
  };

  assert.equal(shouldShowDevelopmentLogin(true, false), true);
  assert.deepEqual(getSeedLoginCredentials([account], 'zalo_collector_03'), {
    zaloId: 'zalo_collector_03',
    phone: '0910000003',
  });
});

test('selecting a collector preserves the seed login identity and phone', () => {
  const account: DevAccount = {
    zalo_id: 'zalo_collector_03',
    name: 'Lê Văn Thu Gom 3',
    role: Role.COLLECTOR,
    phone: '0910000003',
    wards: [],
  };

  assert.deepEqual(getSeedLoginCredentials([account], account.zalo_id), {
    zaloId: 'zalo_collector_03',
    phone: '0910000003',
  });
});

test('a real backend represented by 404 has no seed account selected', () => {
  const accounts: DevAccount[] = [];
  assert.equal(shouldShowDevelopmentLogin(false, false), false);
  assert.equal(getSeedLoginCredentials(accounts, ''), null);
});
