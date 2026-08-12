import { render, screen } from '@testing-library/react';
import { Role, type AuthUser } from '@eco-oil/shared-types';
import { createElement } from 'react';
import { expect, test } from 'vitest';
import { KpiCards } from './components/kpi-cards';
import { calculateVariancePct, isAdminUser } from './lib/dashboard-utils';

const user = (role: Role): AuthUser => ({
  id: 'user-1', zalo_id: 'zalo-test', phone: '0900000000', name: 'Test', role, merchantId: null, collectorId: null, merchantApprovalStatus: null, merchantRejectionReason: null,
});

test('guard từ chối tài khoản không phải ADMIN', () => {
  expect(isAdminUser(user(Role.MERCHANT))).toBe(false);
  expect(isAdminUser(user(Role.COLLECTOR))).toBe(false);
  expect(isAdminUser(user(Role.ADMIN))).toBe(true);
});

test('render đúng các số liệu KPI', () => {
  render(createElement(KpiCards, { values: { liters: 18.5, transactions: 3, merchants: 2, alerts: 1 } }));
  expect(screen.getByText('18,5 lít')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
});

test('tính chênh lệch đối soát theo số lít thu gom', () => {
  expect(calculateVariancePct(100, 98)).toBeCloseTo(0.02);
  expect(calculateVariancePct(0, 0)).toBe(0);
  expect(calculateVariancePct(25, 30)).toBeCloseTo(-0.2);
});
