import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { createElement, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  merchants: vi.fn(),
  wards: vi.fn(),
  containers: vi.fn(),
  updateMerchant: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock('./admin-shell', () => ({ AdminShell: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));

import { MerchantsView } from './merchants-view';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('Admin edits merchant name and phone and refetches the merchant list', async () => {
  apiMock.merchants.mockResolvedValue({
    data: [{
      id: 'merchant-1', ward_id: 'ward-1', name: 'Quán cũ', phone: '0900000001', address: 'Địa chỉ cũ',
      business_type: 'Nhà hàng', lat: 10.77, lng: 106.7, distance_m: null, status: 'ACTIVE',
      approval_status: 'APPROVED', rejection_reason: null, ward_code: 'W01', ward_name: 'Phường 1',
      avg_daily_liters: 10, last_collected_at: null, anomaly: false,
    }],
    meta: { page: 1, limit: 100, total: 1 },
  });
  apiMock.wards.mockResolvedValue([{ id: 'ward-1', code: 'W01', name: 'Phường 1' }]);
  apiMock.containers.mockResolvedValue({ data: [], meta: { page: 1, limit: 100, total: 0 } });
  apiMock.updateMerchant.mockResolvedValue({ id: 'merchant-1' });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  render(<QueryClientProvider client={queryClient}><MerchantsView /></QueryClientProvider>);
  await screen.findByText('Quán cũ');
  fireEvent.click(screen.getByRole('button', { name: 'Sửa' }));
  fireEvent.change(screen.getByLabelText('Tên quán'), { target: { value: 'Quán mới' } });
  fireEvent.change(screen.getByLabelText('Số điện thoại'), { target: { value: '84 901 234 567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));

  await waitFor(() => expect(apiMock.updateMerchant).toHaveBeenCalledWith('merchant-1', expect.objectContaining({
    name: 'Quán mới',
    phone: '+84901234567',
  })));
  await screen.findByText('Đã cập nhật quán Quán mới.');
  expect(apiMock.merchants.mock.calls.length).toBeGreaterThan(1);
});
