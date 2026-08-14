import { ApiError, createApiClient } from '@eco-oil/api-client';
import type {
  AdminAlert,
  AdminCollectorPerformance,
  AdminCollectorSummary,
  AdminMerchantSummary,
  AdminOverviewResponse,
  AdminReconciliationResponse,
  AdminStationSummary,
  AdminContainerSummary,
  AdminContainerReturnRequest,
  AdminWardSummary,
  AuthUser,
  OilPriceRecord,
  PagedResponse,
  PaymentListResponse,
  PaymentRecord,
  PaymentRunResponse,
} from '@eco-oil/shared-types';
import { browserTokenStorage } from './storage';

export { ApiError };

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

const client = createApiClient({
  baseUrl: API_BASE_URL,
  storage: browserTokenStorage,
});

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  const result = search.toString();
  return result ? `?${result}` : '';
};

export const api = {
  loginSeed: (zaloId: string, phone: string) =>
    client.request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/zalo', {
      method: 'POST',
      body: { zalo_id: zaloId, phone },
      retry: false,
    }),
  adminLogin: (zaloId: string, phone: string, password: string) =>
    client.request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/admin/login', { method: 'POST', body: { zalo_id: zaloId, phone, password }, retry: false }),
  me: () => client.request<AuthUser>('/auth/me'),
  logout: (refreshToken: string) => client.request('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } }),
  overview: (from?: string, to?: string) => client.request<AdminOverviewResponse>(`/admin/overview${query({ from, to })}`),
  reconciliation: (date: string) => client.request<AdminReconciliationResponse>(`/admin/reconciliation?date=${date}`),
  alerts: (params: { type?: string; resolved?: boolean; page?: number; limit?: number }) =>
    client.request<PagedResponse<AdminAlert>>(`/admin/alerts${query(params)}`),
  resolveAlert: (id: string) => client.request<AdminAlert>(`/admin/alerts/${id}/resolve`, { method: 'PATCH' }),
  stations: () => client.request<PagedResponse<AdminStationSummary>>('/admin/stations?page=1&limit=100'),
  merchants: (params: { search?: string; anomaly?: boolean; status?: string }) =>
    client.request<PagedResponse<AdminMerchantSummary>>(`/admin/merchants${query({ page: 1, limit: 100, ...params })}`),
  collectors: () => client.request<PagedResponse<AdminCollectorSummary>>('/admin/collectors?page=1&limit=100'),
  collectorPerformance: (id: string) => client.request<AdminCollectorPerformance>(`/admin/collectors/${id}/performance`),
  approveMerchant: (id: string, body: { lat: number; lng: number }) => client.request(`/admin/merchants/${id}/approve`, { method: 'POST', body }),
  rejectMerchant: (id: string, reason: string) => client.request(`/admin/merchants/${id}/reject`, { method: 'POST', body: { reason } }),
  createCollector: (body: { name: string; phone: string; zalo_id: string; vehicle_type: string; max_capacity_l: number; ward_ids: string[] }) => client.request('/admin/collectors', { method: 'POST', body }),
  updateCollector: (id: string, body: Record<string, unknown>) => client.request(`/admin/collectors/${id}`, { method: 'PATCH', body }),
  containers: (params: { state?: string; merchant_id?: string; unassigned?: boolean } = {}) => client.request<PagedResponse<AdminContainerSummary>>(`/admin/containers${query({ page: 1, limit: 100, ...params })}`),
  wards: (includeInactive = false) => client.request<AdminWardSummary[]>(`/admin/wards?include_inactive=${includeInactive}`),
  createWard: (body: { code: string; name: string; district: string; city: string; center_lat?: number; center_lng?: number }) => client.request<AdminWardSummary>('/admin/wards', { method: 'POST', body }),
  updateWard: (id: string, body: Record<string, unknown>) => client.request<AdminWardSummary>(`/admin/wards/${id}`, { method: 'PATCH', body }),
  createContainer: (body: { ward_id?: string; ward_code?: string; capacity_liters: number; qr_code?: string }) => client.request<AdminContainerSummary>('/admin/containers', { method: 'POST', body }),
  assignContainer: (id: string, merchant_id: string) => client.request<AdminContainerSummary>(`/admin/containers/${id}/assign`, { method: 'POST', body: { merchant_id } }),
  unassignContainer: (id: string) => client.request<AdminContainerSummary>(`/admin/containers/${id}/unassign`, { method: 'POST' }),
  returnContainerToMerchant: (id: string, body: AdminContainerReturnRequest) => client.request<AdminContainerSummary>(`/admin/containers/${id}/return-to-merchant`, { method: 'POST', body }),
  cancelContainerTransit: (id: string, body: { note?: string }) => client.request<AdminContainerSummary & { affected_transaction_ids: string[] }>(`/admin/containers/${id}/cancel-transit`, { method: 'POST', body }),
  payments: (params: { period?: string; merchant_id?: string; status?: string; page?: number; limit?: number }) =>
    client.request<PaymentListResponse>(`/admin/payments${query(params)}`),
  runPayments: (period: string) => client.request<PaymentRunResponse>(`/admin/payments/run?period=${encodeURIComponent(period)}`, { method: 'POST' }),
  markPaymentPaid: (id: string) => client.request<PaymentRecord>(`/admin/payments/${id}/mark-paid`, { method: 'POST' }),
  oilPrices: () => client.request<OilPriceRecord[]>('/admin/oil-prices'),
  createOilPrice: (body: { unit_price: number; effective_from?: string; note?: string }) =>
    client.request<OilPriceRecord>('/admin/oil-prices', { method: 'POST', body }),
};
