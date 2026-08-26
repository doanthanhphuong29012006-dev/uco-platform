import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@eco-oil/shared-types';
import type { DevAccount } from '@eco-oil/shared-types';
import { getSeedLoginCredentials, isValidAuthUser, shouldShowDevelopmentLogin } from '../src/components/login-screen-logic';

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

test('demo merchant selections preserve their distinct Zalo identities', () => {
  const accounts: DevAccount[] = [
    { id: 'merchant-04', zalo_id: 'zalo_demo_merchant_04', phone: '0901000004', name: 'Bún Chả Hàng Bạc', role: Role.MERCHANT, wards: [] },
    { id: 'merchant-05', zalo_id: 'zalo_demo_merchant_05', phone: '0901000005', name: 'Cơm Nhà Hồ Gươm', role: Role.MERCHANT, wards: [] },
  ];
  assert.deepEqual(getSeedLoginCredentials(accounts, 'zalo_demo_merchant_04'), { zaloId: 'zalo_demo_merchant_04', phone: '0901000004' });
  assert.deepEqual(getSeedLoginCredentials(accounts, 'zalo_demo_merchant_05'), { zaloId: 'zalo_demo_merchant_05', phone: '0901000005' });
});

test('missing profile identity is rejected instead of falling back to another merchant', () => {
  const base = { id: 'user-1', zalo_id: 'zalo_demo_merchant_05', phone: '0901000005', name: 'Cơm Nhà Hồ Gươm', role: Role.MERCHANT, merchantId: 'merchant-05', collectorId: null, merchantApprovalStatus: 'APPROVED', merchantRejectionReason: null };
  assert.equal(isValidAuthUser(base), true);
  assert.equal(isValidAuthUser({ ...base, merchantId: null }), false);
  assert.equal(isValidAuthUser(null), false);
});
