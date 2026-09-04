import React, { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => ({ merchants: vi.fn(), containers: vi.fn(), wards: vi.fn(), createWard: vi.fn(), approveMerchant: vi.fn(), rejectMerchant: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mock, ApiError: class ApiError extends Error {} }));
vi.mock('./admin-shell', () => ({ AdminShell: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
import { ApprovalsView } from './approvals-view';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('Admin creates a ward, automatically selects it and atomically submits assignment with approval', async () => {
  const ward = { id: 'ward-new', code: 'INTERNAL-TEST', name: 'Phường mới', district: 'Địa bàn', city: 'Hà Nội' };
  let created = false;
  mock.merchants.mockResolvedValue({ data: [{ id: 'merchant', name: 'Quán GPS', phone: '+84901234567', address: 'Địa chỉ', lat: 21.03, lng: 105.85, ward_id: null }], meta: { total: 1 } });
  mock.containers.mockResolvedValue({ data: [] });
  mock.wards.mockImplementation(async () => created ? [ward] : []);
  mock.createWard.mockImplementation(async () => { created = true; return ward; });
  mock.approveMerchant.mockResolvedValue({ id: 'merchant' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ApprovalsView /></QueryClientProvider>);
  await screen.findByText('Quán GPS');
  fireEvent.click(screen.getByRole('button', { name: 'Duyệt hồ sơ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }));
  expect(mock.approveMerchant).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Thêm phường' }));
  fireEvent.change(screen.getByLabelText('Mã phường nội bộ'), { target: { value: ward.code } });
  fireEvent.change(screen.getByLabelText('Tên phường'), { target: { value: ward.name } });
  fireEvent.change(screen.getByLabelText('Quận / huyện (theo danh mục vận hành)'), { target: { value: ward.district } });
  fireEvent.change(screen.getByLabelText('Tỉnh / thành phố'), { target: { value: ward.city } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu phường mới' }));
  await waitFor(() => expect((screen.getByLabelText('Phường') as HTMLSelectElement).value).toBe('ward-new'));
  fireEvent.click(screen.getByLabelText('Tôi đã kiểm tra tọa độ và phường của quán'));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }));
  await waitFor(() => expect(mock.approveMerchant).toHaveBeenCalledWith('merchant', { lat: 21.03, lng: 105.85, ward_id: 'ward-new' }));
  expect(mock.createWard).toHaveBeenCalledTimes(1);
  client.clear();
});
